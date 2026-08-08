// Postgres backup engine — shells out to pg_dump/pg_restore (same "delegate to the correct
// external tool" philosophy already used for rclone/apprise's own CLIs — see the Dockerfile) rather
// than a JS-native reimplementation. Deliberately never touches the app's own Knex pool: every
// function here builds its own connection args straight from db/config.js's resolveDbConfig() (same
// pattern db/transfer.js's CLI already uses), so this module has no dependency on db/index.js at
// all — which matters because db/index.js's own initPostgres() calls this file's
// applyPendingRestoreAtBoot() below; requiring the app's db facade FROM here would be a require
// cycle.
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { resolveDbConfig } = require('../../db/config');

const ENTRY_FILENAME = 'gateway.pgdump';

function connectionArgs(config) {
  const c = config.connection;
  return {
    args: ['--host', c.host, '--port', String(c.port), '--username', c.user, '--dbname', c.database, '--no-password'],
    // --no-password above just means "never prompt interactively" — the actual credential still
    // goes in via PGPASSWORD, same as every other non-interactive pg_dump/pg_restore invocation.
    // PGSSLMODE mirrors this app's own DB_SSL parsing (db/config.js's parseSsl): 'disable' when
    // DB_SSL is unset/false, 'verify-full' when the config asked for real certificate validation,
    // 'require' for TLS-but-don't-verify (the other two DB_SSL settings both map to that here).
    env: {
      ...process.env,
      PGPASSWORD: c.password,
      PGSSLMODE: c.ssl ? (c.ssl.rejectUnauthorized ? 'verify-full' : 'require') : 'disable',
    },
  };
}

function run(cmd, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, env, maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) {
        // pg_dump/pg_restore's own stderr is far more useful here than execFile's generic "Command
        // failed" — trimmed to its last few lines since a connection/auth failure can print a fair
        // amount of preceding diagnostic noise before the actual reason (same trimming backup.js's
        // own runRclone() already does for the exact same reason).
        const detail = (stderr || err.message || '').toString().trim().split('\n').slice(-5).join(' ');
        reject(new Error(detail || `${cmd} failed`));
        return;
      }
      resolve(stdout ? stdout.toString() : '');
    });
  });
}

// pg_dump's fixed preamble (SET statement_timeout/lock_timeout/.../transaction_timeout = 0; ...)
// reflects pg_dump's OWN version, not the server it dumped FROM — a pg_dump 17+ archive always
// includes `SET transaction_timeout = 0;` (that GUC was only added in Postgres 17) even when
// dumping a pre-17 server, so restoring that exact same archive into a pre-17 server later hits
// "unrecognized configuration parameter" on that one line. pg_restore ITSELF already treats this
// as non-fatal (it says so: "errors ignored on restore: N") and continues — reproduced empirically
// dumping this project's own v16 test server with pg_dump 17/18 and restoring back into that same
// v16 server. execFile still reports a non-zero exit for that, so this distinguishes "only these
// known-benign preamble GUC lines failed" (log a warning, treat as success — matching pg_restore's
// own classification) from any OTHER error (a real failure, still rejected as before).
const BENIGN_RESTORE_STDERR_RE = /^(pg_restore: error: could not execute query: ERROR:\s+unrecognized configuration parameter|Command was:|pg_restore: warning: errors ignored on restore: \d+)/;
function runPgRestoreTolerant(args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('pg_restore', args, { timeout: timeoutMs, env, maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (!err) {
        resolve(stdout ? stdout.toString() : '');
        return;
      }
      const lines = (stderr || '').toString().split('\n').map((l) => l.trim()).filter(Boolean);
      const onlyBenign = lines.length > 0 && lines.every((line) => BENIGN_RESTORE_STDERR_RE.test(line));
      if (onlyBenign) {
        console.warn(`pg_restore reported only known-benign preamble warnings, continuing: ${lines.join(' | ')}`);
        resolve(stdout ? stdout.toString() : '');
        return;
      }
      const detail = lines.slice(-5).join(' ') || err.message;
      reject(new Error(detail || 'pg_restore failed'));
    });
  });
}

// --format=custom (-Fc): compressed, and the only pg_dump output format pg_restore can selectively
// and --clean-apply back — a plain SQL dump (-Fp) works too but loses both of those.
async function addPayloadToZip(zip, tmpDir) {
  const config = resolveDbConfig();
  const { args: connArgs, env } = connectionArgs(config);
  const tmpDumpPath = path.join(tmpDir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.pgdump`);
  await run('pg_dump', [...connArgs, '--format=custom', '--file', tmpDumpPath], env, 10 * 60 * 1000);
  zip.addLocalFile(tmpDumpPath, '', ENTRY_FILENAME);
  fs.rmSync(tmpDumpPath, { force: true });
}

// Validates the uploaded dump is at least a real pg_dump custom-format archive — `pg_restore
// --list` parses its table of contents without connecting to any database at all, the closest
// Postgres equivalent of SQLite's own quick_check pragma — then stages it for
// applyPendingRestoreAtBoot() below to pick up. Nothing here touches a live database: same
// restart-to-apply model as the SQLite engine, just with no local db FILE to swap, so the staged
// dump lives under BACKUP_DIR instead of next to one.
async function validateAndStage(zip, pendingRestorePath) {
  const dbEntry = zip.getEntry(ENTRY_FILENAME);
  if (!dbEntry) throw new Error(`Backup does not contain ${ENTRY_FILENAME}.`);

  const checkPath = `${pendingRestorePath}.check-${Date.now()}`;
  fs.writeFileSync(checkPath, zip.readFile(dbEntry));
  try {
    await run('pg_restore', ['--list', checkPath], process.env, 30000);
  } catch (err) {
    fs.rmSync(checkPath, { force: true });
    throw new Error(`Uploaded ${ENTRY_FILENAME} is not a valid pg_dump archive: ${err.message}`);
  }
  fs.renameSync(checkPath, pendingRestorePath);
}

// Called once at boot — see db/index.js's own initPostgres(), right after connectivity is confirmed
// but BEFORE knex.migrate.latest() runs (so a restored dump that already contains its own
// knex_migrations state isn't immediately raced by a fresh-install migration run first). Applies a
// restore staged via validateAndStage() above, then deletes the staged file so it's only ever
// applied once — same one-shot handoff as db/index.js's own SQLite `${dbPath}.restore` swap.
// --clean --if-exists drops each object before recreating it from the dump (a plain pg_restore into
// a non-empty database — which this always is, since the target database itself already exists —
// would otherwise fail on every already-existing table). --no-owner/--no-privileges skip role/
// ownership statements the dump would otherwise carry from whatever Postgres role created it, which
// almost never matches this deployment's own DB_USER.
async function applyPendingRestoreAtBoot(pendingRestorePath) {
  if (!fs.existsSync(pendingRestorePath)) return false;
  const config = resolveDbConfig();
  const { args: connArgs, env } = connectionArgs(config);
  console.log(`Applying a staged Postgres restore from ${pendingRestorePath}...`);
  await runPgRestoreTolerant(
    [...connArgs, '--clean', '--if-exists', '--no-owner', '--no-privileges', pendingRestorePath],
    env,
    10 * 60 * 1000
  );
  fs.rmSync(pendingRestorePath, { force: true });
  console.log('Postgres restore applied.');
  return true;
}

module.exports = { backend: 'postgres', entryFilename: ENTRY_FILENAME, addPayloadToZip, validateAndStage, applyPendingRestoreAtBoot };
