const express = require('express');
const db = require('../db');
const mqttClient = require('../mqttClient');
const { requirePermission } = require('../middleware/requirePermission');
const { invalidateTimezoneCache } = require('../dateFormat');
const { logSystemEvent } = require('../auditLog');
const { encrypt, decrypt } = require('../secretCrypto');

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const router = express.Router();

function loadSettings() {
  const settings = db.prepare('SELECT * FROM mqtt_settings WHERE id = 1').get();
  // Decrypted here (not left to each caller) since this is shown back in the broker settings
  // form's own password field (settings.ejs) as well as used to actually connect — every reader
  // needs the real value either way, unlike Miniserver/SSO secrets which are never displayed back.
  return settings ? { ...settings, password: decrypt(settings.password) } : settings;
}

function loadGatewaySettings() {
  return db.prepare('SELECT * FROM gateway_settings WHERE id = 1').get();
}

// General app settings — housekeeping knobs that aren't specific to any one feature page (log,
// monitor, and Client Activity retention). One page, one Save button, reached from the account
// menu. MQTT's own connection settings live at /settings/broker instead (see tabs-mqtt-broker.ejs)
// — kept separate since they're a broker concern, not general gateway housekeeping.
// Node's own ICU data — the same source Intl.DateTimeFormat itself validates against — rather
// than a hand-maintained list, so it can never drift out of sync with what's actually valid here.
const TIMEZONES = Intl.supportedValuesOf('timeZone');

router.get('/', (req, res) => {
  res.render('settings-general', { gatewaySettings: loadGatewaySettings(), timezones: TIMEZONES, saved: false, error: null });
});

router.post('/', requirePermission('settings', 'edit'), (req, res) => {
  const logDays = Number(req.body.log_retention_days);
  const monitorDays = Number(req.body.monitor_retention_days);
  const clientHours = Number(req.body.client_retention_hours);
  const notificationDays = Number(req.body.notification_retention_days);
  const healthcheckSeconds = Number(req.body.healthcheck_interval_seconds);
  const timezone = (req.body.display_timezone || '').trim();
  const panelDecimals = Number(req.body.default_panel_decimals);

  if (timezone && !isValidTimezone(timezone)) {
    return res.render('settings-general', { gatewaySettings: loadGatewaySettings(), timezones: TIMEZONES, saved: false, error: `"${timezone}" isn't a recognized timezone name (e.g. "Europe/Amsterdam", "UTC").` });
  }

  if (Number.isFinite(logDays) && logDays > 0) {
    db.prepare('UPDATE gateway_settings SET log_retention_days = ? WHERE id = 1').run(Math.round(logDays));
  }
  if (Number.isFinite(monitorDays) && monitorDays > 0) {
    db.prepare('UPDATE gateway_settings SET monitor_retention_days = ? WHERE id = 1').run(Math.round(monitorDays));
  }
  if (Number.isFinite(clientHours) && clientHours > 0) {
    db.prepare('UPDATE gateway_settings SET client_retention_hours = ? WHERE id = 1').run(Math.round(clientHours));
  }
  if (Number.isFinite(notificationDays) && notificationDays > 0) {
    db.prepare('UPDATE gateway_settings SET notification_retention_days = ? WHERE id = 1').run(Math.round(notificationDays));
  }
  // 10s floor — healthcheck.js's own recursive-setTimeout loop already re-reads this on every
  // tick, so a too-low value here would otherwise let it hammer every configured Miniserver in a
  // tight loop.
  if (Number.isFinite(healthcheckSeconds) && healthcheckSeconds >= 10) {
    db.prepare('UPDATE gateway_settings SET healthcheck_interval_seconds = ? WHERE id = 1').run(Math.round(healthcheckSeconds));
  }
  if (timezone) {
    db.prepare('UPDATE gateway_settings SET display_timezone = ? WHERE id = 1').run(timezone);
    invalidateTimezoneCache();
  }
  if (Number.isFinite(panelDecimals) && panelDecimals >= 0) {
    db.prepare('UPDATE gateway_settings SET default_panel_decimals = ? WHERE id = 1').run(Math.min(6, Math.round(panelDecimals)));
  }
  db.prepare('UPDATE gateway_settings SET dashboard_suggestions_enabled = ? WHERE id = 1').run(req.body.dashboard_suggestions_enabled ? 1 : 0);

  logSystemEvent(`"${req.user.username}" updated general settings.`);
  res.render('settings-general', { gatewaySettings: loadGatewaySettings(), timezones: TIMEZONES, saved: true, error: null });
});

router.get('/broker', (req, res) => {
  res.render('settings', { settings: loadSettings(), gatewaySettings: loadGatewaySettings(), error: null, saved: false });
});

router.post('/broker', requirePermission('settings', 'edit'), (req, res) => {
  const { host, port, username, password, use_tls, auto_create_enabled } = req.body;

  if (!host || !port) {
    return res.render('settings', {
      settings: loadSettings(),
      gatewaySettings: loadGatewaySettings(),
      error: 'Host and port are required.',
      saved: false,
    });
  }

  db.prepare(
    'UPDATE mqtt_settings SET host = ?, port = ?, username = ?, password = ?, use_tls = ? WHERE id = 1'
  ).run(host, Number(port), username || null, encrypt(password) || null, use_tls ? 1 : 0);
  db.prepare('UPDATE gateway_settings SET auto_create_loxone_mappings = ? WHERE id = 1').run(auto_create_enabled ? 1 : 0);

  mqttClient.reconnect();

  logSystemEvent(`"${req.user.username}" updated broker connection settings.`);
  res.render('settings', { settings: loadSettings(), gatewaySettings: loadGatewaySettings(), error: null, saved: true });
});

module.exports = router;
