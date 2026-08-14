// Builds a single, self-contained diagnostic snapshot — system/version info, recent logs, a
// config-overview (counts + non-secret identifiers), and live connection status — so a support
// conversation (or a future debugging session) can start from "here's everything relevant" instead
// of re-deriving it one manual query/log-tail at a time, the way today's own back-and-forth
// troubleshooting had to. Admin-only (see routes/admin.js's own requireAdmin on this router),
// viewable in the browser and downloadable as one JSON file — same data, two presentations.
const os = require('os');
const db = require('./db');
const mqttClient = require('./mqttClient');
const mosquittoLog = require('./mosquittoLog');
const loxoneWebSocket = require('./loxoneWebSocket');
const { getVersionStatus } = require('./versionCheck');
const packageJson = require('../package.json');

// Never a password/token/secret, ever — this whole module's one hard rule. Usernames are the one
// exception allowed in at all (per an explicit ask, not a default), and only in this partial form:
// first + last character visible, everything between replaced — enough to recognize "yes, that's
// the admin account" without the string being usable as a real credential guess/fill.
function maskUsername(username) {
  if (!username) return username;
  const s = String(username);
  if (s.length <= 2) return s[0] + '*'.repeat(Math.max(s.length - 1, 0));
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
}

async function systemSection() {
  const versionStatus = getVersionStatus();
  const dbInfo = await db.getInfo();
  return {
    loxsuiteVersion: packageJson.version,
    updateAvailable: !!versionStatus.updateAvailable,
    latestKnownVersion: versionStatus.latestVersion || null,
    dbBackend: dbInfo.backend,
    dbVersion: dbInfo.version || null,
    // Host/port/database name only for a network backend — never the password, and dbPath (SQLite)
    // is just a container-internal file path, not a secret either way.
    dbLocation: dbInfo.backend === 'sqlite' ? dbInfo.dbPath : `${dbInfo.host}:${dbInfo.port}/${dbInfo.database}`,
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    processUptimeSeconds: Math.round(process.uptime()),
  };
}

// The three log sources most likely to actually explain "what just happened" — same set
// logs.js's own tabs split the log book into, minus the Loxone-per-Miniserver tab (that one's
// sized per Miniserver already, and rarely the first place a genuinely gateway-side bug shows up).
const REPORT_LOG_SOURCES = ['system', 'mqtt', 'loxone_commands'];

// Unlike the structured fields elsewhere in this report, a log LINE is free text — mosquittoLog.js
// persists a Mosquitto connect line verbatim, e.g. `... as shellyplug-s-ABCDEF (p2, c1, k60,
// u'realusername').`, which would otherwise leak the exact raw MQTT username straight through
// regardless of maskUsername() being applied everywhere else. This is the one reliable, unambiguous
// pattern worth masking in free text — a system-log audit line (e.g. `"admin" created user
// "newuser".`) can still name real usernames in its own prose; there's no similarly safe, generic
// way to redact THAT without also mangling unrelated quoted text (filenames, table names, ...), so
// this deliberately doesn't try.
function redactLogLine(line) {
  return line.replace(/u'([^']*)'/g, (match, username) => `u'${maskUsername(username)}'`);
}

async function recentLogs(limit) {
  const placeholders = REPORT_LOG_SOURCES.map(() => '?').join(', ');
  const rows = await db.prepare(
    `SELECT source, source_label, line, recorded_at FROM log_entries
     WHERE source IN (${placeholders})
     ORDER BY recorded_at DESC LIMIT ?`
  ).all(...REPORT_LOG_SOURCES, limit);
  return rows.reverse().map((r) => ({ ...r, line: redactLogLine(r.line) })); // oldest first — a log reads naturally top-to-bottom
}

// Row counts alone (no row CONTENT beyond a few genuinely non-secret identifiers below) — this
// section exists to catch "you have 40 mappings but only 3 monitors, that mismatch is probably
// it" class config issues, not to dump full configuration.
const COUNTED_TABLES = [
  ['miniservers', 'miniservers'],
  ['mappings_loxone_to_mqtt', 'loxoneToMqttMappings'],
  ['mappings_mqtt_to_loxone', 'mqttToLoxoneMappings'],
  ['monitors', 'monitors'],
  ['custom_dashboards', 'dashboards'],
  ['dashboard_panels', 'dashboardPanels'],
  ['users', 'users'],
  ['access_roles', 'accessRoles'],
  ['notification_rules', 'notificationRules'],
];

async function configOverview() {
  const counts = {};
  for (const [table, key] of COUNTED_TABLES) {
    // Table name is always one of the fixed literals above, never request input — safe to
    // interpolate directly (there's no parameterized-identifier syntax for a FROM clause).
    const row = await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
    counts[key] = row.c;
  }

  const miniservers = await db.prepare(
    `SELECT id, name, host, http_port, udp_port, username, status, last_error, firmware_version, gateway_client_of
     FROM miniservers ORDER BY sort_order, id`
  ).all();

  return {
    counts,
    miniservers: miniservers.map((m) => ({
      name: m.name,
      host: m.host,
      httpPort: m.http_port,
      udpPort: m.udp_port,
      username: maskUsername(m.username),
      configuredStatus: m.status,
      lastError: m.last_error,
      firmwareVersion: m.firmware_version,
      isGatewayClient: !!m.gateway_client_of,
      liveConnection: loxoneWebSocket.getStatus(m.id),
    })),
  };
}

// LoxSuite's own MQTT connections (see routes/incoming.js's own isSystemClient) — noise for a
// support report, not a real device someone's trying to diagnose.
function isSystemClient(clientId) {
  return clientId.startsWith('loxsuite-');
}

function liveStatus() {
  const clients = mosquittoLog.getClients()
    .filter((c) => !isSystemClient(c.clientId))
    .map((c) => ({
      device: c.clientId,
      username: maskUsername(c.username),
      status: c.status,
      connectedAt: c.connectedAt,
      disconnectedAt: c.disconnectedAt,
    }));

  return {
    mqtt: {
      connected: mqttClient.state.connected,
      host: mqttClient.state.host,
      port: mqttClient.state.port,
      ...mqttClient.getStats(),
    },
    connectedDeviceCount: clients.filter((c) => c.status === 'connected').length,
    devices: clients,
  };
}

async function buildReport(logLimit = 200) {
  const [system, config, logs] = await Promise.all([systemSection(), configOverview(), recentLogs(logLimit)]);
  return {
    generatedAt: new Date().toISOString(),
    system,
    config,
    live: liveStatus(),
    recentLogs: logs,
  };
}

module.exports = { buildReport, maskUsername };
