// The ONE schema every fresh install (any backend) starts from — built via Knex's own
// schema-builder rather than raw SQL, so it's portable to Postgres/MySQL once those backends land
// (Phase 4/5 of the project's own db-backend plan). Describes the exact END STATE the 45
// hand-written legacy migrations (db/legacy-sqlite-schema.js) reach on an upgrading SQLite
// install — NOT re-derived by reading them, but reverse-engineered mechanically by dumping that
// path's own real resulting schema and building this to match it exactly, verified continuously by
// test/schemaParity.test.js (written and run red BEFORE this file existed). An upgrading SQLite
// install never runs this migration's schema-creation half at all — see db/index.js's own init()
// for how it instead gets stamped as already-applied once the legacy path has brought an existing
// database up to the same end state, so Knex only ever runs 002-and-up against it from then on.
//
// Design decisions carried over deliberately (see the plan's own reasoning): booleans stay plain
// integers (0/1), not a native boolean type, on every backend — the app's own SQL text (`WHERE
// enabled = 1`, `SET enabled = 1 - enabled`, ...) depends on that being true regardless of which
// backend is underneath, and this is what makes Phase 3's dialect-neutralization able to leave
// those call sites untouched. Timestamps stay ISO-8601 TEXT for the same reason (every date
// comparison in this codebase is a lexicographic TEXT compare). CHECK constraints are declared
// (even though SQLite has never enforced foreign keys here — see below) as a belt-and-suspenders
// duplicate of the app-level validation every write site already does before it ever reaches SQL;
// checkConstraints.test.js verifies each one functionally.
const bcrypt = require('bcryptjs');
const { AREAS } = require('../../permissionAreas');
const { encrypt } = require('../../secretCrypto');

exports.up = async function up(knex) {
  await knex.schema.createTable('access_roles', (t) => {
    t.increments('id');
    t.text('name').notNullable().unique();
    t.integer('is_admin').notNullable().defaultTo(0);
  });

  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.text('username').notNullable().unique();
    t.text('password_hash');
    t.integer('role_id').references('id').inTable('access_roles').onDelete('SET NULL');
    t.text('auth_provider').notNullable().defaultTo('local');
    t.text('sso_subject').unique();
    t.text('email');
    t.text('display_name');
    t.text('avatar_url');
    t.text('first_name');
    t.text('last_name');
    t.text('last_login_at');
    t.text('notify_url');
    t.integer('last_seen_notification_id').notNullable().defaultTo(0);
    t.integer('table_page_size');
  });

  await knex.schema.createTable('access_role_permissions', (t) => {
    t.integer('role_id').notNullable().references('id').inTable('access_roles').onDelete('CASCADE');
    t.text('area').notNullable();
    t.integer('can_view').notNullable().defaultTo(0);
    t.integer('can_edit').notNullable().defaultTo(0);
    t.primary(['role_id', 'area']);
  });

  await knex.schema.createTable('miniservers', (t) => {
    t.increments('id');
    t.text('name').notNullable();
    t.text('host').notNullable();
    t.integer('http_port').notNullable().defaultTo(80);
    t.integer('udp_port');
    t.text('username').notNullable();
    t.text('password').notNullable();
    t.text('last_success_at');
    t.text('last_error');
    t.text('status').notNullable().defaultTo('unknown');
    t.text('last_checked_at');
    t.integer('use_https').notNullable().defaultTo(0);
    t.text('external_url');
    t.text('firmware_version');
    t.text('device_monitor_status');
    t.text('plc_state');
    t.text('cpu_load');
    t.text('heap_status');
    t.text('num_tasks');
    t.text('firmware_date');
    t.text('update_level');
    t.integer('miniserver_type');
    t.integer('sort_order').notNullable().defaultTo(0);
    t.integer('gateway_client_of').references('id').inTable('miniservers').onDelete('SET NULL');
    t.text('logbook_error');
  });

  await knex.schema.createTable('mqtt_settings', (t) => {
    t.integer('id').primary();
    t.text('host').notNullable();
    t.integer('port').notNullable().defaultTo(1883);
    t.text('username');
    t.text('password');
    t.integer('use_tls').notNullable().defaultTo(0);
    t.check('?? = 1', ['id'], 'chk_mqtt_settings_singleton');
  });

  await knex.schema.createTable('gateway_settings', (t) => {
    t.integer('id').primary();
    t.integer('auto_create_loxone_mappings').notNullable().defaultTo(0);
    t.integer('monitor_retention_days').notNullable().defaultTo(30);
    t.integer('log_retention_days').notNullable().defaultTo(14);
    t.text('live_data_hidden_states').notNullable().defaultTo('[]');
    t.integer('client_retention_hours').notNullable().defaultTo(24);
    t.integer('healthcheck_interval_seconds').notNullable().defaultTo(60);
    t.integer('dashboard_suggestions_enabled').notNullable().defaultTo(1);
    t.integer('setup_wizard_completed').notNullable().defaultTo(0);
    t.text('display_timezone').notNullable().defaultTo('UTC');
    t.integer('default_panel_decimals').notNullable().defaultTo(2);
    t.integer('login_rate_limit_max').notNullable().defaultTo(10);
    t.integer('login_rate_limit_window_minutes').notNullable().defaultTo(15);
    t.text('setup_wizard_visited_steps').notNullable().defaultTo('');
    t.text('monitor_chart_default_config').notNullable().defaultTo('{}');
    t.integer('notification_retention_days').notNullable().defaultTo(90);
    t.integer('auto_scope_device_roles').notNullable().defaultTo(0);
    t.text('notification_templates').notNullable().defaultTo('{}');
    t.check('?? = 1', ['id'], 'chk_gateway_settings_singleton');
  });

  await knex.schema.createTable('sso_settings', (t) => {
    t.integer('id').primary();
    t.integer('enabled').notNullable().defaultTo(0);
    t.text('issuer_url');
    t.text('client_id');
    t.text('client_secret');
    t.integer('default_role_id').references('id').inTable('access_roles').onDelete('SET NULL');
    t.text('button_label').notNullable().defaultTo('Pocket ID');
    t.integer('local_login_disabled').notNullable().defaultTo(0);
    t.check('?? = 1', ['id'], 'chk_sso_settings_singleton');
  });

  await knex.schema.createTable('backup_settings', (t) => {
    t.integer('id').primary();
    t.integer('enabled').notNullable().defaultTo(0);
    t.text('schedule_cron').notNullable().defaultTo('0 3 * * *');
    t.integer('retention_count').notNullable().defaultTo(14);
    t.integer('include_mqtt_config').notNullable().defaultTo(1);
    t.text('last_run_at');
    t.text('last_status');
    t.text('last_error');
    t.integer('rclone_enabled').notNullable().defaultTo(0);
    t.text('rclone_remote');
    t.text('rclone_config');
    t.text('rclone_last_run_at');
    t.text('rclone_last_status');
    t.text('rclone_last_error');
    t.check('?? = 1', ['id'], 'chk_backup_settings_singleton');
  });

  await knex.schema.createTable('command_catalog_overrides', (t) => {
    t.integer('id').primary();
    t.text('commands_json');
    t.text('data_json');
    t.text('updated_at');
    t.check('?? = 1', ['id'], 'chk_command_catalog_overrides_singleton');
  });

  await knex.schema.createTable('mappings_mqtt_to_loxone', (t) => {
    t.increments('id');
    t.integer('miniserver_id').notNullable().references('id').inTable('miniservers').onDelete('CASCADE');
    t.text('mqtt_topic').notNullable();
    t.text('transport').notNullable().defaultTo('http');
    t.text('target').notNullable();
    t.text('value_transform').notNullable().defaultTo('passthrough');
    t.text('transform_arg');
    t.integer('min_interval_ms').notNullable().defaultTo(0);
    t.integer('enabled').notNullable().defaultTo(1);
    t.check('?? IN (?, ?)', ['transport', 'http', 'udp'], 'chk_mqtt_to_loxone_transport');
    t.check('?? IN (?, ?, ?, ?)', ['value_transform', 'passthrough', 'bool_on_off', 'json_path', 'translation_table'], 'chk_mqtt_to_loxone_value_transform');
  });

  await knex.schema.createTable('mapping_translations', (t) => {
    t.increments('id');
    t.integer('mapping_id').notNullable().references('id').inTable('mappings_mqtt_to_loxone').onDelete('CASCADE');
    t.text('match_value').notNullable();
    t.text('output_value').notNullable();
    t.unique(['mapping_id', 'match_value']);
  });

  await knex.schema.createTable('mappings_loxone_to_mqtt', (t) => {
    t.increments('id');
    t.integer('miniserver_id').references('id').inTable('miniservers').onDelete('SET NULL');
    t.text('token').notNullable().unique();
    t.text('mqtt_topic').notNullable();
    t.integer('qos').notNullable().defaultTo(0);
    t.integer('retain').notNullable().defaultTo(0);
    t.integer('enabled').notNullable().defaultTo(1);
    t.text('transport').notNullable().defaultTo('http');
    t.text('value_transform').notNullable().defaultTo('passthrough');
    t.text('transform_arg');
    t.check('?? IN (?, ?, ?)', ['qos', 0, 1, 2], 'chk_loxone_to_mqtt_qos');
  });

  await knex.schema.createTable('loxone_mapping_translations', (t) => {
    t.increments('id');
    t.integer('mapping_id').notNullable().references('id').inTable('mappings_loxone_to_mqtt').onDelete('CASCADE');
    t.text('match_value').notNullable();
    t.text('output_value').notNullable();
    t.unique(['mapping_id', 'match_value']);
  });

  await knex.schema.createTable('user_table_prefs', (t) => {
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('table_key').notNullable();
    t.text('column_order');
    t.text('hidden_columns');
    t.text('column_widths');
    t.primary(['user_id', 'table_key']);
  });

  await knex.schema.createTable('user_nav_prefs', (t) => {
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('section_key').notNullable();
    t.integer('collapsed').notNullable().defaultTo(0);
    t.primary(['user_id', 'section_key']);
  });

  await knex.schema.createTable('monitors', (t) => {
    t.increments('id');
    t.text('source_type').notNullable();
    t.text('label').notNullable();
    t.text('mqtt_topic');
    t.integer('miniserver_id').references('id').inTable('miniservers').onDelete('CASCADE');
    t.text('loxone_uuid');
    t.text('diag_field');
    t.integer('poll_interval_ms').notNullable().defaultTo(10000);
    t.integer('enabled').notNullable().defaultTo(1);
    t.text('created_at').notNullable();
    t.text('config').notNullable().defaultTo('{}');
    t.check('?? IN (?, ?, ?)', ['source_type', 'mqtt', 'loxone', 'miniserver_diag'], 'chk_monitors_source_type');
    t.check('?? IN (?, ?, ?, ?)', ['diag_field', 'cpu_load', 'heap_value_kb', 'heap_total_kb', 'num_tasks'], 'chk_monitors_diag_field');
  });

  await knex.schema.createTable('monitor_history', (t) => {
    t.increments('id');
    t.integer('monitor_id').notNullable().references('id').inTable('monitors').onDelete('CASCADE');
    t.text('recorded_at').notNullable();
    t.text('value').notNullable();
    t.specificType('numeric_value', 'REAL');
    t.index(['monitor_id', 'recorded_at'], 'idx_monitor_history_monitor_time');
    t.index(['recorded_at'], 'idx_monitor_history_recorded_at');
  });

  await knex.schema.createTable('custom_dashboards', (t) => {
    t.increments('id');
    t.integer('user_id').references('id').inTable('users').onDelete('CASCADE');
    t.text('name').notNullable();
    t.integer('position').notNullable().defaultTo(0);
    t.text('created_at').notNullable();
  });

  await knex.schema.createTable('dashboard_panels', (t) => {
    t.increments('id');
    t.integer('dashboard_id').notNullable().references('id').inTable('custom_dashboards').onDelete('CASCADE');
    t.text('panel_type').notNullable();
    t.text('title');
    t.text('range').notNullable().defaultTo('24h');
    t.text('config').notNullable().defaultTo('{}');
    t.integer('col_span').notNullable().defaultTo(4);
    t.integer('row_span').notNullable().defaultTo(3);
    t.integer('position').notNullable().defaultTo(0);
    t.integer('grid_x');
    t.integer('grid_y');
    t.check('?? IN (?, ?, ?, ?, ?, ?, ?, ?)', ['panel_type', 'chart', 'table', 'value', 'gauge', 'stat_delta', 'threshold', 'state_bar', 'group_header'], 'chk_dashboard_panels_type');
  });

  await knex.schema.createTable('dashboard_panel_monitors', (t) => {
    t.integer('panel_id').notNullable().references('id').inTable('dashboard_panels').onDelete('CASCADE');
    t.integer('monitor_id').notNullable().references('id').inTable('monitors').onDelete('CASCADE');
    t.integer('position').notNullable().defaultTo(0);
    t.primary(['panel_id', 'monitor_id']);
  });

  await knex.schema.createTable('panel_type_defaults', (t) => {
    t.integer('dashboard_id').notNullable().references('id').inTable('custom_dashboards').onDelete('CASCADE');
    t.text('panel_type').notNullable();
    t.text('config').notNullable();
    t.text('updated_at').notNullable();
    t.primary(['dashboard_id', 'panel_type']);
  });

  await knex.schema.createTable('dashboard_shares', (t) => {
    t.integer('dashboard_id').notNullable().references('id').inTable('custom_dashboards').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('can_edit').notNullable().defaultTo(0);
    t.primary(['dashboard_id', 'user_id']);
  });

  await knex.schema.createTable('dashboard_role_shares', (t) => {
    t.integer('dashboard_id').notNullable().references('id').inTable('custom_dashboards').onDelete('CASCADE');
    t.integer('role_id').notNullable().references('id').inTable('access_roles').onDelete('CASCADE');
    t.integer('can_edit').notNullable().defaultTo(0);
    t.primary(['dashboard_id', 'role_id']);
  });

  await knex.schema.createTable('dashboard_favorites', (t) => {
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('dashboard_id').notNullable().references('id').inTable('custom_dashboards').onDelete('CASCADE');
    t.primary(['user_id', 'dashboard_id']);
  });

  await knex.schema.createTable('log_entries', (t) => {
    t.increments('id');
    t.text('source').notNullable();
    t.integer('source_id');
    t.text('source_label');
    t.text('line').notNullable();
    t.text('recorded_at').notNullable();
    t.text('command_topic');
    t.text('value_from');
    t.text('value_to');
    t.text('transport');
    t.check('?? IN (?, ?, ?, ?)', ['source', 'mqtt', 'loxone', 'system', 'loxone_commands'], 'chk_log_entries_source');
    t.index(['source', 'recorded_at'], 'idx_log_entries_source_time');
    t.index(['source_id'], 'idx_log_entries_source_id');
  });

  await knex.schema.createTable('notification_channels', (t) => {
    t.increments('id');
    t.text('name').notNullable();
    t.text('url').notNullable();
    t.integer('enabled').notNullable().defaultTo(1);
    t.text('created_at').notNullable();
  });

  await knex.schema.createTable('notification_rules', (t) => {
    t.increments('id');
    t.text('trigger_type').notNullable();
    t.text('name').notNullable();
    t.integer('enabled').notNullable().defaultTo(1);
    t.text('config').notNullable().defaultTo('{}');
    t.text('last_state').notNullable().defaultTo('{}');
    t.text('created_at').notNullable();
    t.integer('owner_user_id').references('id').inTable('users').onDelete('CASCADE');
    t.check(
      '?? IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['trigger_type', 'monitor_threshold', 'miniserver_status', 'mqtt_client_status', 'backup_failed', 'firmware_changed', 'loxsuite_update_available', 'battery_weak', 'device_firmware_changed', 'device_offline', 'gateway_client_firmware_mismatch'],
      'chk_notification_rules_trigger_type'
    );
  });

  await knex.schema.createTable('notification_rule_channels', (t) => {
    t.integer('rule_id').notNullable().references('id').inTable('notification_rules').onDelete('CASCADE');
    t.integer('channel_id').notNullable().references('id').inTable('notification_channels').onDelete('CASCADE');
    t.primary(['rule_id', 'channel_id']);
  });

  await knex.schema.createTable('notification_rule_subscribers', (t) => {
    t.integer('rule_id').notNullable().references('id').inTable('notification_rules').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.primary(['rule_id', 'user_id']);
  });

  // rule_id/notification_event_id are deliberately plain, unconstrained ints with NO `.references()`
  // — see legacy-sqlite-schema.js's own ensureNotificationEventsTable/ensureNotificationDismissalsTable
  // comments for why a FK here would be actively wrong (it would let deleting a rule silently erase
  // this persisted logbook's own history, defeating the point of keeping it).
  await knex.schema.createTable('notification_events', (t) => {
    t.increments('id');
    t.text('event_type').notNullable();
    t.text('severity').notNullable().defaultTo('info');
    t.text('title').notNullable();
    t.text('message').notNullable();
    t.integer('source_id');
    t.text('source_label');
    t.integer('rule_id');
    t.text('created_at').notNullable();
    t.index(['created_at'], 'idx_notification_events_created');
  });

  await knex.schema.createTable('notification_dismissals', (t) => {
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('notification_event_id').notNullable();
    t.text('dismissed_at').notNullable();
    t.primary(['user_id', 'notification_event_id']);
  });

  await knex.schema.createTable('loxone_hardware_devices', (t) => {
    t.increments('id');
    t.integer('miniserver_id').notNullable().references('id').inTable('miniservers').onDelete('CASCADE');
    t.text('device_key').notNullable();
    t.text('category').notNullable();
    t.text('type');
    t.text('name');
    t.text('place');
    t.text('serial');
    t.text('version');
    t.text('min_version');
    t.text('hw_version');
    t.integer('online');
    t.integer('battery');
    t.integer('batt_weak').notNullable().defaultTo(0);
    t.integer('bat_too_weak_for_update').notNullable().defaultTo(0);
    t.integer('quality_ext');
    t.integer('quality_dev');
    t.integer('hops');
    t.integer('time_diff');
    t.text('mac');
    t.text('updated_at').notNullable();
    t.unique(['miniserver_id', 'device_key']);
    t.index(['miniserver_id'], 'idx_loxone_hardware_devices_miniserver');
  });

  await seedFreshInstall(knex);
};

// Everything a genuinely fresh install needs before it can boot at all — the baseline-path
// equivalent of what ensureAccessRoles/ensureMqttSettings/ensureSsoSettings/ensureBackupSettings/
// migrateDashboardWidgetsToSharedPanels (the shared home Dashboard)/ensureAdminUser do for an
// upgrading SQLite install, condensed into their own END STATE for a database that has no history
// to walk forward through. See test/dbSeed.test.js for the assertions that keep this in sync with
// that end state.
async function seedFreshInstall(knex) {
  const now = new Date().toISOString();

  const adminRoleId = await insertReturningId(knex, 'access_roles', { name: 'Administrator', is_admin: 1 });
  const viewerRoleId = await insertReturningId(knex, 'access_roles', { name: 'Viewer', is_admin: 0 });
  for (const { key } of AREAS) {
    await knex('access_role_permissions').insert({ role_id: adminRoleId, area: key, can_view: 1, can_edit: 1 });
    await knex('access_role_permissions').insert({ role_id: viewerRoleId, area: key, can_view: 1, can_edit: 0 });
  }

  await knex('gateway_settings').insert({ id: 1 });
  await knex('sso_settings').insert({ id: 1 });
  await knex('backup_settings').insert({ id: 1 });

  // Same host/port/TLS parsing ensureMqttSettings() does — defaults to a local broker on the
  // standard port when MQTT_URL isn't set (or doesn't parse), matching docker-compose.yml's own
  // MQTT_URL: mqtt://127.0.0.1:1883 default.
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
  await knex('mqtt_settings').insert({
    id: 1,
    host,
    port,
    username: process.env.MQTT_USERNAME || null,
    password: process.env.MQTT_PASSWORD ? encrypt(process.env.MQTT_PASSWORD) : null,
    use_tls: useTls,
  });

  // The one shared home Dashboard every install has from the start (user_id NULL) — see
  // legacy-sqlite-schema.js's migrateDashboardWidgetsToSharedPanels, which a fresh legacy install
  // also always creates one of (there's just never anything to migrate INTO it there).
  await knex('custom_dashboards').insert({ user_id: null, name: 'Dashboard', position: 0, created_at: now });

  // Same env-var-gated first-admin-user seed as ensureAdminUser() — silently does nothing (same
  // warning logged by server startup elsewhere) if either var is missing, so this never creates a
  // half-configured account nobody asked for.
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    await knex('users').insert({ username: process.env.ADMIN_USERNAME, password_hash: hash, role_id: adminRoleId });
  }
}

// Plain `.insert(row)` with no `.returning()` returns a bare array of ids on SQLite (`[1]`) but the
// RAW pg driver result object on Postgres (verified empirically — NOT an array, so a naive
// `Array.isArray(result) ? result[0] : result` silently returns that whole object instead of an id
// on Postgres, corrupting the very next insert that uses it as a foreign key). `.returning('id')`
// instead produces the identical `[{id: N}]` shape on both, matching db/index.js's own
// insertReturningId() (kept as its own tiny local helper here rather than reusing that one, since
// this runs against a migration's own bare `knex` argument, a distinct instance/connection from the
// app's runtime facade).
async function insertReturningId(knex, table, row) {
  const result = await knex(table).insert(row).returning('id');
  return result[0].id;
}

exports.down = async function down(knex) {
  const tables = [
    'loxone_hardware_devices',
    'notification_dismissals',
    'notification_events',
    'notification_rule_subscribers',
    'notification_rule_channels',
    'notification_rules',
    'notification_channels',
    'log_entries',
    'dashboard_favorites',
    'dashboard_role_shares',
    'dashboard_shares',
    'panel_type_defaults',
    'dashboard_panel_monitors',
    'dashboard_panels',
    'custom_dashboards',
    'monitor_history',
    'monitors',
    'user_nav_prefs',
    'user_table_prefs',
    'loxone_mapping_translations',
    'mappings_loxone_to_mqtt',
    'mapping_translations',
    'mappings_mqtt_to_loxone',
    'command_catalog_overrides',
    'backup_settings',
    'sso_settings',
    'gateway_settings',
    'mqtt_settings',
    'miniservers',
    'access_role_permissions',
    'users',
    'access_roles',
  ];
  for (const table of tables) await knex.schema.dropTableIfExists(table);
};
