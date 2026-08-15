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
const backup = require('./backup');
const { getVersionStatus } = require('./versionCheck');
const { TABLES } = require('./db/transfer');
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
    `SELECT id, name, host, http_port, udp_port, username, status, last_error, firmware_version,
            gateway_client_of, plc_state, cpu_load, heap_status, num_tasks, device_monitor_status
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
      // The device's own self-reported health, polled separately from the live WebSocket
      // connection below (see startHardwarePolling) — genuinely useful even when the connection
      // itself is fine (e.g. plcState stuck "not ok" points at the Miniserver/PLC, not the gateway).
      plcState: m.plc_state,
      cpuLoad: m.cpu_load,
      heapStatus: m.heap_status,
      numTasks: m.num_tasks,
      deviceMonitorStatus: m.device_monitor_status,
      liveConnection: loxoneWebSocket.getStatus(m.id),
    })),
  };
}

// Whether each Postgres/MySQL table's own id-generator (sequence / AUTO_INCREMENT) still agrees
// with the table's real data — read-only, mirrors (never calls) db/index.js's own
// resyncIdCounter()/execTimed() self-heal. The exact class of bug that caused today's own
// "Internal Server Error" on adding a mapping: the counter falls behind after rows are inserted
// with explicit ids (a SQLite -> Postgres/MySQL transfer does this) without a resync afterward —
// this surfaces it BEFORE the next insert into that specific table hits it, instead of only after.
// SQLite has no separate counter object to fall out of sync in the first place (see TABLES' own
// hasSerialId filter elsewhere), so there's nothing to check there.
async function sequenceHealth() {
  const backendName = db.getBackend();
  if (backendName === 'sqlite') return { applicable: false, issues: [] };

  const issues = [];
  for (const table of TABLES.filter((t) => t.hasSerialId)) {
    const maxRow = await db.prepare(`SELECT MAX(id) AS maxId FROM ${table.name}`).get();
    const maxId = maxRow.maxId;
    if (maxId === null) continue; // empty table — no data for a counter to have fallen behind

    if (backendName === 'mysql') {
      const row = await db.prepare(
        'SELECT AUTO_INCREMENT AS nextValue FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = ?'
      ).get(table.name);
      if (row && row.nextValue !== null && row.nextValue <= maxId) {
        issues.push({ table: table.name, maxId, nextGeneratedId: row.nextValue });
      }
      continue;
    }

    // pg_get_serial_sequence()'s own result is a schema-qualified sequence name Postgres itself
    // generated for this fixed, hardcoded table name (never request input) — safe to interpolate
    // directly below, same reasoning as configOverview()'s own COUNTED_TABLES interpolation above.
    const seqRow = await db.prepare(`SELECT pg_get_serial_sequence(?, 'id') AS seq`).get(table.name);
    if (!seqRow.seq) continue;
    const valRow = await db.prepare(`SELECT last_value FROM ${seqRow.seq}`).get();
    if (Number(valRow.last_value) < maxId) {
      issues.push({ table: table.name, maxId, nextGeneratedId: Number(valRow.last_value) + 1 });
    }
  }
  return { applicable: true, issues };
}

// last_run_at/last_status/last_error (and the rclone equivalents) only — getSettings() also
// decrypts and returns the real rclone.conf contents (rclone_config), deliberately left out here.
// listBackups() itself calls ensureBackupDir() (fs.mkdirSync) as its very first step — exactly the
// call that throws when the process can't create BACKUP_DIR (the non-root CI runner bug fixed
// under 0.18.13), so catching that here doubles as the "is BACKUP_DIR actually writable" check
// without a second, separate probe.
async function backupStatus() {
  const settings = await backup.getSettings();
  let backups = [];
  let backupDirError = null;
  try {
    backups = backup.listBackups();
  } catch (err) {
    backupDirError = err.message;
  }
  return {
    enabled: !!settings.enabled,
    scheduleCron: settings.schedule_cron,
    retentionCount: settings.retention_count,
    lastRunAt: settings.last_run_at,
    lastStatus: settings.last_status,
    lastError: settings.last_error,
    rcloneEnabled: !!settings.rclone_enabled,
    rcloneRemote: settings.rclone_remote,
    rcloneLastRunAt: settings.rclone_last_run_at,
    rcloneLastStatus: settings.rclone_last_status,
    rcloneLastError: settings.rclone_last_error,
    backupDirError,
    backupCount: backups.length,
    mostRecentBackup: backups[0] || null,
  };
}

// Which OPTIONAL features are turned on and how — never the credentials/keys behind them (AI's own
// api_key, SSO's client_secret/issuer_url are all deliberately left out). Exists to catch "you
// think X is on but it isn't" config mistakes at a glance, not to describe how X is configured.
async function featureFlags() {
  const ai = await db.prepare('SELECT enabled, provider, model, effort FROM ai_settings WHERE id = 1').get();
  const sso = await db.prepare('SELECT enabled, local_login_disabled FROM sso_settings WHERE id = 1').get();
  return {
    dbBackend: db.getBackend(),
    aiAssistantEnabled: !!ai?.enabled,
    aiProvider: ai?.enabled ? ai.provider : null,
    aiModel: ai?.enabled ? ai.model : null,
    aiEffort: ai?.enabled ? ai.effort : null,
    ssoEnabled: !!sso?.enabled,
    localLoginDisabled: !!sso?.local_login_disabled,
    trustProxyConfigured: !!process.env.TRUST_PROXY,
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
  const [system, config, logs, sequences, backups, features] = await Promise.all([
    systemSection(),
    configOverview(),
    recentLogs(logLimit),
    sequenceHealth(),
    backupStatus(),
    featureFlags(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    system,
    config,
    live: liveStatus(),
    recentLogs: logs,
    sequenceHealth: sequences,
    backup: backups,
    featureFlags: features,
  };
}

module.exports = { buildReport, maskUsername };
