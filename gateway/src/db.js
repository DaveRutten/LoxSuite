const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { AREAS, LOG_AREAS } = require('./permissionAreas');
const { encrypt, isEncrypted } = require('./secretCrypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'gateway.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// A restore staged via the Administration > Backups page (see backup.js's stageRestore()) can't
// swap the live database out from under this module's already-open connection, so it just drops
// the replacement file next to it and waits — this is the other half of that handoff, run once at
// startup before anything opens DB_PATH for real. Same restart-to-apply model as the MQTT
// dynamic-security.json restore, which mosquitto only re-reads on its own restart.
const PENDING_RESTORE_PATH = `${DB_PATH}.restore`;
if (fs.existsSync(PENDING_RESTORE_PATH)) {
  fs.renameSync(PENDING_RESTORE_PATH, DB_PATH);
  console.log(`Applied a staged database restore from ${PENDING_RESTORE_PATH}.`);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Logs any query taking longer than this to the System log — "sometimes slow" reports (e.g. on
// Unraid, where a query can stall on array spin-up or shfs overhead depending on how appdata is
// mapped) are otherwise near-impossible to diagnose remotely; this turns "it happened again" into
// "here's which statement and how long, and when." Wraps db.prepare() only (not db.exec(), used
// for schema/migrations throughout the rest of this file) — real user-facing queries everywhere
// else in the app go through .prepare(), so this one wrapper, installed before anything else in
// the app ever requires this module, covers all of them for free. SQL text is truncated in the log
// line; a threshold this high only ever fires on a genuine stall, where which statement and how
// long matter far more than the exact bound values.
const SLOW_QUERY_MS = 200;
const rawPrepare = db.prepare.bind(db);
let slowQueryLogStmt = null;
function logSlowQuery(sql, durationMs) {
  try {
    // Lazily prepared and cached on first successful use — log_entries doesn't exist yet the very
    // first times this could fire, while this same file is still creating its own tables below.
    if (!slowQueryLogStmt) {
      slowQueryLogStmt = rawPrepare('INSERT INTO log_entries (source, source_label, line, recorded_at) VALUES (?, ?, ?, ?)');
    }
    slowQueryLogStmt.run('system', null, `Slow query (${durationMs}ms): ${sql.replace(/\s+/g, ' ').trim().slice(0, 200)}`, new Date().toISOString());
  } catch (err) { /* log_entries not created yet — this same slow prepare() gets logged once it exists */ }
}
db.prepare = function (sql) {
  const stmt = rawPrepare(sql);
  ['all', 'get', 'run', 'iterate'].forEach((method) => {
    const original = stmt[method];
    stmt[method] = function (...args) {
      const start = Date.now();
      try {
        return original.apply(stmt, args);
      } finally {
        const duration = Date.now() - start;
        if (duration >= SLOW_QUERY_MS) logSlowQuery(sql, duration);
      }
    };
  });
  return stmt;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS miniservers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    http_port INTEGER NOT NULL DEFAULT 80,
    udp_port INTEGER,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    last_success_at TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS mappings_mqtt_to_loxone (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    miniserver_id INTEGER NOT NULL REFERENCES miniservers(id) ON DELETE CASCADE,
    mqtt_topic TEXT NOT NULL,
    transport TEXT NOT NULL DEFAULT 'http' CHECK (transport IN ('http', 'udp')),
    target TEXT NOT NULL,
    value_transform TEXT NOT NULL DEFAULT 'passthrough' CHECK (value_transform IN ('passthrough', 'bool_on_off', 'json_path')),
    transform_arg TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS mappings_loxone_to_mqtt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    miniserver_id INTEGER REFERENCES miniservers(id) ON DELETE SET NULL,
    token TEXT UNIQUE NOT NULL,
    mqtt_topic TEXT NOT NULL,
    qos INTEGER NOT NULL DEFAULT 0 CHECK (qos IN (0, 1, 2)),
    retain INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS mqtt_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 1883,
    username TEXT,
    password TEXT,
    use_tls INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS mapping_translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id INTEGER NOT NULL REFERENCES mappings_mqtt_to_loxone(id) ON DELETE CASCADE,
    match_value TEXT NOT NULL,
    output_value TEXT NOT NULL,
    UNIQUE (mapping_id, match_value)
  );

  CREATE TABLE IF NOT EXISTS dashboard_widgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    widget_type TEXT NOT NULL DEFAULT 'topic_value',
    title TEXT,
    topic TEXT,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS loxone_mapping_translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id INTEGER NOT NULL REFERENCES mappings_loxone_to_mqtt(id) ON DELETE CASCADE,
    match_value TEXT NOT NULL,
    output_value TEXT NOT NULL,
    UNIQUE (mapping_id, match_value)
  );

  CREATE TABLE IF NOT EXISTS gateway_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    auto_create_loxone_mappings INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_table_prefs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    table_key TEXT NOT NULL,
    column_order TEXT,
    hidden_columns TEXT,
    PRIMARY KEY (user_id, table_key)
  );

  -- Collapsed/expanded state of each sidebar section (see partials/head.ejs), per user so it
  -- follows them across devices/browsers — same rationale as user_table_prefs above.
  CREATE TABLE IF NOT EXISTS user_nav_prefs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    section_key TEXT NOT NULL,
    collapsed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, section_key)
  );

  CREATE TABLE IF NOT EXISTS monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL CHECK (source_type IN ('mqtt', 'loxone')),
    label TEXT NOT NULL,
    mqtt_topic TEXT,
    miniserver_id INTEGER REFERENCES miniservers(id) ON DELETE CASCADE,
    loxone_uuid TEXT,
    poll_interval_ms INTEGER NOT NULL DEFAULT 10000,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS monitor_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    recorded_at TEXT NOT NULL,
    value TEXT NOT NULL,
    numeric_value REAL
  );
  CREATE INDEX IF NOT EXISTS idx_monitor_history_monitor_time ON monitor_history(monitor_id, recorded_at);

  CREATE TABLE IF NOT EXISTS custom_dashboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dashboard_panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dashboard_id INTEGER NOT NULL REFERENCES custom_dashboards(id) ON DELETE CASCADE,
    panel_type TEXT NOT NULL CHECK (panel_type IN ('chart', 'table', 'value')),
    title TEXT,
    range TEXT NOT NULL DEFAULT '24h',
    size TEXT NOT NULL DEFAULT 'medium' CHECK (size IN ('small', 'medium', 'large')),
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS dashboard_panel_monitors (
    panel_id INTEGER NOT NULL REFERENCES dashboard_panels(id) ON DELETE CASCADE,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (panel_id, monitor_id)
  );

  -- One "house style" template per (dashboard, panel_type) — shared by every editor of that
  -- SPECIFIC dashboard, not global across every dashboard in the install (a chart's "look" on the
  -- home Dashboard doesn't have to match one on someone's personal board). config is the same
  -- shape buildConfig() (routes/dashboards.js) produces EXCEPT its series/value_series keys: those
  -- are normally keyed by monitor id, which a reusable template can't know in advance, so this
  -- stores them as seriesByPosition (an array ordered by monitor POSITION instead) — "Save as
  -- default" converts a real panel's id-keyed series into that array using its own current monitor
  -- order, and "Reset to default" does the reverse for whichever panel it's applied to, using THAT
  -- panel's own monitor order. See panelTypeDefaults.js.
  CREATE TABLE IF NOT EXISTS panel_type_defaults (
    dashboard_id INTEGER NOT NULL REFERENCES custom_dashboards(id) ON DELETE CASCADE,
    panel_type TEXT NOT NULL,
    config TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (dashboard_id, panel_type)
  );

  -- A personal dashboard (custom_dashboards.user_id = its owner) shared with one or more other
  -- users, each with their own viewer/editor grant — separate from the one shared user_id IS NULL
  -- home Dashboard above, which is already visible to everyone via the 'dashboard' Access Role
  -- instead of a per-user row here.
  CREATE TABLE IF NOT EXISTS dashboard_shares (
    dashboard_id INTEGER NOT NULL REFERENCES custom_dashboards(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    can_edit INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dashboard_id, user_id)
  );

  -- Same idea as dashboard_shares above, but grants everyone in an Access Role (see
  -- permissionAreas.js) at once instead of one user at a time — adding this is restricted to
  -- admins (see dashboards.js), since it hands out access to a whole group in one step rather
  -- than a single person the owner presumably already trusts individually.
  CREATE TABLE IF NOT EXISTS dashboard_role_shares (
    dashboard_id INTEGER NOT NULL REFERENCES custom_dashboards(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES access_roles(id) ON DELETE CASCADE,
    can_edit INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dashboard_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS log_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('mqtt', 'loxone')),
    source_id INTEGER,
    source_label TEXT,
    line TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_log_entries_source_time ON log_entries(source, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_log_entries_source_id ON log_entries(source_id);

  CREATE TABLE IF NOT EXISTS access_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS access_role_permissions (
    role_id INTEGER NOT NULL REFERENCES access_roles(id) ON DELETE CASCADE,
    area TEXT NOT NULL,
    can_view INTEGER NOT NULL DEFAULT 0,
    can_edit INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (role_id, area)
  );

  CREATE TABLE IF NOT EXISTS sso_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    issuer_url TEXT,
    client_id TEXT,
    client_secret TEXT,
    default_role_id INTEGER REFERENCES access_roles(id) ON DELETE SET NULL,
    button_label TEXT NOT NULL DEFAULT 'Pocket ID'
  );
`);

db.prepare('INSERT OR IGNORE INTO gateway_settings (id, auto_create_loxone_mappings) VALUES (1, 0)').run();

function migrateMiniserverStatusColumns() {
  const columns = db.prepare('PRAGMA table_info(miniservers)').all().map((c) => c.name);
  if (!columns.includes('status')) {
    db.exec("ALTER TABLE miniservers ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!columns.includes('last_checked_at')) {
    db.exec('ALTER TABLE miniservers ADD COLUMN last_checked_at TEXT');
  }
  if (!columns.includes('use_https')) {
    db.exec('ALTER TABLE miniservers ADD COLUMN use_https INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.includes('external_url')) {
    // Full base URL (e.g. "https://myhome.dyndns.org:8080" or a Loxone DNS address) reachable
    // from outside the local network. Optional — when set, HTTP calls to this Miniserver fall
    // back to it if the local host/port can't be reached, so the same Miniserver stays usable
    // both at home and remotely without switching configuration.
    db.exec('ALTER TABLE miniservers ADD COLUMN external_url TEXT');
  }
  if (!columns.includes('firmware_version')) {
    // Populated from /jdev/cfg/version whenever a healthcheck finds the Miniserver online (see
    // checkMiniserver in healthcheck.js) — left NULL until the first successful check. Was
    // originally read from LoxAPP3.json's msInfo.swVersion, which turned out to not exist at all
    // on at least one real Miniserver's structure file (confirmed by direct inspection) — always
    // silently null there regardless of how long it ran. /jdev/cfg/version is a dedicated,
    // verified-working command instead of relying on a structure field that isn't guaranteed present.
    db.exec('ALTER TABLE miniservers ADD COLUMN firmware_version TEXT');
  }
  if (!columns.includes('device_monitor_status')) {
    // Superseded by plc_state below — msInfo.deviceMonitor's value ("0" on a healthy Miniserver)
    // had no official documentation of what any other value would mean, unlike the PLC state
    // command's fully enumerated, documented 0-8 states. Column kept (unused) rather than dropped
    // — SQLite ALTER TABLE DROP COLUMN support varies by version, and an unused TEXT column costs
    // nothing to leave in place.
    db.exec('ALTER TABLE miniservers ADD COLUMN device_monitor_status TEXT');
  }
  if (!columns.includes('plc_state')) {
    // /jdev/sps/state — the Miniserver's own PLC run state, one of 8 fully documented values (0
    // no status, 1 booting, 2 program loaded, 3 started, 4 Loxone Link started, 5 running, 6
    // change in progress, 7 error, 8 update occurring). Read fresh every healthcheck sweep, not
    // cached/derived from the structure file — a single direct command, nothing else needed.
    db.exec('ALTER TABLE miniservers ADD COLUMN plc_state TEXT');
  }
  if (!columns.includes('cpu_load')) {
    // /jdev/sys/cpu, /jdev/sys/heap, /jdev/sys/numtasks, /jdev/cfg/versiondate — undocumented in
    // Loxone's own official HTTP command reference, but real, working commands on real firmware
    // (verified directly against a live Miniserver, not assumed). heap_status is kept as the raw
    // "used/totalkB" string the Miniserver itself returns rather than split into two columns —
    // Loxone doesn't document whether the first number is free or used memory, so this shows
    // exactly what the Miniserver said instead of asserting an interpretation that might be backwards.
    db.exec('ALTER TABLE miniservers ADD COLUMN cpu_load TEXT');
    db.exec('ALTER TABLE miniservers ADD COLUMN heap_status TEXT');
    db.exec('ALTER TABLE miniservers ADD COLUMN num_tasks TEXT');
    db.exec('ALTER TABLE miniservers ADD COLUMN firmware_date TEXT');
  }
  if (!columns.includes('update_level')) {
    // jdev/cfg/updatelevel — which release channel this Miniserver tracks (e.g. "Alpha" vs the
    // stable channel), read on demand from the Miniservers page's "Check for update" button
    // (routes/miniservers.js), not on every 60s healthcheck sweep — it essentially never changes
    // day to day, unlike firmware_version/cpu_load/etc. above.
    db.exec('ALTER TABLE miniservers ADD COLUMN update_level TEXT');
  }
  if (!columns.includes('miniserver_type')) {
    // msInfo.miniserverType from /data/LoxAPP3.json's structure file — confirmed against Loxone's
    // own official Structure File documentation (V17.0): 0 Miniserver Gen 1, 1 Miniserver Go Gen 1,
    // 2 Miniserver Gen 2, 3 Miniserver Go Gen 2, 4 Miniserver Compact (see format.js's
    // miniserverGenerationLabel). Unlike firmware_version/cpu_load/etc., a physical device's
    // generation never changes, so healthcheck.js only ever fetches this once (while it's still
    // NULL here) rather than on every sweep.
    db.exec('ALTER TABLE miniservers ADD COLUMN miniserver_type INTEGER');
  }
}

migrateMiniserverStatusColumns();

function migrateLoxoneToMqttTransport() {
  const columns = db.prepare('PRAGMA table_info(mappings_loxone_to_mqtt)').all().map((c) => c.name);
  if (!columns.includes('transport')) {
    db.exec("ALTER TABLE mappings_loxone_to_mqtt ADD COLUMN transport TEXT NOT NULL DEFAULT 'http'");
  }
  if (!columns.includes('value_transform')) {
    db.exec("ALTER TABLE mappings_loxone_to_mqtt ADD COLUMN value_transform TEXT NOT NULL DEFAULT 'passthrough'");
  }
  // Holds the sub-mode for value_transform='shelly_rgbw' ('white'/'rgb'/'tunablew' — see
  // applyLoxoneToMqttTransform in loxone.js) — this table never had its own transform_arg column
  // the way mappings_mqtt_to_loxone's json_path transform does, since passthrough/translation_table
  // (the only two transforms that existed here before) never needed one.
  if (!columns.includes('transform_arg')) {
    db.exec('ALTER TABLE mappings_loxone_to_mqtt ADD COLUMN transform_arg TEXT');
  }
}

migrateLoxoneToMqttTransport();

// SQLite can't alter a CHECK constraint or add a NOT NULL column with a
// non-constant default via ALTER TABLE, so widening value_transform's allowed
// values and adding min_interval_ms requires rebuilding the table.
function migrateMqttToLoxoneExtensions() {
  const tableSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mappings_mqtt_to_loxone'"
  ).get();
  if (!tableSql || tableSql.sql.includes('translation_table')) return;

  db.exec(`
    CREATE TABLE mappings_mqtt_to_loxone_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      miniserver_id INTEGER NOT NULL REFERENCES miniservers(id) ON DELETE CASCADE,
      mqtt_topic TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'http' CHECK (transport IN ('http', 'udp')),
      target TEXT NOT NULL,
      value_transform TEXT NOT NULL DEFAULT 'passthrough' CHECK (value_transform IN ('passthrough', 'bool_on_off', 'json_path', 'translation_table')),
      transform_arg TEXT,
      min_interval_ms INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    INSERT INTO mappings_mqtt_to_loxone_new
      (id, miniserver_id, mqtt_topic, transport, target, value_transform, transform_arg, enabled)
    SELECT id, miniserver_id, mqtt_topic, transport, target, value_transform, transform_arg, enabled
    FROM mappings_mqtt_to_loxone;

    DROP TABLE mappings_mqtt_to_loxone;
    ALTER TABLE mappings_mqtt_to_loxone_new RENAME TO mappings_mqtt_to_loxone;
  `);
  console.log('Migrated mappings_mqtt_to_loxone: added translation_table transform + min_interval_ms.');
}

migrateMqttToLoxoneExtensions();

// Panels moved from a fixed small/medium/large size to free-form drag-to-resize grid units, which
// needs a different CHECK'd column shape entirely.
function migrateDashboardPanelSizing() {
  const columns = db.prepare('PRAGMA table_info(dashboard_panels)').all().map((c) => c.name);
  if (columns.includes('col_span')) return;

  db.exec(`
    CREATE TABLE dashboard_panels_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dashboard_id INTEGER NOT NULL REFERENCES custom_dashboards(id) ON DELETE CASCADE,
      panel_type TEXT NOT NULL CHECK (panel_type IN ('chart', 'table', 'value')),
      title TEXT,
      range TEXT NOT NULL DEFAULT '24h',
      col_span INTEGER NOT NULL DEFAULT 4,
      row_span INTEGER NOT NULL DEFAULT 3,
      position INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO dashboard_panels_new (id, dashboard_id, panel_type, title, range, col_span, row_span, position)
    SELECT id, dashboard_id, panel_type, title, range,
      CASE size WHEN 'small' THEN 3 WHEN 'large' THEN 6 ELSE 4 END,
      CASE size WHEN 'large' THEN 4 ELSE 3 END,
      position
    FROM dashboard_panels;

    DROP TABLE dashboard_panels;
    ALTER TABLE dashboard_panels_new RENAME TO dashboard_panels;
  `);
  console.log('Migrated dashboard_panels: size enum -> free col_span/row_span grid units.');
}

migrateDashboardPanelSizing();

// Three new panel types (gauge, stat_delta, threshold) plus a layout option on the existing
// `value` type — CHECK'd column, another rebuild. A flexible `config` JSON column holds every
// type-specific setting instead of a growing pile of nullable columns (see permissionAreas.js's
// module for the same "one shared shape" instinct applied to a different problem).
function migrateDashboardPanelConfig() {
  const columns = db.prepare('PRAGMA table_info(dashboard_panels)').all().map((c) => c.name);
  if (columns.includes('config')) return;

  db.exec(`
    CREATE TABLE dashboard_panels_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dashboard_id INTEGER NOT NULL REFERENCES custom_dashboards(id) ON DELETE CASCADE,
      panel_type TEXT NOT NULL CHECK (panel_type IN ('chart', 'table', 'value', 'gauge', 'stat_delta', 'threshold')),
      title TEXT,
      range TEXT NOT NULL DEFAULT '24h',
      config TEXT NOT NULL DEFAULT '{}',
      col_span INTEGER NOT NULL DEFAULT 4,
      row_span INTEGER NOT NULL DEFAULT 3,
      position INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO dashboard_panels_new (id, dashboard_id, panel_type, title, range, col_span, row_span, position)
    SELECT id, dashboard_id, panel_type, title, range, col_span, row_span, position
    FROM dashboard_panels;

    DROP TABLE dashboard_panels;
    ALTER TABLE dashboard_panels_new RENAME TO dashboard_panels;
  `);
  console.log('Migrated dashboard_panels: added gauge/stat_delta/threshold panel types + config column.');
}

migrateDashboardPanelConfig();

// The home Dashboard is being unified with My Dashboards: it becomes one ordinary
// `custom_dashboards` row with no owner (shared, editable by anyone with the `dashboard` Access
// Role area) instead of a second, parallel widget system. A dashboard row needs to be ownerless,
// which the current NOT NULL user_id doesn't allow — same rebuild pattern as every other widening
// migration above.
function migrateCustomDashboardsNullableUser() {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'custom_dashboards'").get();
  if (!tableSql || !tableSql.sql.includes('NOT NULL REFERENCES users')) return;

  db.exec(`
    CREATE TABLE custom_dashboards_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    INSERT INTO custom_dashboards_new (id, user_id, name, position, created_at)
    SELECT id, user_id, name, position, created_at FROM custom_dashboards;

    DROP TABLE custom_dashboards;
    ALTER TABLE custom_dashboards_new RENAME TO custom_dashboards;
  `);
  console.log('Migrated custom_dashboards: user_id is now nullable (NULL = the shared home Dashboard).');
}

migrateCustomDashboardsNullableUser();

// One-time conversion of the old dashboard_widgets (raw-topic, current-value-only) system into the
// new shared dashboard's panels (any of the 6 panel types, backed by `monitors` for history).
// Existing widgets become `value` panels bound to a newly-created matching monitor each, preserving
// title and order. Guarded on dashboard_widgets still existing — it's dropped at the end, so its
// absence is proof this already ran.
function migrateDashboardWidgetsToSharedPanels() {
  const stillExists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_widgets'").get();
  if (!stillExists) return;

  let sharedDashboard = db.prepare('SELECT * FROM custom_dashboards WHERE user_id IS NULL LIMIT 1').get();
  if (!sharedDashboard) {
    const result = db.prepare('INSERT INTO custom_dashboards (user_id, name, position, created_at) VALUES (NULL, ?, 0, ?)')
      .run('Dashboard', new Date().toISOString());
    sharedDashboard = { id: result.lastInsertRowid };
  }

  const widgets = db.prepare('SELECT * FROM dashboard_widgets ORDER BY position').all();
  const findMonitor = db.prepare("SELECT id FROM monitors WHERE source_type = 'mqtt' AND mqtt_topic = ?");
  const insertMonitor = db.prepare(
    "INSERT INTO monitors (source_type, label, mqtt_topic, enabled, created_at) VALUES ('mqtt', ?, ?, 1, ?)"
  );
  const insertPanel = db.prepare(
    `INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, col_span, row_span, position)
     VALUES (?, 'value', ?, '24h', '{"layout":"stacked"}', 4, 3, ?)`
  );
  const insertLink = db.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, 0)');

  const convertAll = db.transaction(() => {
    widgets.forEach((widget, index) => {
      const existingMonitor = findMonitor.get(widget.topic);
      const monitorId = existingMonitor
        ? existingMonitor.id
        : insertMonitor.run(widget.title || widget.topic, widget.topic, new Date().toISOString()).lastInsertRowid;

      const panelResult = insertPanel.run(sharedDashboard.id, widget.title || widget.topic, index);
      insertLink.run(panelResult.lastInsertRowid, monitorId);
    });

    db.exec('DROP TABLE dashboard_widgets');
  });
  convertAll();

  if (widgets.length > 0) console.log(`Migrated ${widgets.length} dashboard widget(s) into shared Dashboard panels.`);
}

migrateDashboardWidgetsToSharedPanels();

function migrateMonitorRetentionSetting() {
  const columns = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
  if (!columns.includes('monitor_retention_days')) {
    db.exec('ALTER TABLE gateway_settings ADD COLUMN monitor_retention_days INTEGER NOT NULL DEFAULT 30');
  }
}

migrateMonitorRetentionSetting();

function migrateLogRetentionSetting() {
  const columns = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
  if (!columns.includes('log_retention_days')) {
    db.exec('ALTER TABLE gateway_settings ADD COLUMN log_retention_days INTEGER NOT NULL DEFAULT 14');
  }
}

migrateLogRetentionSetting();

// Access Roles (view/edit permissions per page) and Pocket ID SSO both need `users` to support a
// nullable password (SSO-only accounts have none) and a role reference — SQLite can't relax a
// NOT NULL or add a REFERENCES column via ALTER TABLE, so this rebuilds the table like every other
// widening migration above.
function migrateUsersForRolesAndSso() {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (columns.includes('role_id')) return;

  db.exec(`
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      role_id INTEGER REFERENCES access_roles(id) ON DELETE SET NULL,
      auth_provider TEXT NOT NULL DEFAULT 'local',
      sso_subject TEXT UNIQUE
    );

    INSERT INTO users_new (id, username, password_hash)
    SELECT id, username, password_hash FROM users;

    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
  `);
  console.log('Migrated users: nullable password_hash + role_id + auth_provider + sso_subject (for Access Roles / Pocket ID SSO).');
}

migrateUsersForRolesAndSso();

// Seeds two starter roles on first run: Administrator (full access) and Viewer (view-only
// everywhere). Every pre-existing user (including whoever's been running the gateway so far) is
// assigned Administrator so this migration can never lock anyone out. Returns the Administrator
// role's id for ensureAdminUser() below.
function ensureAccessRoles() {
  const existingAdminRole = db.prepare('SELECT id FROM access_roles WHERE is_admin = 1').get();
  if (existingAdminRole) return existingAdminRole.id;

  const insertRole = db.prepare('INSERT INTO access_roles (name, is_admin) VALUES (?, ?)');
  const insertPerm = db.prepare(
    'INSERT INTO access_role_permissions (role_id, area, can_view, can_edit) VALUES (?, ?, ?, ?)'
  );

  const adminRoleId = insertRole.run('Administrator', 1).lastInsertRowid;
  const viewerRoleId = insertRole.run('Viewer', 0).lastInsertRowid;
  for (const { key } of AREAS) {
    insertPerm.run(adminRoleId, key, 1, 1);
    insertPerm.run(viewerRoleId, key, 1, 0);
  }

  const assignDefault = db.prepare('UPDATE users SET role_id = ? WHERE role_id IS NULL');
  const result = assignDefault.run(adminRoleId);
  if (result.changes > 0) {
    console.log(`Assigned ${result.changes} existing user(s) the new Administrator role.`);
  }

  return adminRoleId;
}

const administratorRoleId = ensureAccessRoles();

// The 'logs' area was added after Access Roles already shipped, so any role created before this
// point (including the Administrator/Viewer pair ensureAccessRoles() just seeded on an existing
// install) has no permission row for it at all yet — fresh installs don't hit this, since
// ensureAccessRoles() already seeds every area in the current AREAS list, 'logs' included. A new
// capability defaults to OFF for everyone except admin roles (which bypass the matrix anyway, but
// get the row for data consistency) rather than guessing an existing role should have it.
function backfillNewAreaPermissions() {
  const roles = db.prepare('SELECT * FROM access_roles').all();
  const hasPerm = db.prepare('SELECT 1 FROM access_role_permissions WHERE role_id = ? AND area = ?');
  const insertPerm = db.prepare('INSERT INTO access_role_permissions (role_id, area, can_view, can_edit) VALUES (?, ?, ?, ?)');

  for (const role of roles) {
    for (const { key } of AREAS) {
      if (hasPerm.get(role.id, key)) continue;
      const grant = role.is_admin ? 1 : 0;
      insertPerm.run(role.id, key, grant, grant);
    }
  }
}

// 'logs' was split into four per-tab areas (logs_mqtt/logs_loxone/logs_loxone_commands/
// logs_system — see permissionAreas.js's LOG_AREAS) so a role can be trusted with one log but not
// another. Without this, the generic "new area defaults to off" behavior of
// backfillNewAreaPermissions() above would silently revoke log access non-admin roles already had
// under the old combined area — carry over whatever it already granted them instead. Runs before
// backfillNewAreaPermissions() so its own hasPerm check sees these rows as already present and
// leaves them alone.
function migrateLogsAreaSplit() {
  const oldRows = db.prepare("SELECT role_id, can_view, can_edit FROM access_role_permissions WHERE area = 'logs'").all();
  if (oldRows.length === 0) return;
  const hasPerm = db.prepare('SELECT 1 FROM access_role_permissions WHERE role_id = ? AND area = ?');
  const insertPerm = db.prepare('INSERT INTO access_role_permissions (role_id, area, can_view, can_edit) VALUES (?, ?, ?, ?)');
  for (const { role_id: roleId, can_view: canView, can_edit: canEdit } of oldRows) {
    for (const { key } of LOG_AREAS) {
      if (hasPerm.get(roleId, key)) continue;
      insertPerm.run(roleId, key, canView, canEdit);
    }
  }
}

migrateLogsAreaSplit();
backfillNewAreaPermissions();

function ensureSsoSettings() {
  db.prepare('INSERT OR IGNORE INTO sso_settings (id, enabled) VALUES (1, 0)').run();
}

ensureSsoSettings();

function ensureMqttSettings() {
  const existing = db.prepare('SELECT * FROM mqtt_settings WHERE id = 1').get();
  if (existing) return;

  let host = '127.0.0.1';
  let port = 1883;
  let useTls = 0;
  try {
    const parsed = new URL(process.env.MQTT_URL || 'mqtt://127.0.0.1:1883');
    host = parsed.hostname;
    useTls = parsed.protocol === 'mqtts:' ? 1 : 0;
    port = Number(parsed.port) || (useTls ? 8883 : 1883);
  } catch {
    // fall through to the defaults above
  }

  db.prepare(
    'INSERT INTO mqtt_settings (id, host, port, username, password, use_tls) VALUES (1, ?, ?, ?, ?, ?)'
  ).run(host, port, process.env.MQTT_USERNAME || null, process.env.MQTT_PASSWORD || null, useTls);
}

ensureMqttSettings();

// Existing installs from before Mosquitto and the gateway shared one container had this row
// seeded with the old inter-container DNS name ('mosquitto', resolvable only when there were two
// separate compose services). Now that the broker is a second process in this same container,
// that name no longer resolves — point any row still carrying it at localhost instead. Guarded
// on both host AND port so a deliberately-named external broker on some other port is untouched.
db.prepare("UPDATE mqtt_settings SET host = '127.0.0.1' WHERE id = 1 AND host = 'mosquitto' AND port = 1883").run();

// Profile display fields — nullable TEXT with no CHECK/NOT NULL involved, so a plain ALTER TABLE
// covers it without the rebuild dance the other users migration needed. Pocket ID SSO populates
// these from OIDC claims (see routes/auth.js); local users can set display_name/email themselves
// from the Profile page.
function migrateUserProfileFields() {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!columns.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  if (!columns.includes('display_name')) db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  if (!columns.includes('avatar_url')) db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
}

migrateUserProfileFields();

// Separate from display_name (which stays the one thing actually shown in the topbar/account
// menu) — these exist so Administration > Users can list/sort/edit a proper first/last name
// instead of one free-text display string. Pocket ID SSO populates them from the standard OIDC
// given_name/family_name claims (see routes/auth.js); local users are edited from Administration.
function migrateUserNameFields() {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!columns.includes('first_name')) db.exec('ALTER TABLE users ADD COLUMN first_name TEXT');
  if (!columns.includes('last_name')) db.exec('ALTER TABLE users ADD COLUMN last_name TEXT');
}

migrateUserNameFields();

// Set on every successful login (local or SSO, see routes/auth.js) so Administration > Users can
// show when an account was last used — nullable, so an account that's never logged in just shows
// blank rather than a fabricated date.
function migrateUserLastLogin() {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!columns.includes('last_login_at')) db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
}

migrateUserLastLogin();

// Singleton settings row for the scheduled backup job (see backup.js) — same one-row pattern as
// mqtt_settings/sso_settings above. schedule_cron is a standard 5-field cron expression (parsed by
// the cron-parser package); last_run_at/last_status/last_error let the Backups admin page show
// what the last scheduled (or manual) run actually did without needing a separate history table.
function ensureBackupSettings() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      schedule_cron TEXT NOT NULL DEFAULT '0 3 * * *',
      retention_count INTEGER NOT NULL DEFAULT 14,
      include_mqtt_config INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      last_status TEXT,
      last_error TEXT
    );
  `);
  db.prepare('INSERT OR IGNORE INTO backup_settings (id) VALUES (1)').run();
}

ensureBackupSettings();

// rclone offsite copy (see backup.js's uploadToRclone) — a just-created local backup zip is
// additionally pushed to whatever remote this points at, entirely on top of local retention above:
// this only ever adds to the remote, it never prunes it, so an admin's own remote-side lifecycle
// rules (or manual cleanup) stay in full control of what happens to older offsite copies.
// rclone_config holds the raw contents of an rclone.conf (generated by running `rclone config` on
// any machine, then pasted in here) — written out to a temp file only for the duration of each
// rclone invocation (see backup.js), never left sitting on disk as its own file.
function migrateBackupSettingsRclone() {
  const columns = db.prepare('PRAGMA table_info(backup_settings)').all().map((c) => c.name);
  const addColumn = (name, def) => {
    if (!columns.includes(name)) db.exec(`ALTER TABLE backup_settings ADD COLUMN ${name} ${def}`);
  };
  addColumn('rclone_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('rclone_remote', 'TEXT');
  addColumn('rclone_config', 'TEXT');
  addColumn('rclone_last_run_at', 'TEXT');
  addColumn('rclone_last_status', 'TEXT');
  addColumn('rclone_last_error', 'TEXT');
}

migrateBackupSettingsRclone();

// Notification channels and the rules that fire through them. A channel is just a name plus one
// Apprise URL (see notifications.js's own comment for why — sending goes through the Apprise CLI,
// installed in the Docker image, rather than hand-rolled Teams/Slack/Telegram/SMTP integrations of
// our own) — no per-service-type columns needed here at all, unlike a typical multi-channel design,
// since Apprise's URL scheme already fully describes which service and how to reach it.
// `config` on notification_rules is a free-form JSON blob (monitor id + operator + threshold, or a
// specific/any miniserver, or a specific/any MQTT username, depending on trigger_type — see
// notifications.js's TRIGGER_TYPES) rather than a wide column set, since every trigger type needs a
// genuinely different shape. `last_state` is how threshold/status rules detect a *transition* (only
// notify going ok->breached, not on every single reading while still breached) — keyed by entity id
// (monitor/miniserver id, MQTT username) so a rule scoped to "any miniserver" tracks each one's own
// last-known state independently rather than sharing one flag across all of them. A many-to-many
// join table (not a single channel_id on the rule) is what makes "choose the channels per rule"
// from the Notifications admin page possible at all.
function ensureNotificationTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_type TEXT NOT NULL CHECK (trigger_type IN ('monitor_threshold','miniserver_status','mqtt_client_status','backup_failed')),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      last_state TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_rule_channels (
      rule_id INTEGER NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
      PRIMARY KEY (rule_id, channel_id)
    );
    -- Which users personally want a rule's notifications delivered to their OWN Apprise channel
    -- (see users.notify_url below) too, on top of whatever admin-configured channels the rule
    -- already sends to via notification_rule_channels above — set from each user's own Profile
    -- page (routes/profile.js), not the admin Notifications page, since it's a personal opt-in
    -- rather than a channel/rule the whole gateway shares.
    CREATE TABLE IF NOT EXISTS notification_rule_subscribers (
      rule_id INTEGER NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (rule_id, user_id)
    );
  `);
}

ensureNotificationTables();

// NULL (the default for every existing row, and every rule the admin Notifications page itself
// creates) means an admin-wide rule, same as before this column existed. A real user id instead
// means a PERSONAL rule that user created themselves from their own Profile page — routes/
// notifications.js's admin list only ever shows the NULL ones; routes/profile.js's "My rules" list
// only ever shows the current user's own. Both kinds are otherwise identical rows in the same
// table, picked up by the exact same trigger-detection code in notifications.js — creating one
// auto-subscribes its owner (notification_rule_subscribers) rather than needing a second delivery
// path just for personal rules.
function migrateNotificationRulesOwner() {
  const columns = db.prepare('PRAGMA table_info(notification_rules)').all().map((c) => c.name);
  if (!columns.includes('owner_user_id')) db.exec('ALTER TABLE notification_rules ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
}

migrateNotificationRulesOwner();

// A user's own personal Apprise URL (see notifications.js's own comment on notification_channels
// for why Apprise specifically) — e.g. their own Pushover/Telegram/ntfy target, entirely separate
// from the admin-configured notification_channels above. Lets someone subscribe to specific rules
// (notification_rule_subscribers) and get pinged on their own device without an admin having to
// set up or maintain a channel on their behalf.
function migrateUsersNotifyUrl() {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!columns.includes('notify_url')) db.exec('ALTER TABLE users ADD COLUMN notify_url TEXT');
}

migrateUsersNotifyUrl();

// A user's own pin of a dashboard into their sidebar (see middleware/loadUserContext.js's
// favoriteDashboards query, and the star toggle on dashboards.ejs/dashboard-detail.ejs) — per-user
// rather than a column on custom_dashboards itself, since a shared dashboard can be favorited (or
// not) independently by every user who has access to it, not just its owner.
function ensureDashboardFavoritesTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dashboard_id INTEGER NOT NULL REFERENCES custom_dashboards(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, dashboard_id)
    );
  `);
}

ensureDashboardFavoritesTable();

// How long a disconnected MQTT client stays listed on the Connected Clients page before
// mosquittoLog.js's periodic sweep (see logCollector.js) drops it and logs the removal — see
// migrateLogEntriesSystemSource below for where that removal gets logged to.
function migrateClientRetentionSetting() {
  const columns = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
  if (!columns.includes('client_retention_hours')) {
    db.exec('ALTER TABLE gateway_settings ADD COLUMN client_retention_hours INTEGER NOT NULL DEFAULT 24');
  }
}

migrateClientRetentionSetting();

// How often the background sweep re-checks every Miniserver's reachability, firmware version, and
// diagnostics (CPU/heap/PLC state/etc. — see healthcheck.js's checkAllMiniservers). 60s default,
// same as the previous hardcoded value in server.js's startHealthchecks(60000) call.
function migrateHealthcheckIntervalSetting() {
  const columns = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
  if (!columns.includes('healthcheck_interval_seconds')) {
    db.exec('ALTER TABLE gateway_settings ADD COLUMN healthcheck_interval_seconds INTEGER NOT NULL DEFAULT 60');
  }
}

migrateHealthcheckIntervalSetting();

// A third monitor source alongside mqtt/loxone: 'miniserver_diag' tracks one of the Miniserver
// diagnostic fields healthcheck.js already polls on its own interval (CPU load, heap, task count)
// — fed a reading whenever that cycle updates, never polled independently by this monitor itself.
// Deliberately not another 'loxone' monitor: those poll /jdev/sps/io/<uuid> on their own schedule,
// and CPU/heap/tasks aren't controls with a uuid at all, they're the plain HTTP commands
// healthcheck.js's fetchSystemStats already reads — a second independent poll of the exact same
// data on a different schedule would be pure waste. source_type's CHECK constraint can't be
// ALTERed in place in SQLite, so this is the same create/copy/drop/rename dance every other
// constraint change in this file uses.
// heap_value_kb, not heap_free_kb — /jdev/sys/heap reports "X/totalKb" but Loxone doesn't document
// whether X is free or used memory (see format.js's formatHeapStatus), so this doesn't assert an
// interpretation the raw display itself doesn't either.
function migrateMonitorDiagnosticSource() {
  const columns = db.prepare('PRAGMA table_info(monitors)').all().map((c) => c.name);
  if (columns.includes('diag_field')) return;

  // DROP TABLE IF EXISTS first + the whole thing wrapped in one transaction: a container restart
  // landing mid-migration (the multi-statement db.exec() below isn't atomic on its own — each
  // statement commits independently) previously left monitors_new created-and-populated but never
  // renamed, which then made every subsequent boot fail outright on "table monitors_new already
  // exists" instead of retrying cleanly. db.transaction() rolls back everything on any failure,
  // and the IF EXISTS guard means a stale leftover from before this fix shipped doesn't block a
  // fresh attempt either.
  const migrate = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS monitors_new');
    db.exec(`
      CREATE TABLE monitors_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL CHECK (source_type IN ('mqtt', 'loxone', 'miniserver_diag')),
        label TEXT NOT NULL,
        mqtt_topic TEXT,
        miniserver_id INTEGER REFERENCES miniservers(id) ON DELETE CASCADE,
        loxone_uuid TEXT,
        diag_field TEXT CHECK (diag_field IN ('cpu_load', 'heap_value_kb', 'heap_total_kb', 'num_tasks')),
        poll_interval_ms INTEGER NOT NULL DEFAULT 10000,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      INSERT INTO monitors_new
        (id, source_type, label, mqtt_topic, miniserver_id, loxone_uuid, poll_interval_ms, enabled, created_at)
      SELECT id, source_type, label, mqtt_topic, miniserver_id, loxone_uuid, poll_interval_ms, enabled, created_at
      FROM monitors;

      DROP TABLE monitors;
      ALTER TABLE monitors_new RENAME TO monitors;
    `);
  });
  migrate();
  console.log("Migrated monitors: added 'miniserver_diag' source type + diag_field column.");
}

migrateMonitorDiagnosticSource();

// panel_type_defaults started out global (one row per panel_type, PRIMARY KEY(panel_type)) —
// rescoped to per-dashboard (see the CREATE TABLE above) before this ever shipped in a release, so
// there's no real installed base to preserve data for. Existing rows (from local testing only) are
// dropped rather than migrated — SQLite can't ALTER a PRIMARY KEY in place anyway.
function migratePanelTypeDefaultsScope() {
  const columns = db.prepare('PRAGMA table_info(panel_type_defaults)').all().map((c) => c.name);
  if (columns.length > 0 && !columns.includes('dashboard_id')) {
    db.exec('DROP TABLE panel_type_defaults');
    db.exec(`
      CREATE TABLE panel_type_defaults (
        dashboard_id INTEGER NOT NULL REFERENCES custom_dashboards(id) ON DELETE CASCADE,
        panel_type TEXT NOT NULL,
        config TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (dashboard_id, panel_type)
      )
    `);
  }
}

migratePanelTypeDefaultsScope();

// Whether the "Suggest dashboard" button (Live Data, per room) is offered at all — a per-gateway
// toggle rather than per-user, since it just controls whether the feature is available, not
// personal data.
function migrateDashboardSuggestionsSetting() {
  const columns = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
  if (!columns.includes('dashboard_suggestions_enabled')) {
    db.exec('ALTER TABLE gateway_settings ADD COLUMN dashboard_suggestions_enabled INTEGER NOT NULL DEFAULT 1');
  }
}

migrateDashboardSuggestionsSetting();

// Whether the first-run setup wizard (routes/setup.js) has already been completed/skipped once —
// a single install-wide flag (there's only one gateway_settings row) rather than per-user, since
// the wizard is about setting up the *installation*, not a personal preference. Only gates the
// automatic redirect an admin gets sent to right after their very first login (see routes/auth.js)
// — the wizard page itself stays reachable at any time regardless of this flag (a "Run setup
// wizard" link on Settings), since this is still an early test version and needs to be re-runnable
// for that, not a permanent one-shot gate.
function migrateSetupWizardSetting() {
  const columns = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
  if (!columns.includes('setup_wizard_completed')) {
    db.exec('ALTER TABLE gateway_settings ADD COLUMN setup_wizard_completed INTEGER NOT NULL DEFAULT 0');
  }
}

migrateSetupWizardSetting();

// Every date/time shown anywhere in the UI is rendered in this timezone (an IANA name, e.g.
// "Europe/Amsterdam") rather than relying on whatever timezone the browser/OS happens to report —
// the latter silently showed raw UTC as if it were local time on at least one real deployment
// (container and browser both effectively reporting UTC despite the user being in CEST). Defaults
// to UTC, the one value that's never wrong, just possibly not what you want until you set it.
function migrateDisplayTimezone() {
  const columns = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
  if (!columns.includes('display_timezone')) {
    db.exec("ALTER TABLE gateway_settings ADD COLUMN display_timezone TEXT NOT NULL DEFAULT 'UTC'");
  }
}

migrateDisplayTimezone();

// A dashboard "Current value" panel showing e.g. a Loxone tempActual reading has no per-panel
// rounding control at all today — it's whatever the source reported, decimal noise included.
// Defaults to 2 (a sane general-purpose value), overridable per panel by setting a non-blank
// decimals value in that panel's own settings (see dashboards.js's buildConfig).
function migrateDefaultPanelDecimals() {
  const columns = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
  if (!columns.includes('default_panel_decimals')) {
    db.exec('ALTER TABLE gateway_settings ADD COLUMN default_panel_decimals INTEGER NOT NULL DEFAULT 2');
  }
}

migrateDefaultPanelDecimals();

// Login brute-force throttle (see the loginLimiter in routes/auth.js) — was hardcoded at 10
// attempts per 15 minutes; made configurable per a direct request. Keyed on IP only, so this
// caps how fast any one client can try passwords, not any one account.
function migrateLoginRateLimit() {
  const columns = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
  if (!columns.includes('login_rate_limit_max')) {
    db.exec('ALTER TABLE gateway_settings ADD COLUMN login_rate_limit_max INTEGER NOT NULL DEFAULT 10');
  }
  if (!columns.includes('login_rate_limit_window_minutes')) {
    db.exec('ALTER TABLE gateway_settings ADD COLUMN login_rate_limit_window_minutes INTEGER NOT NULL DEFAULT 15');
  }
}

migrateLoginRateLimit();

// Which setup-wizard steps (routes/setup.js) have actually been submitted (Skip or a real save),
// as a comma-separated list of step names — powers the checkmark on that step's own badge, so it
// only shows once a step has genuinely been gone through, not just because its current state
// happens to already be valid (e.g. SSO disabled is "valid" from the moment gateway_settings is
// first created, long before anyone's looked at that step).
function migrateSetupWizardVisitedSteps() {
  const columns = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
  if (!columns.includes('setup_wizard_visited_steps')) {
    db.exec("ALTER TABLE gateway_settings ADD COLUMN setup_wizard_visited_steps TEXT NOT NULL DEFAULT ''");
  }
}

migrateSetupWizardVisitedSteps();

// Break-glass: when SSO is set up and this is on, local username/password login is refused for
// anyone NOT coming from a private/local network — forcing normal sign-in through SSO — while
// still leaving a way in from the local network if the external IdP is ever unreachable. Off by
// default; only has any effect at all while sso_settings.enabled is also on.
function migrateSsoLocalLoginDisabled() {
  const columns = db.prepare('PRAGMA table_info(sso_settings)').all().map((c) => c.name);
  if (!columns.includes('local_login_disabled')) {
    db.exec('ALTER TABLE sso_settings ADD COLUMN local_login_disabled INTEGER NOT NULL DEFAULT 0');
  }
}

migrateSsoLocalLoginDisabled();

// Widens log_entries.source to add 'system' (gateway housekeeping events — e.g. a disconnected
// MQTT client getting auto-pruned) alongside the existing 'mqtt'/'loxone' — another CHECK
// constraint change, so another table rebuild (see migrateMqttToLoxoneExtensions above).
function migrateLogEntriesSystemSource() {
  const tableSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'log_entries'"
  ).get();
  if (!tableSql || tableSql.sql.includes("'system'")) return;

  db.exec(`
    CREATE TABLE log_entries_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('mqtt', 'loxone', 'system')),
      source_id INTEGER,
      source_label TEXT,
      line TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    INSERT INTO log_entries_new (id, source, source_id, source_label, line, recorded_at)
    SELECT id, source, source_id, source_label, line, recorded_at FROM log_entries;

    DROP TABLE log_entries;
    ALTER TABLE log_entries_new RENAME TO log_entries;

    CREATE INDEX IF NOT EXISTS idx_log_entries_source_time ON log_entries(source, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_log_entries_source_id ON log_entries(source_id);
  `);
  console.log("Migrated log_entries: widened source CHECK to add 'system'.");
}

migrateLogEntriesSystemSource();

// Widens log_entries.source again to add 'loxone_commands' — every inbound Virtual Output
// command Loxone sends the gateway (UDP or HTTP), successful or rejected, so Logs > Loxone
// commands can show who sent what, when, and what it resolved to. source_label carries the
// sender ("UDP 192.168.10.50:54321" / "HTTP 192.168.10.50"); line carries the token/topic, the
// raw value, and the outcome — see loxoneCommandLog.js. Same CHECK-widening rebuild as the
// 'system' source above.
function migrateLogEntriesCommandsSource() {
  const tableSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'log_entries'"
  ).get();
  if (!tableSql || tableSql.sql.includes("'loxone_commands'")) return;

  db.exec(`
    CREATE TABLE log_entries_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('mqtt', 'loxone', 'system', 'loxone_commands')),
      source_id INTEGER,
      source_label TEXT,
      line TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    INSERT INTO log_entries_new (id, source, source_id, source_label, line, recorded_at)
    SELECT id, source, source_id, source_label, line, recorded_at FROM log_entries;

    DROP TABLE log_entries;
    ALTER TABLE log_entries_new RENAME TO log_entries;

    CREATE INDEX IF NOT EXISTS idx_log_entries_source_time ON log_entries(source, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_log_entries_source_id ON log_entries(source_id);
  `);
  console.log("Migrated log_entries: widened source CHECK to add 'loxone_commands'.");
}

migrateLogEntriesCommandsSource();

// Structured columns for the 'loxone_commands' source above — plain nullable ALTER TABLE ADD
// COLUMNs (no CHECK involved, so no rebuild needed like the source-widening migrations above).
// Left NULL for the other three sources. command_topic is the resolved MQTT topic (or the raw
// token/text when nothing resolved); value_from/value_to let the Logs > Loxone commands page show
// the actual transition ("Off" -> "On") instead of just the new value on its own.
function migrateLogEntriesCommandColumns() {
  const columns = db.prepare('PRAGMA table_info(log_entries)').all().map((c) => c.name);
  if (!columns.includes('command_topic')) db.exec('ALTER TABLE log_entries ADD COLUMN command_topic TEXT');
  if (!columns.includes('value_from')) db.exec('ALTER TABLE log_entries ADD COLUMN value_from TEXT');
  if (!columns.includes('value_to')) db.exec('ALTER TABLE log_entries ADD COLUMN value_to TEXT');
}

migrateLogEntriesCommandColumns();

// Per-column pixel widths from the table header's drag-to-resize handles (public/tables.js) —
// same simple TEXT/JSON-blob shape as column_order/hidden_columns above, so a plain ALTER TABLE
// covers it (no CHECK constraint involved).
function migrateTablePrefColumnWidths() {
  const columns = db.prepare('PRAGMA table_info(user_table_prefs)').all().map((c) => c.name);
  if (!columns.includes('column_widths')) {
    db.exec('ALTER TABLE user_table_prefs ADD COLUMN column_widths TEXT');
  }
}

migrateTablePrefColumnWidths();

// User-edited overrides for the "Common commands"/"Common data" catalogs (see commandCatalog.js)
// — a single row, both columns NULL until the first save. NULL means "use the built-in factory
// defaults" for that whole catalog; once saved, the JSON blob here is the WHOLE replacement (not
// merged field-by-field with the built-in one), same one-shot-replace shape rclone_config/
// backup settings already use elsewhere in this file. Lives in gateway.db like everything else,
// so it's covered by the existing backup/restore flow with no extra wiring needed there.
function ensureCommandCatalogTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_catalog_overrides (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      commands_json TEXT,
      data_json TEXT,
      updated_at TEXT
    );
  `);
}

ensureCommandCatalogTable();

function ensureAdminUser() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.warn('ADMIN_USERNAME/ADMIN_PASSWORD not set and no users exist yet — web UI login will fail until a user is created.');
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username, password_hash, role_id) VALUES (?, ?, ?)').run(username, hash, administratorRoleId);
  console.log(`Created initial admin user "${username}".`);
}

ensureAdminUser();

// Emergency password reset: drop a file named reset-password.txt into the same directory as
// gateway.db (the persisted /data volume, already reachable to anyone with filesystem access to
// this deployment — SMB share, Unraid's file browser, ssh, ...), containing just the username on
// its own line. Checked on every boot; a matching user gets a fresh random password, printed to
// the container's own stdout log ONCE, and every existing session is invalidated (in case the
// account was compromised, not just forgotten). The file is deleted immediately after, so this is
// one-shot rather than a standing backdoor. Doesn't grant any access that direct sqlite3/DB access
// wouldn't already — this only makes that same trust level safe and easy instead of hand-written
// bcrypt commands via `docker exec`.
function checkEmergencyPasswordReset() {
  const resetFilePath = path.join(path.dirname(DB_PATH), 'reset-password.txt');
  if (!fs.existsSync(resetFilePath)) return;

  const username = fs.readFileSync(resetFilePath, 'utf8').trim();
  fs.unlinkSync(resetFilePath); // one-shot, regardless of whether a matching user is found below

  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) {
    console.warn(`reset-password.txt named "${username}", but no such user exists — nothing reset.`);
    return;
  }

  const newPassword = crypto.randomBytes(9).toString('base64url'); // 12 chars, URL-safe
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), user.id);
  db.prepare('DELETE FROM sessions').run();
  console.log('==================================================================');
  console.log(`Emergency password reset for "${username}": ${newPassword}`);
  console.log('Log in with this once, then change it from Profile. Every existing session was signed out.');
  console.log('==================================================================');
}

checkEmergencyPasswordReset();

// Encrypts secrets that predate secretCrypto.js (see that file) and are still sitting in the
// database as plain text — Miniserver passwords, the MQTT broker password, the SSO client secret,
// and any saved rclone.conf. Every write site already encrypts going forward; this only ever
// touches a value once (encrypt() itself is a no-op on an already-encrypted value, so this is safe
// to run unconditionally on every boot, not just the first one after upgrading).
function migrateEncryptExistingSecrets() {
  const miniservers = db.prepare('SELECT id, password FROM miniservers').all();
  const encryptMiniserver = db.prepare('UPDATE miniservers SET password = ? WHERE id = ?');
  for (const ms of miniservers) {
    if (ms.password && !isEncrypted(ms.password)) encryptMiniserver.run(encrypt(ms.password), ms.id);
  }

  const mqtt = db.prepare('SELECT password FROM mqtt_settings WHERE id = 1').get();
  if (mqtt?.password && !isEncrypted(mqtt.password)) {
    db.prepare('UPDATE mqtt_settings SET password = ? WHERE id = 1').run(encrypt(mqtt.password));
  }

  const sso = db.prepare('SELECT client_secret FROM sso_settings WHERE id = 1').get();
  if (sso?.client_secret && !isEncrypted(sso.client_secret)) {
    db.prepare('UPDATE sso_settings SET client_secret = ? WHERE id = 1').run(encrypt(sso.client_secret));
  }

  const backupSettings = db.prepare('SELECT rclone_config FROM backup_settings WHERE id = 1').get();
  if (backupSettings?.rclone_config && !isEncrypted(backupSettings.rclone_config)) {
    db.prepare('UPDATE backup_settings SET rclone_config = ? WHERE id = 1').run(encrypt(backupSettings.rclone_config));
  }
}

migrateEncryptExistingSecrets();

// Per-monitor chart display settings (legend, fill/stepped/curve, y-axis, zoom, thresholds,
// annotations) for the Monitor detail page's own chart — same shape as a dashboard chart panel's
// own `config` JSON (see dashboard_panels.config / buildConfig() in routes/dashboards.js), just
// stored per-monitor instead of per-panel since that page has no separate "panel" of its own.
// No CHECK constraint needed (same reasoning as dashboard_panels.config being unconstrained JSON),
// so a plain ALTER TABLE ADD COLUMN is enough — no full-table rebuild like migrateMonitorDiagnosticSource.
function migrateMonitorChartConfig() {
  const columns = db.prepare('PRAGMA table_info(monitors)').all().map((c) => c.name);
  if (!columns.includes('config')) {
    db.exec("ALTER TABLE monitors ADD COLUMN config TEXT NOT NULL DEFAULT '{}'");
  }
}

migrateMonitorChartConfig();

// One saved "house style" for the Monitor detail page's own chart, shared across every monitor —
// unlike a dashboard chart panel's per-(dashboard, panel_type) default (panel_type_defaults, see
// panelTypeDefaults.js), a monitor has no dashboard to scope by, and the user explicitly asked for
// one style applicable to every monitor ("alle monitors dezelfde style"), not a per-monitor default.
// Still literal '{}' (not a real buildConfig() shape) means "nothing saved yet" — see
// monitor.js's save-as-default/reset-to-default routes.
function migrateMonitorChartDefault() {
  const columns = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
  if (!columns.includes('monitor_chart_default_config')) {
    db.exec("ALTER TABLE gateway_settings ADD COLUMN monitor_chart_default_config TEXT NOT NULL DEFAULT '{}'");
  }
}

migrateMonitorChartDefault();

// The Notification Center's own persisted history — deliberately separate from log_entries (which
// only ever gets a free-text line per Apprise delivery attempt, one row per channel/subscriber for
// what a user thinks of as one alert, mixed in with unrelated login/role/SSO audit noise). One row
// per logical event instead, written from notifications.js's fireRule() (rule_id set, covering all
// 5 trigger types) or directly by the threshold-ladder notify check (rule_id NULL — no admin rule
// needed, matching "just check a box on the threshold row").
//
// rule_id is deliberately a plain int with NO `REFERENCES notification_rules(id)` — this database
// doesn't enforce PRAGMA foreign_keys (see the same note on notification_rule_channels above, and
// routes/notifications.js's own /rules/:id/delete, which hand-deletes its join-table rows for
// exactly that reason), so a REFERENCES clause here would be purely decorative — and actively
// misleading, since a future edit "completing the pattern" by also cascade-deleting
// notification_events when its rule is deleted would silently erase logbook history, defeating the
// whole point of a persisted log. Modeled on log_entries.source_id instead (a bare nullable int).
// Any query joining back to notification_rules for display must be a LEFT JOIN.
function ensureNotificationEventsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      source_id INTEGER,
      source_label TEXT,
      rule_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notification_events_created ON notification_events(created_at);
  `);
}

ensureNotificationEventsTable();

// Widens notification_rules.trigger_type's CHECK to add 'firmware_changed' (see notifications.js's
// TRIGGER_TYPES) — same guard-by-checking-the-CHECK-text-itself pattern as
// migrateLogEntriesCommandsSource above. Must carry every existing column, INCLUDING owner_user_id
// (added by migrateNotificationRulesOwner, which by file position here already ran) — dropping it
// from the rebuild's INSERT...SELECT would silently wipe every rule's personal/admin ownership on
// an upgrading install.
function migrateNotificationRulesFirmwareChanged() {
  const tableSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_rules'"
  ).get();
  if (!tableSql || tableSql.sql.includes("'firmware_changed'")) return;

  db.exec(`
    CREATE TABLE notification_rules_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_type TEXT NOT NULL CHECK (trigger_type IN ('monitor_threshold','miniserver_status','mqtt_client_status','backup_failed','firmware_changed')),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      last_state TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
    );

    INSERT INTO notification_rules_new (id, trigger_type, name, enabled, config, last_state, created_at, owner_user_id)
    SELECT id, trigger_type, name, enabled, config, last_state, created_at, owner_user_id FROM notification_rules;

    DROP TABLE notification_rules;
    ALTER TABLE notification_rules_new RENAME TO notification_rules;
  `);
  console.log("Migrated notification_rules: widened trigger_type CHECK to add 'firmware_changed'.");
}

migrateNotificationRulesFirmwareChanged();

// Per-user "read up to here" marker — unread count is just notification_events rows with
// id > this, no per-event-per-user join table needed (see loadUserContext.js).
function migrateUsersLastSeenNotification() {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!columns.includes('last_seen_notification_id')) {
    db.exec('ALTER TABLE users ADD COLUMN last_seen_notification_id INTEGER NOT NULL DEFAULT 0');
  }
}

migrateUsersLastSeenNotification();

// Its own setting rather than reusing log_retention_days — these are curated, meaningful events
// (not raw MQTT/Loxone protocol lines), worth keeping around longer by default (see
// settings-general.ejs's "Data retention" card).
function migrateNotificationRetentionSetting() {
  const columns = db.prepare('PRAGMA table_info(gateway_settings)').all().map((c) => c.name);
  if (!columns.includes('notification_retention_days')) {
    db.exec('ALTER TABLE gateway_settings ADD COLUMN notification_retention_days INTEGER NOT NULL DEFAULT 90');
  }
}

migrateNotificationRetentionSetting();

module.exports = db;
