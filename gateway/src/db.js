const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { AREAS } = require('./permissionAreas');

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

module.exports = db;
