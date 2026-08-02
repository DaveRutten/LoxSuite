const express = require('express');
const fs = require('fs');
const multer = require('multer');
const backup = require('../backup');
const { notifyBackupFailed } = require('../notifications');
const { verifyCsrfToken } = require('../middleware/csrf');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

function renderPage(res, extra = {}) {
  res.render('admin-backup', {
    settings: backup.getSettings(),
    backups: backup.listBackups(),
    mqttConfigMounted: fs.existsSync(backup.MOSQUITTO_CONFIG_DIR),
    error: null,
    restored: null,
    rcloneTestResult: null,
    ...extra,
  });
}

router.get('/', (req, res) => renderPage(res));

router.post('/settings', (req, res) => {
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

  backup.updateSettings({
    enabled: !!enabled,
    schedule_cron: scheduleCron,
    retention_count: Math.round(retention),
    include_mqtt_config: !!includeMqttConfig,
  });
  backup.rescheduleFromSettings();
  res.redirect('/admin/backup');
});

router.post('/rclone/settings', (req, res) => {
  const { rclone_enabled: rcloneEnabled, rclone_remote: rcloneRemote, rclone_config: rcloneConfig } = req.body;

  if (rcloneEnabled && !(rcloneRemote || '').trim()) {
    return renderPage(res, { error: 'Set a remote (e.g. "myremote:loxsuite-backups") before enabling the offsite copy.' });
  }

  backup.updateSettings({
    rclone_enabled: !!rcloneEnabled,
    rclone_remote: (rcloneRemote || '').trim(),
    rclone_config: rcloneConfig || '',
  });
  res.redirect('/admin/backup');
});

// Powers the Offsite copy card's per-backend forms (S3-compatible/SFTP/WebDAV/Backblaze B2) — an
// alternative to pasting a whole rclone.conf by hand. Always replaces both rclone_remote and
// rclone_config wholesale (see buildRcloneConfig's own comment on why); redirects back to the same
// page, which reloads showing the generated config in the plain "Custom" fields for review/tweaking
// — nothing about that fallback goes away, this is just another way to fill in the same two fields.
router.post('/rclone/build-config', async (req, res) => {
  const { backend_type: backendType, remote_name: remoteName, remote_path: remotePath, ...fields } = req.body;
  try {
    const config = await backup.buildRcloneConfig(backendType, remoteName, fields);
    backup.updateSettings({ rclone_remote: `${(remoteName || '').trim()}:${(remotePath || '').trim()}`, rclone_config: config });
    res.redirect('/admin/backup');
  } catch (err) {
    renderPage(res, { error: `Couldn't build rclone config: ${err.message}` });
  }
});

// Uses whatever's currently saved (not whatever's still unsaved in the form) — same "save first,
// then test" convention as the Miniservers edit page's own Test button, and for the same reason:
// this exercises the real config the next scheduled/manual backup will actually use.
router.post('/rclone/test', async (req, res) => {
  try {
    await backup.testRcloneConnection();
    renderPage(res, { rcloneTestResult: { ok: true } });
  } catch (err) {
    renderPage(res, { rcloneTestResult: { ok: false, error: err.message } });
  }
});

router.post('/run', async (req, res) => {
  try {
    await backup.createBackup({ includeMqttConfig: !!backup.getSettings().include_mqtt_config, reason: 'manual' });
    backup.updateSettings({ last_run_at: new Date().toISOString(), last_status: 'ok', last_error: null });
    res.redirect('/admin/backup');
  } catch (err) {
    backup.updateSettings({ last_run_at: new Date().toISOString(), last_status: 'error', last_error: err.message });
    notifyBackupFailed(err.message, 'manual backup');
    renderPage(res, { error: `Backup failed: ${err.message}` });
  }
});

router.get('/:filename/download', (req, res) => {
  try {
    res.download(backup.getBackupPath(req.params.filename), req.params.filename);
  } catch (err) {
    renderPage(res, { error: err.message });
  }
});

router.post('/:filename/delete', (req, res) => {
  try {
    backup.deleteBackup(req.params.filename);
    res.redirect('/admin/backup');
  } catch (err) {
    renderPage(res, { error: err.message });
  }
});

// verifyCsrfToken runs here, after multer, rather than as global app-wide middleware — the
// global one (server.js) skips multipart bodies entirely since express.urlencoded/json never
// parses them, leaving req.body empty until multer runs. Same token, just checked once the body
// carrying it actually exists.
router.post('/restore', upload.single('file'), verifyCsrfToken, (req, res) => {
  if (!req.file) return renderPage(res, { error: 'Choose a backup .zip file to upload first.' });

  try {
    const result = backup.stageRestore(req.file.buffer);
    renderPage(res, { restored: result });
  } catch (err) {
    renderPage(res, { error: `Restore failed: ${err.message}` });
  }
});

// Same staging logic as an upload, just reading the buffer from a backup already sitting in
// BACKUP_DIR instead of from a fresh multipart upload — no need to download-then-reupload a
// backup made on this same gateway.
router.post('/:filename/restore', (req, res) => {
  try {
    const buffer = fs.readFileSync(backup.getBackupPath(req.params.filename));
    const result = backup.stageRestore(buffer);
    renderPage(res, { restored: result });
  } catch (err) {
    renderPage(res, { error: `Restore failed: ${err.message}` });
  }
});

module.exports = router;
