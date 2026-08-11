const express = require('express');
const fs = require('fs');
const multer = require('multer');
const backup = require('../backup');
const db = require('../db');
const { notifyBackupFailed, notifyBackupSucceeded } = require('../notifications');
const { verifyCsrfToken } = require('../middleware/csrf');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

async function renderPage(res, extra = {}) {
  res.render('admin-backup', {
    settings: await backup.getSettings(),
    backups: backup.listBackups(),
    mqttConfigMounted: fs.existsSync(backup.MOSQUITTO_CONFIG_DIR),
    // Same read-only "which backend" info admin-general.ejs's own Database card shows — surfaced
    // here too since it directly determines what a backup on this page actually contains
    // (gateway.db vs. a pg_dump archive) and which other install a restore can come from.
    dbInfo: await db.getInfo(),
    error: null,
    restored: null,
    rcloneTestResult: null,
    ...extra,
  });
}

router.get('/', asyncHandler(async (req, res) => renderPage(res)));

router.post('/settings', asyncHandler(async (req, res) => {
  const { enabled, schedule_cron: scheduleCron, retention_count: retentionCount, include_mqtt_config: includeMqttConfig } = req.body;

  try {
    require('cron-parser').parseExpression(scheduleCron || '');
  } catch {
    return renderPage(res, { error: `"${scheduleCron}" is not a valid cron expression (expected 5 fields, e.g. "0 3 * * *").` });
  }

  const retention = Number(retentionCount);
  if (!Number.isFinite(retention) || retention < 1) {
    return renderPage(res, { error: 'Retention count must be at least 1.' });
  }

  await backup.updateSettings({
    enabled: !!enabled,
    schedule_cron: scheduleCron,
    retention_count: Math.round(retention),
    include_mqtt_config: !!includeMqttConfig,
  });
  await backup.rescheduleFromSettings();
  res.redirect('/admin/backup');
}));

router.post('/rclone/settings', asyncHandler(async (req, res) => {
  const { rclone_enabled: rcloneEnabled, rclone_remote: rcloneRemote, rclone_config: rcloneConfig } = req.body;

  if (rcloneEnabled && !(rcloneRemote || '').trim()) {
    return renderPage(res, { error: 'Set a remote (e.g. "myremote:loxsuite-backups") before enabling the offsite copy.' });
  }

  await backup.updateSettings({
    rclone_enabled: !!rcloneEnabled,
    rclone_remote: (rcloneRemote || '').trim(),
    rclone_config: rcloneConfig || '',
  });
  res.redirect('/admin/backup');
}));

// Powers the Offsite copy card's per-backend forms (S3-compatible/SFTP/WebDAV/Backblaze B2) — an
// alternative to pasting a whole rclone.conf by hand. Always replaces both rclone_remote and
// rclone_config wholesale (see buildRcloneConfig's own comment on why); redirects back to the same
// page, which reloads showing the generated config in the plain "Custom" fields for review/tweaking
// — nothing about that fallback goes away, this is just another way to fill in the same two fields.
router.post('/rclone/build-config', asyncHandler(async (req, res) => {
  const { backend_type: backendType, remote_name: remoteName, remote_path: remotePath, ...fields } = req.body;
  try {
    const config = await backup.buildRcloneConfig(backendType, remoteName, fields);
    await backup.updateSettings({ rclone_remote: `${(remoteName || '').trim()}:${(remotePath || '').trim()}`, rclone_config: config });
    res.redirect('/admin/backup');
  } catch (err) {
    await renderPage(res, { error: `Couldn't build rclone config: ${err.message}` });
  }
}));

// Uses whatever's currently saved (not whatever's still unsaved in the form) — same "save first,
// then test" convention as the Miniservers edit page's own Test button, and for the same reason:
// this exercises the real config the next scheduled/manual backup will actually use.
router.post('/rclone/test', asyncHandler(async (req, res) => {
  try {
    await backup.testRcloneConnection();
    await renderPage(res, { rcloneTestResult: { ok: true } });
  } catch (err) {
    await renderPage(res, { rcloneTestResult: { ok: false, error: err.message } });
  }
}));

router.post('/run', asyncHandler(async (req, res) => {
  try {
    const settings = await backup.getSettings();
    await backup.createBackup({ includeMqttConfig: !!settings.include_mqtt_config, reason: 'manual' });
    await backup.updateSettings({ last_run_at: new Date().toISOString(), last_status: 'ok', last_error: null });
    await notifyBackupSucceeded('manual backup');
    res.redirect('/admin/backup');
  } catch (err) {
    await backup.updateSettings({ last_run_at: new Date().toISOString(), last_status: 'error', last_error: err.message });
    await notifyBackupFailed(err.message, 'manual backup');
    await renderPage(res, { error: `Backup failed: ${err.message}` });
  }
}));

router.get('/:filename/download', asyncHandler(async (req, res) => {
  try {
    res.download(backup.getBackupPath(req.params.filename), req.params.filename);
  } catch (err) {
    await renderPage(res, { error: err.message });
  }
}));

router.post('/:filename/delete', asyncHandler(async (req, res) => {
  try {
    backup.deleteBackup(req.params.filename);
    res.redirect('/admin/backup');
  } catch (err) {
    await renderPage(res, { error: err.message });
  }
}));

// verifyCsrfToken runs here, after multer, rather than as global app-wide middleware — the
// global one (server.js) skips multipart bodies entirely since express.urlencoded/json never
// parses them, leaving req.body empty until multer runs. Same token, just checked once the body
// carrying it actually exists.
router.post('/restore', upload.single('file'), verifyCsrfToken, asyncHandler(async (req, res) => {
  if (!req.file) return renderPage(res, { error: 'Choose a backup .zip file to upload first.' });

  try {
    const result = await backup.stageRestore(req.file.buffer);
    await renderPage(res, { restored: result });
  } catch (err) {
    await renderPage(res, { error: `Restore failed: ${err.message}` });
  }
}));

// Same staging logic as an upload, just reading the buffer from a backup already sitting in
// BACKUP_DIR instead of from a fresh multipart upload — no need to download-then-reupload a
// backup made on this same gateway.
router.post('/:filename/restore', asyncHandler(async (req, res) => {
  try {
    const buffer = fs.readFileSync(backup.getBackupPath(req.params.filename));
    const result = await backup.stageRestore(buffer);
    await renderPage(res, { restored: result });
  } catch (err) {
    await renderPage(res, { error: `Restore failed: ${err.message}` });
  }
}));

module.exports = router;
