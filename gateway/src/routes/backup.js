const express = require('express');
const fs = require('fs');
const multer = require('multer');
const backup = require('../backup');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

function renderPage(res, extra = {}) {
  res.render('admin-backup', {
    settings: backup.getSettings(),
    backups: backup.listBackups(),
    mqttConfigMounted: fs.existsSync(backup.MOSQUITTO_CONFIG_DIR),
    error: null,
    restored: null,
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

router.post('/run', async (req, res) => {
  try {
    await backup.createBackup({ includeMqttConfig: !!backup.getSettings().include_mqtt_config, reason: 'manual' });
    backup.updateSettings({ last_run_at: new Date().toISOString(), last_status: 'ok', last_error: null });
    res.redirect('/admin/backup');
  } catch (err) {
    backup.updateSettings({ last_run_at: new Date().toISOString(), last_status: 'error', last_error: err.message });
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

router.post('/restore', upload.single('file'), (req, res) => {
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
