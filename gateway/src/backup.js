const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');
const cronParser = require('cron-parser');
const db = require('./db');
const { notifyBackupFailed } = require('./notifications');
const { encrypt, decrypt } = require('./secretCrypto');

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
// The broker's own static config (listener, persistence, logging, any custom TLS/tuning) — kept
// alongside dynamic-security.json under the same "Include MQTT config" checkbox/manifest flag
// rather than a separate toggle, since both live in the same mounted directory and are really one
// "MQTT broker config" concept from a backup's point of view. Previously omitted entirely: a
// restore only ever brought back users/roles/ACLs, silently dropping any hand-tuned mosquitto.conf.
const MOSQUITTO_CONF_FILENAME = 'mosquitto.conf';

const BACKUP_FILENAME_RE = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/;

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function timestampForFilename(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function getSettings() {
  const settings = await db.prepare('SELECT * FROM backup_settings WHERE id = 1').get();
  // Decrypted here so every reader (the admin-backup.ejs textarea, routes/setup.js's wizard step,
  // and writeTempRcloneConfig below) gets the real rclone.conf contents without its own call.
  return settings ? { ...settings, rclone_config: decrypt(settings.rclone_config) } : settings;
}

async function updateSettings(fields) {
  const current = await getSettings();
  const next = { ...current, ...fields };
  if (next.rclone_config) next.rclone_config = encrypt(next.rclone_config);
  await db.prepare(
    `UPDATE backup_settings SET enabled = ?, schedule_cron = ?, retention_count = ?, include_mqtt_config = ?,
     last_run_at = ?, last_status = ?, last_error = ?,
     rclone_enabled = ?, rclone_remote = ?, rclone_config = ?,
     rclone_last_run_at = ?, rclone_last_status = ?, rclone_last_error = ? WHERE id = 1`
  ).run(
    next.enabled ? 1 : 0,
    next.schedule_cron,
    next.retention_count,
    next.include_mqtt_config ? 1 : 0,
    next.last_run_at,
    next.last_status,
    next.last_error,
    next.rclone_enabled ? 1 : 0,
    next.rclone_remote,
    next.rclone_config,
    next.rclone_last_run_at,
    next.rclone_last_status,
    next.rclone_last_error
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

  // Online backup via better-sqlite3's own .backup() — the one thing that needs the real driver
  // object rather than a SQL string, so it goes through the facade's withRawConnection escape
  // hatch (same pooled connection prepare()/transaction() use, acquired then released back, never
  // a second independent one) instead of a db.backup() method the facade doesn't have.
  await db.withRawConnection((conn) => conn.backup(tmpDbPath));

  const zip = new AdmZip();
  zip.addLocalFile(tmpDbPath, '', 'gateway.db');

  let mqttConfigIncluded = false;
  if (includeMqttConfig) {
    const dynsecPath = path.join(MOSQUITTO_CONFIG_DIR, DYNSEC_FILENAME);
    if (fs.existsSync(dynsecPath)) {
      zip.addLocalFile(dynsecPath, '', DYNSEC_FILENAME);
      mqttConfigIncluded = true;
    }
    // mosquitto.conf (listener/persistence/logging/any custom tuning) lives in the same mounted
    // directory as dynamic-security.json — bundled under this same flag rather than a second
    // checkbox, since from a backup's point of view they're one "MQTT broker config" concept.
    const confPath = path.join(MOSQUITTO_CONFIG_DIR, MOSQUITTO_CONF_FILENAME);
    if (fs.existsSync(confPath)) {
      zip.addLocalFile(confPath, '', MOSQUITTO_CONF_FILENAME);
      mqttConfigIncluded = true;
    }
  }

  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify({ createdAt: now.toISOString(), reason, includesMqttConfig: mqttConfigIncluded }, null, 2))
  );
  zip.writeZip(finalPath);
  fs.rmSync(tmpDbPath, { force: true });

  await enforceRetention();

  // Additive offsite copy — failing here must not fail the backup itself (the local zip already
  // exists and retention already ran), just surface the failure on its own status fields so it's
  // visible on the Backups page without silently pretending the offsite copy succeeded.
  const settings = await getSettings();
  if (settings.rclone_enabled) {
    try {
      await uploadToRclone(finalPath, settings);
      await updateSettings({ rclone_last_run_at: new Date().toISOString(), rclone_last_status: 'ok', rclone_last_error: null });
    } catch (err) {
      await updateSettings({ rclone_last_run_at: new Date().toISOString(), rclone_last_status: 'error', rclone_last_error: err.message });
      await notifyBackupFailed(err.message, 'offsite copy (rclone)');
    }
  }

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
async function enforceRetention() {
  const { retention_count: retentionCount } = await getSettings();
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

  // Same "write now, only takes effect on the shared container's next restart" reasoning as
  // dynamic-security.json above — no structural validation attempted here (unlike that file's
  // clients/roles array check) since a plain-text broker config has no equivalently simple shape
  // to check; a malformed one just fails loudly when mosquitto itself tries to load it after the
  // restart, same as hand-editing it directly would.
  const confEntry = zip.getEntry(MOSQUITTO_CONF_FILENAME);
  if (confEntry && fs.existsSync(MOSQUITTO_CONFIG_DIR)) {
    const confPath = path.join(MOSQUITTO_CONFIG_DIR, MOSQUITTO_CONF_FILENAME);
    const content = zip.readFile(confEntry);
    let ownership = null;
    if (fs.existsSync(confPath)) {
      const stat = fs.statSync(confPath);
      ownership = { uid: stat.uid, gid: stat.gid, mode: stat.mode };
    }
    fs.writeFileSync(confPath, content);
    if (ownership) {
      fs.chownSync(confPath, ownership.uid, ownership.gid);
      fs.chmodSync(confPath, ownership.mode);
    }
    mqttConfigRestored = true;
  }

  return { restartTargets, mqttConfigRestored };
}

// rclone_config holds a whole rclone.conf's worth of text (an admin runs `rclone config`
// wherever's convenient — their own machine, another server — and pastes the result in) — written
// to a throwaway temp file only for the lifetime of a single rclone invocation, never left sitting
// on disk as its own file, since it carries the remote's own credentials.
function writeTempRcloneConfig(configContent) {
  const tmpPath = path.join(os.tmpdir(), `loxsuite-rclone-${Date.now()}-${Math.random().toString(36).slice(2)}.conf`);
  fs.writeFileSync(tmpPath, configContent || '', { mode: 0o600 });
  return tmpPath;
}

function runRclone(args, configPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('rclone', ['--config', configPath, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        // rclone's own error text (stderr) is far more useful here than execFile's generic
        // "Command failed" — trimmed to its last few lines since a config/auth failure can print a
        // fair amount of preceding diagnostic noise before the actual reason.
        const detail = (stderr || err.message || '').toString().trim().split('\n').slice(-3).join(' ');
        reject(new Error(detail || 'rclone failed'));
        return;
      }
      resolve(stdout ? stdout.toString() : '');
    });
  });
}

// Additive-only upload of one already-created local backup zip — deliberately never deletes or
// mirrors anything on the remote side (rclone `copyto`, not `sync`), so this can't ever prune an
// offsite copy the local retention settings above have already aged out; that stays entirely up to
// whatever lifecycle rules (or manual cleanup) the admin sets on the remote itself.
async function uploadToRclone(localZipPath, settings) {
  const s = settings || (await getSettings());
  if (!s.rclone_remote) throw new Error('No rclone remote configured.');
  const configPath = writeTempRcloneConfig(s.rclone_config);
  try {
    const dest = `${s.rclone_remote.replace(/\/+$/, '')}/${path.basename(localZipPath)}`;
    await runRclone(['copyto', localZipPath, dest], configPath, 120000);
  } finally {
    fs.rmSync(configPath, { force: true });
  }
}

// Shells out to rclone's own `obscure` subcommand rather than reimplementing its (reversible,
// not-for-security, just-avoids-shoulder-surfing) obfuscation format by hand — this is the exact
// encoding rclone's own config parser expects for password-type fields (SFTP/WebDAV's `pass`),
// verified against the real binary already used everywhere else in this file rather than guessed
// at from rclone's docs.
function obscurePassword(plain) {
  return new Promise((resolve, reject) => {
    execFile('rclone', ['obscure', plain], (err, stdout) => {
      if (err) { reject(new Error(`Could not obscure password: ${err.message}`)); return; }
      resolve(stdout.toString().trim());
    });
  });
}

function assertNoLineBreaks(value, label) {
  if (/[\r\n]/.test(value || '')) throw new Error(`${label} must not contain line breaks.`);
}

// Builds one rclone.conf stanza from a handful of plain fields for one of a few common backend
// types, instead of requiring an admin to already know rclone.conf's own INI syntax (and, for
// SFTP/WebDAV, that a plaintext password there simply doesn't work — it has to be pre-obscured).
// Only replaces the WHOLE saved rclone_config — this app only ever drives a single active remote
// (see rclone_remote), not a multi-remote conf file, so there's nothing to merge into.
async function buildRcloneConfig(backendType, remoteName, fields) {
  const name = (remoteName || '').trim();
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error('Remote name must be letters, numbers, "-" or "_" only.');
  }
  Object.entries(fields).forEach(([key, value]) => assertNoLineBreaks(value, key));

  const lines = [`[${name}]`];
  if (backendType === 's3') {
    if (!fields.access_key_id || !fields.secret_access_key) throw new Error('Access key ID and secret access key are required.');
    if (fields.provider !== 'AWS' && !fields.endpoint) throw new Error('Endpoint is required for this provider.');
    lines.push('type = s3');
    lines.push(`provider = ${fields.provider || 'Other'}`);
    lines.push(`access_key_id = ${fields.access_key_id}`);
    lines.push(`secret_access_key = ${fields.secret_access_key}`);
    if (fields.endpoint) lines.push(`endpoint = ${fields.endpoint}`);
    if (fields.region) lines.push(`region = ${fields.region}`);
  } else if (backendType === 'sftp') {
    if (!fields.host || !fields.user || !fields.pass) throw new Error('Host, username and password are required.');
    lines.push('type = sftp');
    lines.push(`host = ${fields.host}`);
    if (fields.port && Number(fields.port) !== 22) lines.push(`port = ${fields.port}`);
    lines.push(`user = ${fields.user}`);
    lines.push(`pass = ${await obscurePassword(fields.pass)}`);
  } else if (backendType === 'webdav') {
    if (!fields.url || !fields.user || !fields.pass) throw new Error('URL, username and password are required.');
    lines.push('type = webdav');
    lines.push(`url = ${fields.url}`);
    lines.push(`vendor = ${fields.vendor || 'other'}`);
    lines.push(`user = ${fields.user}`);
    lines.push(`pass = ${await obscurePassword(fields.pass)}`);
  } else if (backendType === 'b2') {
    if (!fields.account || !fields.key) throw new Error('Account ID and application key are required.');
    lines.push('type = b2');
    lines.push(`account = ${fields.account}`);
    lines.push(`key = ${fields.key}`);
  } else {
    throw new Error('Unknown backend type.');
  }
  return `${lines.join('\n')}\n`;
}

// Backs the Backups page's "Test connection" button — lists the remote path's own contents without
// touching any files, the lightest read-only operation that still proves both the pasted config and
// the remote path actually work end to end.
async function testRcloneConnection(settings) {
  const s = settings || (await getSettings());
  if (!s.rclone_remote) throw new Error('No rclone remote configured.');
  const configPath = writeTempRcloneConfig(s.rclone_config);
  try {
    await runRclone(['lsd', s.rclone_remote], configPath, 20000);
  } finally {
    fs.rmSync(configPath, { force: true });
  }
}

let scheduledTimer = null;

async function scheduleNext() {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  scheduledTimer = null;

  const settings = await getSettings();
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
      const settingsNow = await getSettings();
      try {
        await createBackup({ includeMqttConfig: !!settingsNow.include_mqtt_config, reason: 'scheduled' });
        await updateSettings({ last_run_at: new Date().toISOString(), last_status: 'ok', last_error: null });
      } catch (err) {
        await updateSettings({ last_run_at: new Date().toISOString(), last_status: 'error', last_error: err.message });
        await notifyBackupFailed(err.message, 'scheduled backup');
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
async function rescheduleFromSettings() {
  await scheduleNext();
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
  testRcloneConnection,
  buildRcloneConfig,
};
