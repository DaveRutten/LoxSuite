const express = require('express');
const db = require('../db');
const mqttClient = require('../mqttClient');
const { requirePermission } = require('../middleware/requirePermission');
const { invalidateTimezoneCache } = require('../dateFormat');
const { logSystemEvent } = require('../auditLog');
const { encrypt, decrypt } = require('../secretCrypto');
const { getAllDistinctStateNames } = require('../loxoneStructure');
const asyncHandler = require('../middleware/asyncHandler');

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const router = express.Router();

async function loadSettings() {
  const settings = await db.prepare('SELECT * FROM mqtt_settings WHERE id = 1').get();
  // Decrypted here (not left to each caller) since this is shown back in the broker settings
  // form's own password field (settings.ejs) as well as used to actually connect — every reader
  // needs the real value either way, unlike Miniserver/SSO secrets which are never displayed back.
  return settings ? { ...settings, password: decrypt(settings.password) } : settings;
}

async function loadGatewaySettings() {
  return db.prepare('SELECT * FROM gateway_settings WHERE id = 1').get();
}

// General app settings — housekeeping knobs that aren't specific to any one feature page (log,
// monitor, and Client Activity retention). One page, one Save button, reached from the account
// menu. MQTT's own connection settings live at /settings/broker instead (see tabs-mqtt-broker.ejs)
// — kept separate since they're a broker concern, not general gateway housekeeping.
// Node's own ICU data — the same source Intl.DateTimeFormat itself validates against — rather
// than a hand-maintained list, so it can never drift out of sync with what's actually valid here.
const TIMEZONES = Intl.supportedValuesOf('timeZone');

router.get('/', asyncHandler(async (req, res) => {
  res.render('settings-general', { gatewaySettings: await loadGatewaySettings(), timezones: TIMEZONES, saved: false, error: null });
}));

router.post('/', requirePermission('settings', 'edit'), asyncHandler(async (req, res) => {
  const logDays = Number(req.body.log_retention_days);
  const monitorDays = Number(req.body.monitor_retention_days);
  const clientHours = Number(req.body.client_retention_hours);
  const notificationDays = Number(req.body.notification_retention_days);
  const healthcheckSeconds = Number(req.body.healthcheck_interval_seconds);
  const timezone = (req.body.display_timezone || '').trim();
  const panelDecimals = Number(req.body.default_panel_decimals);

  if (timezone && !isValidTimezone(timezone)) {
    return res.render('settings-general', { gatewaySettings: await loadGatewaySettings(), timezones: TIMEZONES, saved: false, error: `"${timezone}" isn't a recognized timezone name (e.g. "Europe/Amsterdam", "UTC").` });
  }

  if (Number.isFinite(logDays) && logDays > 0) {
    await db.prepare('UPDATE gateway_settings SET log_retention_days = ? WHERE id = 1').run(Math.round(logDays));
  }
  if (Number.isFinite(monitorDays) && monitorDays > 0) {
    await db.prepare('UPDATE gateway_settings SET monitor_retention_days = ? WHERE id = 1').run(Math.round(monitorDays));
  }
  if (Number.isFinite(clientHours) && clientHours > 0) {
    await db.prepare('UPDATE gateway_settings SET client_retention_hours = ? WHERE id = 1').run(Math.round(clientHours));
  }
  if (Number.isFinite(notificationDays) && notificationDays > 0) {
    await db.prepare('UPDATE gateway_settings SET notification_retention_days = ? WHERE id = 1').run(Math.round(notificationDays));
  }
  // 10s floor — healthcheck.js's own recursive-setTimeout loop already re-reads this on every
  // tick, so a too-low value here would otherwise let it hammer every configured Miniserver in a
  // tight loop.
  if (Number.isFinite(healthcheckSeconds) && healthcheckSeconds >= 10) {
    await db.prepare('UPDATE gateway_settings SET healthcheck_interval_seconds = ? WHERE id = 1').run(Math.round(healthcheckSeconds));
  }
  if (timezone) {
    await db.prepare('UPDATE gateway_settings SET display_timezone = ? WHERE id = 1').run(timezone);
    await invalidateTimezoneCache();
  }
  if (Number.isFinite(panelDecimals) && panelDecimals >= 0) {
    await db.prepare('UPDATE gateway_settings SET default_panel_decimals = ? WHERE id = 1').run(Math.min(6, Math.round(panelDecimals)));
  }
  await db.prepare('UPDATE gateway_settings SET dashboard_suggestions_enabled = ? WHERE id = 1').run(req.body.dashboard_suggestions_enabled ? 1 : 0);
  await db.prepare('UPDATE gateway_settings SET monitor_chart_downsample_enabled = ? WHERE id = 1').run(req.body.monitor_chart_downsample_enabled ? 1 : 0);

  // One state name per line — plain textarea rather than individual add/remove rows, since this
  // is a short, infrequently-edited list. Always overwritten (not skipped when empty) so clearing
  // every line and saving actually clears the setting, unlike the numeric fields above which treat
  // "didn't parse" as "leave it alone".
  const hiddenStates = String(req.body.live_data_hidden_states || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  await db.prepare('UPDATE gateway_settings SET live_data_hidden_states = ? WHERE id = 1').run(JSON.stringify(hiddenStates));

  // The one per-user field on this otherwise gateway-wide page (see settings-general.ejs's own
  // "Table preferences" card) — still saved against THIS user's own row, not gateway_settings.
  const pageSizeRaw = Number(req.body.table_page_size);
  const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw >= 5 && pageSizeRaw <= 500 ? pageSizeRaw : null;
  await db.prepare('UPDATE users SET table_page_size = ? WHERE id = ?').run(pageSize, req.user.id);

  await logSystemEvent(`"${req.user.username}" updated general settings.`);
  res.render('settings-general', { gatewaySettings: await loadGatewaySettings(), timezones: TIMEZONES, saved: true, error: null });
}));

// Backs the "Hidden state names" field's autocomplete (settings-general.ejs) — every distinct
// state-name key across every configured Miniserver's structure, so picking one to hide (or to
// un-hide) doesn't mean guessing the exact spelling Loxone itself uses (e.g. "jLocked", not
// "jlocked" or "locked"). Read-only, no permission gate beyond this router's own settings/view.
router.get('/live-data-state-names', asyncHandler(async (req, res) => {
  const miniservers = await db.prepare('SELECT * FROM miniservers').all();
  const names = await getAllDistinctStateNames(miniservers);
  res.json({ names });
}));

router.get('/broker', asyncHandler(async (req, res) => {
  res.render('settings', { settings: await loadSettings(), gatewaySettings: await loadGatewaySettings(), error: null, saved: false, mqttConnected: mqttClient.state.connected });
}));

router.post('/broker', requirePermission('settings', 'edit'), asyncHandler(async (req, res) => {
  const { host, port, username, password, use_tls, auto_create_enabled, auto_scope_device_roles_enabled } = req.body;

  if (!host || !port) {
    return res.render('settings', {
      settings: await loadSettings(),
      gatewaySettings: await loadGatewaySettings(),
      error: 'Host and port are required.',
      saved: false,
      mqttConnected: mqttClient.state.connected,
    });
  }

  await db.prepare(
    'UPDATE mqtt_settings SET host = ?, port = ?, username = ?, password = ?, use_tls = ? WHERE id = 1'
  ).run(host, Number(port), username || null, encrypt(password) || null, use_tls ? 1 : 0);
  await db.prepare('UPDATE gateway_settings SET auto_create_loxone_mappings = ? WHERE id = 1').run(auto_create_enabled ? 1 : 0);
  await db.prepare('UPDATE gateway_settings SET auto_scope_device_roles = ? WHERE id = 1').run(auto_scope_device_roles_enabled ? 1 : 0);

  await mqttClient.reconnect();

  await logSystemEvent(`"${req.user.username}" updated broker connection settings.`);
  res.render('settings', { settings: await loadSettings(), gatewaySettings: await loadGatewaySettings(), error: null, saved: true, mqttConnected: mqttClient.state.connected });
}));

module.exports = router;
