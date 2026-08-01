const express = require('express');
const bcrypt = require('bcryptjs');
const mqtt = require('mqtt');
const crypto = require('crypto');
const db = require('../db');
const { invalidateTimezoneCache } = require('../dateFormat');
const { checkMiniserver } = require('../healthcheck');
const { logSystemEvent } = require('../auditLog');
const backup = require('../backup');
const { sendTestMessage } = require('../notifications');
const { encrypt, decrypt } = require('../secretCrypto');
const mqttClient = require('../mqttClient');

const router = express.Router();
const TIMEZONES = Intl.supportedValuesOf('timeZone');
const STEPS = ['welcome', 'password', 'timezone', 'miniserver', 'mqtt', 'sso', 'backup', 'notifications', 'done'];

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function currentStep(req) {
  const step = STEPS.includes(req.query.step) ? req.query.step : STEPS[0];
  return step;
}

// A step's badge only shows a checkmark once it's actually been submitted (Skip or a real save) —
// see markVisited below — not just because its current state happens to already look valid.
function loadVisitedSteps() {
  const row = db.prepare('SELECT setup_wizard_visited_steps FROM gateway_settings WHERE id = 1').get();
  return (row?.setup_wizard_visited_steps || '').split(',').filter(Boolean);
}

function markVisited(step) {
  const visited = new Set(loadVisitedSteps());
  visited.add(step);
  db.prepare('UPDATE gateway_settings SET setup_wizard_visited_steps = ? WHERE id = 1').run(Array.from(visited).join(','));
}

function loadMqttSettings() {
  const settings = db.prepare('SELECT * FROM mqtt_settings WHERE id = 1').get();
  return settings ? { ...settings, password: decrypt(settings.password) } : settings;
}

function render(req, res, extra = {}) {
  res.render('setup-wizard', {
    step: currentStep(req),
    steps: STEPS,
    visitedSteps: loadVisitedSteps(),
    timezones: TIMEZONES,
    gatewaySettings: db.prepare('SELECT * FROM gateway_settings WHERE id = 1').get(),
    miniserverCount: db.prepare('SELECT COUNT(*) AS c FROM miniservers').get().c,
    mqttSettings: loadMqttSettings(),
    sso: db.prepare('SELECT * FROM sso_settings WHERE id = 1').get(),
    roles: db.prepare('SELECT * FROM access_roles ORDER BY name').all(),
    backupSettings: backup.getSettings(),
    channelCount: db.prepare('SELECT COUNT(*) AS c FROM notification_channels').get().c,
    error: null,
    ...extra,
  });
}

function markCompleted() {
  db.prepare('UPDATE gateway_settings SET setup_wizard_completed = 1 WHERE id = 1').run();
}

router.get('/', (req, res) => render(req, res));

router.post('/password', (req, res) => {
  const { new_password: newPassword, confirm_password: confirmPassword } = req.body;
  if (req.user.authProvider !== 'local') return res.redirect('/setup?step=timezone');

  if (newPassword) {
    if (newPassword.length < 8) return render(req, res, { error: 'New password must be at least 8 characters.' });
    if (newPassword !== confirmPassword) return render(req, res, { error: 'New password and confirmation do not match.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
    logSystemEvent(`"${req.user.username}" changed their password via the setup wizard.`);
  }
  markVisited('password');
  res.redirect('/setup?step=timezone');
});

router.post('/timezone', (req, res) => {
  const timezone = (req.body.display_timezone || '').trim();
  if (timezone) {
    if (!isValidTimezone(timezone)) return render(req, res, { error: `"${timezone}" isn't a recognized timezone name.` });
    db.prepare('UPDATE gateway_settings SET display_timezone = ? WHERE id = 1').run(timezone);
    invalidateTimezoneCache();
  }
  markVisited('timezone');
  res.redirect('/setup?step=miniserver');
});

router.post('/miniserver', async (req, res) => {
  const { name, host, http_port: httpPort, udp_port: udpPort, username, password, use_https: useHttps, external_url: externalUrl } = req.body;
  if (!name && !host && !username && !password) {
    markVisited('miniserver');
    return res.redirect('/setup?step=mqtt');
  }
  if (!name || !host || !username || !password) {
    return render(req, res, { error: 'Name, host, username and password are all required to add a Miniserver — or leave every field blank to skip this step.' });
  }

  // Same field set as the regular Add Miniserver form (routes/miniservers.js) — UDP port and
  // External URL were missing here even though the wizard's own form already collected them,
  // silently dropping whatever was typed into those two fields.
  const result = db.prepare(
    `INSERT INTO miniservers (name, host, http_port, udp_port, username, password, use_https, external_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, host, Number(httpPort) || 80, udpPort ? Number(udpPort) : null, username, encrypt(password), useHttps ? 1 : 0, externalUrl ? externalUrl.trim().replace(/\/+$/, '') : null);
  logSystemEvent(`"${req.user.username}" added Miniserver "${name}" (${host}) via the setup wizard.`);

  // Same "don't leave it on Unknown" reasoning as the regular Add Miniserver form (routes/miniservers.js).
  const inserted = db.prepare('SELECT * FROM miniservers WHERE id = ?').get(result.lastInsertRowid);
  await checkMiniserver(inserted);

  markVisited('miniserver');
  res.redirect('/setup?step=mqtt');
});

router.post('/mqtt', (req, res) => {
  const { host, port, username, password, use_tls: useTls } = req.body;
  if (!host || !port) {
    return render(req, res, { error: 'Host and port are required — or leave everything blank to skip this step.' });
  }

  db.prepare(
    'UPDATE mqtt_settings SET host = ?, port = ?, username = ?, password = ?, use_tls = ? WHERE id = 1'
  ).run(host, Number(port), username || null, encrypt(password) || null, useTls ? 1 : 0);
  mqttClient.reconnect();
  logSystemEvent(`"${req.user.username}" updated the MQTT broker connection via the setup wizard.`);
  markVisited('mqtt');
  res.redirect('/setup?step=sso');
});

// Ad-hoc test against whatever's currently typed into the form, before it's been saved — same
// one-shot-connection pattern as dynamicSecurity.js's testClientConnection, just fully
// parameterized (host/port too, not only username/password) since nothing's saved yet to fall
// back on.
router.post('/mqtt/test', async (req, res) => {
  const { host, port, username, password, use_tls: useTls } = req.body;
  if (!host || !port) return res.status(400).json({ error: 'Fill in host and port first.' });

  const protocol = useTls ? 'mqtts' : 'mqtt';
  const start = Date.now();
  const client = mqtt.connect(`${protocol}://${host}:${port}`, {
    clientId: `loxsuite-test-${crypto.randomBytes(3).toString('hex')}`,
    username: username || undefined,
    password: password || undefined,
    connectTimeout: 5000,
    reconnectPeriod: 0, // one-shot — a failed attempt must not keep silently retrying in the background
  });

  let settled = false;
  const result = await new Promise((resolve) => {
    function finish(ok, error) {
      if (settled) return;
      settled = true;
      client.removeAllListeners();
      client.end(true);
      resolve({ ok, ms: Date.now() - start, error: error || null });
    }
    client.once('connect', () => finish(true));
    client.once('error', (err) => finish(false, err.message));
    setTimeout(() => finish(false, 'Timed out'), 5000);
  });
  res.json(result);
});

router.post('/sso', (req, res) => {
  const { enabled, issuer_url: issuerUrl, client_id: clientId, client_secret: clientSecret, default_role_id: defaultRoleId } = req.body;

  if (enabled && (!issuerUrl || !clientId)) {
    return render(req, res, { error: 'Issuer URL and Client ID are both required to enable Single Sign-On — or leave Enabled off to skip this step.' });
  }

  // Blank secret = keep whatever's already saved — same convention as Administration -> SSO
  // (routes/admin.js), since the real secret is never sent back down to the browser to re-submit.
  const existing = db.prepare('SELECT client_secret FROM sso_settings WHERE id = 1').get();
  const newSecret = clientSecret ? encrypt(clientSecret) : existing?.client_secret;

  db.prepare(
    `UPDATE sso_settings SET enabled = ?, issuer_url = ?, client_id = ?, client_secret = ?, default_role_id = ? WHERE id = 1`
  ).run(enabled ? 1 : 0, issuerUrl || null, clientId || null, newSecret || null, defaultRoleId || null);
  if (enabled) logSystemEvent(`"${req.user.username}" enabled Single Sign-On via the setup wizard.`);
  markVisited('sso');
  res.redirect('/setup?step=backup');
});

router.post('/backup', (req, res) => {
  const {
    enabled, schedule_cron: scheduleCron, retention_count: retentionCount,
    rclone_enabled: rcloneEnabled, rclone_remote: rcloneRemote, rclone_config: rcloneConfig,
  } = req.body;

  if (enabled) {
    try {
      require('cron-parser').parseExpression(scheduleCron || '');
    } catch {
      return render(req, res, { error: `"${scheduleCron}" is not a valid cron expression (expected 5 fields, e.g. "0 3 * * *").` });
    }
    const retention = Number(retentionCount);
    if (!Number.isFinite(retention) || retention < 1) {
      return render(req, res, { error: 'Retention count must be at least 1.' });
    }
  }
  if (rcloneEnabled && !(rcloneRemote || '').trim()) {
    return render(req, res, { error: 'Set a remote (e.g. "myremote:loxsuite-backups") before enabling the offsite copy.' });
  }

  // Only the fields this step's form actually shows get overwritten — schedule_cron/retention_count
  // fall back to whatever's already saved when the local schedule itself is left off, same as how
  // the SSO handler above leaves button_label/local_login_disabled untouched.
  const current = backup.getSettings();
  backup.updateSettings({
    enabled: !!enabled,
    schedule_cron: enabled ? scheduleCron : current.schedule_cron,
    retention_count: enabled ? Math.round(Number(retentionCount)) : current.retention_count,
    rclone_enabled: !!rcloneEnabled,
    rclone_remote: (rcloneRemote || '').trim(),
    rclone_config: rcloneConfig || '',
  });
  backup.rescheduleFromSettings();
  if (enabled || rcloneEnabled) logSystemEvent(`"${req.user.username}" configured backups via the setup wizard.`);
  markVisited('backup');
  res.redirect('/setup?step=notifications');
});

router.post('/notifications', (req, res) => {
  const { name, url } = req.body;
  if (!name && !url) {
    markVisited('notifications');
    return res.redirect('/setup?step=done');
  }
  if (!name || !url) {
    return render(req, res, { error: 'Channel name and Apprise URL are both required to add a channel — or leave both blank to skip this step.' });
  }
  db.prepare('INSERT INTO notification_channels (name, url, enabled, created_at) VALUES (?, ?, 1, ?)')
    .run(name.trim(), url.trim(), new Date().toISOString());
  logSystemEvent(`"${req.user.username}" added notification channel "${name}" via the setup wizard.`);
  markVisited('notifications');
  res.redirect('/setup?step=done');
});

// Ad-hoc test against whatever's currently typed into the form, before anything's been saved —
// same reasoning as POST /miniserver's own /miniservers/test. sendTestMessage() only ever needs
// {name, url} (see notifications.js), not a real saved channel row, so nothing needs to exist yet.
router.post('/notifications/test', async (req, res) => {
  const { name, url } = req.body;
  if (!url) return res.status(400).json({ error: 'Fill in an Apprise URL first.' });
  try {
    await sendTestMessage({ name: name || 'Test channel', url });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Every step's own "Skip" button posts here instead of a plain link, so skipping marks the step
// visited (see markVisited) exactly like a real save does — the checkmark means "you made a
// decision here", not "you happened to submit data".
router.post('/skip-step', (req, res) => {
  const { step, next } = req.body;
  if (STEPS.includes(step)) markVisited(step);
  res.redirect(`/setup?step=${STEPS.includes(next) ? next : 'done'}`);
});

router.post('/finish', (req, res) => {
  markCompleted();
  res.redirect('/');
});

// Reachable from step 1 too ("Skip setup entirely") — marks it done outright rather than walking
// through every step, same end state as clicking Finish on the last one.
router.post('/skip', (req, res) => {
  markCompleted();
  res.redirect('/');
});

module.exports = router;
