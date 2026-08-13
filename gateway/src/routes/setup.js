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
const asyncHandler = require('../middleware/asyncHandler');
const { resolveDbConfig } = require('../db/config');
const transfer = require('../db/transfer');
const { getSqliteImportStatus, markResolved: markSqliteImportResolved } = require('../sqliteImportStatus');

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
async function loadVisitedSteps() {
  const row = await db.prepare('SELECT setup_wizard_visited_steps FROM gateway_settings WHERE id = 1').get();
  return (row?.setup_wizard_visited_steps || '').split(',').filter(Boolean);
}

async function markVisited(step) {
  const visited = new Set(await loadVisitedSteps());
  visited.add(step);
  await db.prepare('UPDATE gateway_settings SET setup_wizard_visited_steps = ? WHERE id = 1').run(Array.from(visited).join(','));
}

async function loadMqttSettings() {
  const settings = await db.prepare('SELECT * FROM mqtt_settings WHERE id = 1').get();
  return settings ? { ...settings, password: decrypt(settings.password) } : settings;
}

async function render(req, res, extra = {}) {
  res.render('setup-wizard', {
    step: currentStep(req),
    steps: STEPS,
    visitedSteps: await loadVisitedSteps(),
    timezones: TIMEZONES,
    gatewaySettings: await db.prepare('SELECT * FROM gateway_settings WHERE id = 1').get(),
    miniserverCount: (await db.prepare('SELECT COUNT(*) AS c FROM miniservers').get()).c,
    mqttSettings: await loadMqttSettings(),
    sso: await db.prepare('SELECT * FROM sso_settings WHERE id = 1').get(),
    roles: await db.prepare('SELECT * FROM access_roles ORDER BY name').all(),
    backupSettings: await backup.getSettings(),
    channelCount: (await db.prepare('SELECT COUNT(*) AS c FROM notification_channels').get()).c,
    error: null,
    ...extra,
  });
}

async function markCompleted() {
  await db.prepare('UPDATE gateway_settings SET setup_wizard_completed = 1 WHERE id = 1').run();
}

// The "existing SQLite data found" gate — see sqliteImportStatus.js for when this actually applies
// (a real, already-used SQLite file still sitting at DB_PATH while this install now boots against
// an otherwise-fresh Postgres/MySQL database). Deliberately its own page rather than a step in the
// STEPS wizard above: running the import wholesale-replaces the users table (including whichever
// row the CURRENTLY-logged-in session belongs to), so it can't sensibly be "step 1 of 9" in a flow
// that otherwise assumes the logged-in admin's own identity stays stable across steps — see
// postLoginRedirect() in routes/auth.js, which routes here ahead of the normal wizard whenever this
// applies, on every login (not just the first ever one).
router.get('/import', asyncHandler(async (req, res) => {
  const status = getSqliteImportStatus();
  if (!status.available) return res.redirect('/setup');
  const scan = await transfer.scanSource(status.sqlitePath);
  res.render('setup-import', { sqlitePath: status.sqlitePath, scan, error: null });
}));

router.post('/import/dismiss', asyncHandler(async (req, res) => {
  await markSqliteImportResolved();
  await logSystemEvent(`"${req.user.username}" dismissed the existing-SQLite-data import prompt without importing.`);
  res.redirect('/setup');
}));

// Streamed the same way the AI Assistant's own chat turn is (see routes/aiChat.js) — the response
// body itself IS the live progress log, consumed on the browser side with a plain
// fetch()+ReadableStream reader (see the inline script in setup-import.ejs), not a polling endpoint
// or a new SSE/WebSocket connection this app has never otherwise needed. force:true always — by
// the time this page is reachable at all, the target has already been migrated+seeded with its own
// default roles/admin user (that's exactly what made this install bootable in the first place), so
// "the target already has non-default data" is expected, not a reason to refuse.
router.post('/import/run', asyncHandler(async (req, res) => {
  const status = getSqliteImportStatus();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  if (!status.available) {
    res.write('Nothing to import (already resolved, or no existing SQLite data was found).\n__ERROR__\n');
    return res.end();
  }

  const targetConfig = resolveDbConfig();
  try {
    const { mismatch } = await transfer.runTransfer({
      fromSqlitePath: status.sqlitePath,
      targetConfig,
      backend: targetConfig.backend,
      pruneOrphans: !!req.body.prune_orphans,
      force: true,
      onLog: (line) => res.write(`${line}\n`),
    });
    if (mismatch) {
      res.write('\nFinished with row-count mismatches — see above. Not marking this resolved; you can try again.\n__ERROR__\n');
      return res.end();
    }
    await markSqliteImportResolved();
    await logSystemEvent(`"${req.user.username}" imported existing SQLite data via the setup wizard.`);
    res.write('\n__DONE__\n');
  } catch (err) {
    res.write(`\nImport failed: ${err.message}\n__ERROR__\n`);
  }
  res.end();
}));

router.get('/', asyncHandler(async (req, res) => render(req, res)));

router.post('/password', asyncHandler(async (req, res) => {
  const { new_password: newPassword, confirm_password: confirmPassword } = req.body;
  if (req.user.authProvider !== 'local') return res.redirect('/setup?step=timezone');

  if (newPassword) {
    if (newPassword.length < 8) return render(req, res, { error: 'New password must be at least 8 characters.' });
    if (newPassword !== confirmPassword) return render(req, res, { error: 'New password and confirmation do not match.' });
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
    await logSystemEvent(`"${req.user.username}" changed their password via the setup wizard.`);
  }
  await markVisited('password');
  res.redirect('/setup?step=timezone');
}));

router.post('/timezone', asyncHandler(async (req, res) => {
  const timezone = (req.body.display_timezone || '').trim();
  if (timezone) {
    if (!isValidTimezone(timezone)) return render(req, res, { error: `"${timezone}" isn't a recognized timezone name.` });
    await db.prepare('UPDATE gateway_settings SET display_timezone = ? WHERE id = 1').run(timezone);
    await invalidateTimezoneCache();
  }
  await markVisited('timezone');
  res.redirect('/setup?step=miniserver');
}));

// Same clients_json shape/parsing as the regular Add Miniserver form (routes/miniservers.js's own
// parseClientsJson) — kept as its own copy rather than requiring that file, since setup.js is a
// standalone first-run flow that shouldn't gain a dependency on the day-to-day Miniservers route.
function parseClientsJson(raw) {
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((c) => c && typeof c.name === 'string' && c.name.trim() && typeof c.host === 'string' && c.host.trim())
    .map((c) => ({ name: c.name.trim(), host: c.host.trim(), http_port: Number(c.http_port) || 80, use_https: !!c.use_https }));
}

router.post('/miniserver', asyncHandler(async (req, res) => {
  const { name, host, http_port: httpPort, udp_port: udpPort, username, password, use_https: useHttps, external_url: externalUrl, clients_json: clientsJson } = req.body;
  if (!name && !host && !username && !password) {
    await markVisited('miniserver');
    return res.redirect('/setup?step=mqtt');
  }
  if (!name || !host || !username || !password) {
    return render(req, res, { error: 'Name, host, username and password are all required to add a Miniserver — or leave every field blank to skip this step.' });
  }

  // Same field set as the regular Add Miniserver form (routes/miniservers.js) — UDP port and
  // External URL were missing here even though the wizard's own form already collected them,
  // silently dropping whatever was typed into those two fields.
  const encryptedPassword = encrypt(password);
  const insertMiniserverSql = `INSERT INTO miniservers (name, host, http_port, udp_port, username, password, use_https, external_url, sort_order, gateway_client_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const nextSortOrder0 = (await db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM miniservers').get()).next;
  const gatewayId = await db.insertReturningId(insertMiniserverSql, [
    name, host, Number(httpPort) || 80, udpPort ? Number(udpPort) : null, username, encryptedPassword,
    useHttps ? 1 : 0, externalUrl ? externalUrl.trim().replace(/\/+$/, '') : null, nextSortOrder0, null,
  ]);
  await logSystemEvent(`"${req.user.username}" added Miniserver "${name}" (${host}) via the setup wizard.`);

  // Client Miniservers added inline alongside this one — same "shares the Gateway's own
  // credentials" reasoning as the regular Add Miniserver form (Loxone requires identical
  // credentials across a Gateway/Client group).
  const clients = parseClientsJson(clientsJson);
  const insertedIds = [gatewayId];
  for (let index = 0; index < clients.length; index++) {
    const client = clients[index];
    const clientId = await db.insertReturningId(insertMiniserverSql, [
      client.name, client.host, client.http_port, null, username, encryptedPassword,
      client.use_https ? 1 : 0, null, nextSortOrder0 + index + 1, gatewayId,
    ]);
    insertedIds.push(clientId);
    await logSystemEvent(`"${req.user.username}" added Miniserver "${client.name}" (${client.host}) as a Gateway Client of "${name}" via the setup wizard.`);
  }

  // Same "don't leave it on Unknown" reasoning as the regular Add Miniserver form (routes/miniservers.js).
  const insertedRows = await Promise.all(insertedIds.map((id) => db.prepare('SELECT * FROM miniservers WHERE id = ?').get(id)));
  await Promise.all(insertedRows.map((ms) => checkMiniserver(ms)));

  await markVisited('miniserver');
  res.redirect('/setup?step=mqtt');
}));

router.post('/mqtt', asyncHandler(async (req, res) => {
  const { host, port, username, password, use_tls: useTls } = req.body;
  if (!host || !port) {
    return render(req, res, { error: 'Host and port are required — or leave everything blank to skip this step.' });
  }

  await db.prepare(
    'UPDATE mqtt_settings SET host = ?, port = ?, username = ?, password = ?, use_tls = ? WHERE id = 1'
  ).run(host, Number(port), username || null, encrypt(password) || null, useTls ? 1 : 0);
  await mqttClient.reconnect();
  await logSystemEvent(`"${req.user.username}" updated the MQTT broker connection via the setup wizard.`);
  await markVisited('mqtt');
  res.redirect('/setup?step=sso');
}));

// Ad-hoc test against whatever's currently typed into the form, before it's been saved — same
// one-shot-connection pattern as dynamicSecurity.js's testClientConnection, just fully
// parameterized (host/port too, not only username/password) since nothing's saved yet to fall
// back on.
router.post('/mqtt/test', asyncHandler(async (req, res) => {
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
}));

router.post('/sso', asyncHandler(async (req, res) => {
  const { enabled, issuer_url: issuerUrl, client_id: clientId, client_secret: clientSecret, default_role_id: defaultRoleId } = req.body;

  if (enabled && (!issuerUrl || !clientId)) {
    return render(req, res, { error: 'Issuer URL and Client ID are both required to enable Single Sign-On — or leave Enabled off to skip this step.' });
  }

  // Blank secret = keep whatever's already saved — same convention as Administration -> SSO
  // (routes/admin.js), since the real secret is never sent back down to the browser to re-submit.
  const existing = await db.prepare('SELECT client_secret FROM sso_settings WHERE id = 1').get();
  const newSecret = clientSecret ? encrypt(clientSecret) : existing?.client_secret;

  await db.prepare(
    `UPDATE sso_settings SET enabled = ?, issuer_url = ?, client_id = ?, client_secret = ?, default_role_id = ? WHERE id = 1`
  ).run(enabled ? 1 : 0, issuerUrl || null, clientId || null, newSecret || null, defaultRoleId || null);
  if (enabled) await logSystemEvent(`"${req.user.username}" enabled Single Sign-On via the setup wizard.`);
  await markVisited('sso');
  res.redirect('/setup?step=backup');
}));

router.post('/backup', asyncHandler(async (req, res) => {
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
  const current = await backup.getSettings();
  await backup.updateSettings({
    enabled: !!enabled,
    schedule_cron: enabled ? scheduleCron : current.schedule_cron,
    retention_count: enabled ? Math.round(Number(retentionCount)) : current.retention_count,
    rclone_enabled: !!rcloneEnabled,
    rclone_remote: (rcloneRemote || '').trim(),
    rclone_config: rcloneConfig || '',
  });
  await backup.rescheduleFromSettings();
  if (enabled || rcloneEnabled) await logSystemEvent(`"${req.user.username}" configured backups via the setup wizard.`);
  await markVisited('backup');
  res.redirect('/setup?step=notifications');
}));

router.post('/notifications', asyncHandler(async (req, res) => {
  const { name, url } = req.body;
  if (!name && !url) {
    await markVisited('notifications');
    return res.redirect('/setup?step=done');
  }
  if (!name || !url) {
    return render(req, res, { error: 'Channel name and Apprise URL are both required to add a channel — or leave both blank to skip this step.' });
  }
  await db.prepare('INSERT INTO notification_channels (name, url, enabled, created_at) VALUES (?, ?, 1, ?)')
    .run(name.trim(), url.trim(), new Date().toISOString());
  await logSystemEvent(`"${req.user.username}" added notification channel "${name}" via the setup wizard.`);
  await markVisited('notifications');
  res.redirect('/setup?step=done');
}));

// Ad-hoc test against whatever's currently typed into the form, before anything's been saved —
// same reasoning as POST /miniserver's own /miniservers/test. sendTestMessage() only ever needs
// {name, url} (see notifications.js), not a real saved channel row, so nothing needs to exist yet.
router.post('/notifications/test', asyncHandler(async (req, res) => {
  const { name, url } = req.body;
  if (!url) return res.status(400).json({ error: 'Fill in an Apprise URL first.' });
  try {
    await sendTestMessage({ name: name || 'Test channel', url });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}));

// Every step's own "Skip" button posts here instead of a plain link, so skipping marks the step
// visited (see markVisited) exactly like a real save does — the checkmark means "you made a
// decision here", not "you happened to submit data".
router.post('/skip-step', asyncHandler(async (req, res) => {
  const { step, next } = req.body;
  if (STEPS.includes(step)) await markVisited(step);
  res.redirect(`/setup?step=${STEPS.includes(next) ? next : 'done'}`);
}));

router.post('/finish', asyncHandler(async (req, res) => {
  await markCompleted();
  res.redirect('/');
}));

// Reachable from step 1 too ("Skip setup entirely") — marks it done outright rather than walking
// through every step, same end state as clicking Finish on the last one.
router.post('/skip', asyncHandler(async (req, res) => {
  await markCompleted();
  res.redirect('/');
}));

module.exports = router;
