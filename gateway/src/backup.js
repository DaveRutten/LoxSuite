const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');
const cronParser = require('cron-parser');
const db = require('./db');

// Recomputed independently rather than imported from db.js, same convention already used by
// mosquittoLog.js/loxone.js for their own env-configured paths (see MOSQUITTO_LOG_PATH there) —
// db.js exports the open Database instance itself, not its path.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'gateway.db');
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
const PENDING_RESTORE_PATH = `${DB_PATH}.restore`; // mirrors db.js's own constant, see its comment

// Only present when the docker-compose mosquitto config volume is mounted (see
// docker-compose.yml) — absent, "include MQTT config" backups/restores just skip that half
// rather than failing the whole operation.
const MOSQUITTO_CONFIG_DIR = process.env.MOSQUITTO_CONFIG_PATH || '/mosquitto/config';
const DYNSEC_FILENAME = 'dynamic-security.json';

const BACKUP_FILENAME_RE = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/;

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function timestampForFilename(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function getSettings() {
  return db.prepare('SELECT * FROM backup_settings WHERE id = 1').get();
}

function updateSettings(fields) {
  const current = getSettings();
  const next = { ...current, ...fields };
  db.prepare(
    `UPDATE backup_settings SET enabled = ?, schedule_cron = ?, retention_count = ?, include_mqtt_config = ?,
     last_run_at = ?, last_status = ?, last_error = ? WHERE id = 1`
  ).run(
    next.enabled ? 1 : 0,
    next.schedule_cron,
    next.retention_count,
    next.include_mqtt_config ? 1 : 0,
    next.last_run_at,
    next.last_status,
    next.last_error
  );
  return getSettings();
}

// Online backup via better-sqlite3's own .backup() (safe under WAL, unlike copying the file's
// bytes directly while it's open) — enforces retention afterward so this can't be called
// unboundedly (manual "Backup now" clicks included) without the backups directory growing forever.
async function createBackup({ includeMqttConfig = true, reason = 'manual' } = {}) {
  ensureBackupDir();
  const now = new Date();
  const stamp = timestampForFilename(now);
  const tmpDbPath = path.join(BACKUP_DIR, `.tmp-${stamp}.db`);
  const finalPath = path.join(BACKUP_DIR, `backup-${stamp}.zip`);

  await db.backup(tmpDbPath);

  const zip = new AdmZip();
  zip.addLocalFile(tmpDbPath, '', 'gateway.db');

  let mqttConfigIncluded = false;
  if (includeMqttConfig) {
    const dynsecPath = path.join(MOSQUITTO_CONFIG_DIR, DYNSEC_FILENAME);
    if (fs.existsSync(dynsecPath)) {
      zip.addLocalFile(dynsecPath, '', DYNSEC_FILENAME);
      mqttConfigIncluded = true;
    }
  }

  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify({ createdAt: now.toISOString(), reason, includesMqttConfig: mqttConfigIncluded }, null, 2))
  );
  zip.writeZip(finalPath);
  fs.rmSync(tmpDbPath, { force: true });

  enforceRetention();

  return { filename: path.basename(finalPath), createdAt: now.toISOString(), includesMqttConfig: mqttConfigIncluded };
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => BACKUP_FILENAME_RE.test(f))
    .map((filename) => {
      const fullPath = path.join(BACKUP_DIR, filename);
      const stat = fs.statSync(fullPath);
      let includesMqttConfig = false;
      let reason = 'manual';
      try {
        const manifest = JSON.parse(new AdmZip(fullPath).readAsText('manifest.json'));
        includesMqttConfig = !!manifest.includesMqttConfig;
        reason = manifest.reason || 'manual';
      } catch {
        // Older or hand-edited zip without a readable manifest — still listed, just without that detail.
      }
      return { filename, size: stat.size, createdAt: stat.mtime.toISOString(), includesMqttConfig, reason };
    })
    .sort((a, b) => b.filename.localeCompare(a.filename));
}

// Keeps only the most recent `retention_count` backups — runs after every createBackup() (manual
// or scheduled) so retention can't be bypassed by clicking "Backup now" repeatedly.
function enforceRetention() {
  const { retention_count: retentionCount } = getSettings();
  const backups = listBackups();
  for (const old of backups.slice(retentionCount)) {
    fs.rmSync(path.join(BACKUP_DIR, old.filename), { force: true });
  }
}

function deleteBackup(filename) {
  if (!BACKUP_FILENAME_RE.test(filename)) throw new Error('Not a valid backup filename.');
  const fullPath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(fullPath)) throw new Error('Backup not found.');
  fs.rmSync(fullPath);
}

function getBackupPath(filename) {
  if (!BACKUP_FILENAME_RE.test(filename)) throw new Error('Not a valid backup filename.');
  const fullPath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(fullPath)) throw new Error('Backup not found.');
  return fullPath;
}

// Stages an uploaded backup for restore. Neither half is applied live:
//  - gateway.db can't be hot-swapped out from under this process's already-open connection (see
//    db.js), so the validated file is dropped next to it and picked up on the next boot.
//  - dynamic-security.json IS written immediately (mosquitto has no equivalent "swap this out from
//    under me" problem the way an open SQLite connection does), but mosquitto only reads its
//    dynamic-security file at startup and otherwise treats its in-memory state as the source of
//    truth (periodically flushing it back out) — so the write only sticks once mosquitto itself
//    restarts too, which this function has no way to trigger directly (no docker socket access,
//    on purpose). Both processes share one container now, so one container restart covers both;
//    the caller still surfaces that restart requirement to the admin.
function stageRestore(zipBuffer) {
  ensureBackupDir();
  const zip = new AdmZip(zipBuffer);

  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) throw new Error('Not a LoxSuite backup — missing manifest.json.');
  JSON.parse(zip.readAsText(manifestEntry)); // throws if not valid JSON

  const dbEntry = zip.getEntry('gateway.db');
  if (!dbEntry) throw new Error('Backup does not contain gateway.db.');

  const checkPath = path.join(BACKUP_DIR, `.restore-check-${Date.now()}.db`);
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
    // so the renames below wouldn't carry them along, and they'd otherwise litter BACKUP_DIR.
    fs.rmSync(`${checkPath}-shm`, { force: true });
    fs.rmSync(`${checkPath}-wal`, { force: true });
  }

  fs.renameSync(checkPath, PENDING_RESTORE_PATH);

  // Both mosquitto and the gateway live in this one container, so there's only ever one target
  // to restart — kept as an array/name (rather than a plain boolean) since admin-backup.ejs
  // renders it straight into a `docker compose restart <targets>` command.
  const restartTargets = ['loxsuite'];
  let mqttConfigRestored = false;
  const dynsecEntry = zip.getEntry(DYNSEC_FILENAME);
  if (dynsecEntry) {
    const dynsecPath = path.join(MOSQUITTO_CONFIG_DIR, DYNSEC_FILENAME);
    const content = zip.readFile(dynsecEntry);
    const parsed = JSON.parse(content.toString('utf8'));
    if (!Array.isArray(parsed.clients) || !Array.isArray(parsed.roles)) {
      throw new Error(`${DYNSEC_FILENAME} in this backup doesn't look like a Mosquitto dynamic-security file.`);
    }
    if (fs.existsSync(MOSQUITTO_CONFIG_DIR)) {
      // Preserve whatever owner/mode the file already had (docker-entrypoint.sh sets 600 on
      // first boot) rather than whatever this write's own process happens to default to.
      let ownership = null;
      if (fs.existsSync(dynsecPath)) {
        const stat = fs.statSync(dynsecPath);
        ownership = { uid: stat.uid, gid: stat.gid, mode: stat.mode };
      }
      fs.writeFileSync(dynsecPath, content);
      if (ownership) {
        fs.chownSync(dynsecPath, ownership.uid, ownership.gid);
        fs.chmodSync(dynsecPath, ownership.mode);
      }
      mqttConfigRestored = true;
    }
  }

  return { restartTargets, mqttConfigRestored };
}

let scheduledTimer = null;

function scheduleNext() {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  scheduledTimer = null;

  const settings = getSettings();
  if (!settings.enabled) return;

  let nextRun;
  try {
    nextRun = cronParser.parseExpression(settings.schedule_cron).next().toDate();
  } catch (err) {
    console.error(`Backup schedule "${settings.schedule_cron}" is not a valid cron expression: ${err.message}`);
    return;
  }

  // setTimeout's delay is a 32-bit signed int under the hood, which caps out around 24.8 days —
  // re-check at least once a day instead of scheduling a single, potentially much longer (e.g.
  // monthly) wait that would silently overflow. Only the tick that actually reaches the real
  // due time runs a backup; every capped, not-yet-due tick just loops back into scheduleNext().
  const MAX_DELAY_MS = 24 * 60 * 60 * 1000;
  const msUntilRun = nextRun.getTime() - Date.now();
  const isActualRun = msUntilRun <= MAX_DELAY_MS;
  const delay = Math.max(Math.min(msUntilRun, MAX_DELAY_MS), 1000);

  scheduledTimer = setTimeout(async () => {
    if (isActualRun) {
      const settingsNow = getSettings();
      try {
        await createBackup({ includeMqttConfig: !!settingsNow.include_mqtt_config, reason: 'scheduled' });
        updateSettings({ last_run_at: new Date().toISOString(), last_status: 'ok', last_error: null });
      } catch (err) {
        updateSettings({ last_run_at: new Date().toISOString(), last_status: 'error', last_error: err.message });
      }
    }
    scheduleNext();
  }, delay);
}

function startScheduler() {
  scheduleNext();
}

// Called after the admin page saves schedule settings, so a change takes effect immediately
// instead of waiting for the next daily re-check.
function rescheduleFromSettings() {
  scheduleNext();
}

module.exports = {
  BACKUP_DIR,
  MOSQUITTO_CONFIG_DIR,
  createBackup,
  listBackups,
  deleteBackup,
  getBackupPath,
  stageRestore,
  getSettings,
  updateSettings,
  startScheduler,
  rescheduleFromSettings,
};
