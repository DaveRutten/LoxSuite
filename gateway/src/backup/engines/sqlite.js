// SQLite backup engine — today's createBackup()/stageRestore() DB-payload handling, lifted out of
// backup.js verbatim (see the project's own db-backend plan, Phase 4c) so that file's shared
// scaffolding (zip assembly, manifest, mosquitto config bundling, retention, scheduler, rclone)
// stays backend-agnostic and only dispatches to this module (or engines/postgres.js) for the
// "produce the payload" / "validate + stage" halves that genuinely differ per backend.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const db = require('../../db');

const ENTRY_FILENAME = 'gateway.db';

// Online backup via better-sqlite3's own .backup() (safe under WAL, unlike copying the file's
// bytes directly while it's open) — the one thing that needs the real driver object rather than a
// SQL string, so it goes through the facade's withRawConnection escape hatch (same pooled
// connection prepare()/transaction() use, acquired then released back, never a second independent
// one) instead of a db.backup() method the facade doesn't have.
async function addPayloadToZip(zip, tmpDir) {
  const tmpDbPath = path.join(tmpDir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  await db.withRawConnection((conn) => conn.backup(tmpDbPath));
  zip.addLocalFile(tmpDbPath, '', ENTRY_FILENAME);
  fs.rmSync(tmpDbPath, { force: true });
}

// Validates the uploaded gateway.db (SQLite's own quick_check pragma) and stages it at
// pendingRestorePath for db/index.js's own initSqlite() to pick up on the next boot — it can't be
// hot-swapped out from under this process's already-open connection (see db/index.js's own
// comment on the exact same restart-to-apply reasoning).
async function validateAndStage(zip, pendingRestorePath) {
  const dbEntry = zip.getEntry(ENTRY_FILENAME);
  if (!dbEntry) throw new Error(`Backup does not contain ${ENTRY_FILENAME}.`);

  const checkPath = `${pendingRestorePath}.check-${Date.now()}`;
  fs.writeFileSync(checkPath, zip.readFile(dbEntry));
  try {
    const check = new Database(checkPath, { readonly: true, fileMustExist: true });
    const result = check.pragma('quick_check', { simple: true });
    check.close();
    if (result !== 'ok') throw new Error(`Database failed integrity check: ${result}`);
  } catch (err) {
    fs.rmSync(checkPath, { force: true });
    throw new Error(`Uploaded gateway.db is not valid: ${err.message}`);
  } finally {
    // Opening even a read-only connection can leave WAL-mode sidecar files behind (the backed-up
    // file still carries its original journal_mode header) — these aren't part of checkPath itself
    // so the rename below wouldn't carry them along, and they'd otherwise litter BACKUP_DIR.
    fs.rmSync(`${checkPath}-shm`, { force: true });
    fs.rmSync(`${checkPath}-wal`, { force: true });
  }

  fs.renameSync(checkPath, pendingRestorePath);
}

module.exports = { backend: 'sqlite', entryFilename: ENTRY_FILENAME, addPayloadToZip, validateAndStage };
