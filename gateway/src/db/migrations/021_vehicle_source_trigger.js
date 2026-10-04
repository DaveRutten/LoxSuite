// Adds 'vehicle_source_status' as a notification trigger (see notifications.js's TRIGGER_TYPES and
// checkVehicleSourceStatus): a vehicle's live data source (MQTT / HTTP / Homey / Home Assistant,
// see vehicles.js) stopped answering, went stale, or recovered. Same CHECK-widening approach as
// 003_backup_succeeded_trigger.js (read its header for why every backend needs its own SQL); the
// SQLite table rebuild here also carries migration 015's delivery-status columns.
const NEW_TRIGGER_TYPES = [
  'monitor_threshold', 'miniserver_status', 'mqtt_client_status', 'backup_failed', 'backup_succeeded',
  'firmware_changed', 'loxsuite_update_available', 'battery_weak', 'device_firmware_changed',
  'device_offline', 'gateway_client_firmware_mismatch', 'vehicle_source_status',
];
const CONSTRAINT_NAME = 'chk_notification_rules_trigger_type';

exports.up = async function up(knex) {
  const backend = knex.client.config.client;
  const checkSql = `?? IN (${NEW_TRIGGER_TYPES.map(() => '?').join(', ')})`;
  const checkBindings = ['trigger_type', ...NEW_TRIGGER_TYPES];

  if (backend === 'better-sqlite3') {
    await knex.schema.createTable('notification_rules_new', (t) => {
      t.increments('id');
      t.text('trigger_type').notNullable();
      t.text('name').notNullable();
      t.integer('enabled').notNullable().defaultTo(1);
      t.text('config').notNullable().defaultTo('{}');
      t.text('last_state').notNullable().defaultTo('{}');
      t.text('created_at').notNullable();
      t.integer('owner_user_id').unsigned().references('id').inTable('users').onDelete('CASCADE');
      t.text('last_sent_at');
      t.text('last_error');
      t.text('last_error_at');
      t.check(checkSql, checkBindings, CONSTRAINT_NAME);
    });
    await knex.raw(
      `INSERT INTO notification_rules_new (id, trigger_type, name, enabled, config, last_state, created_at, owner_user_id, last_sent_at, last_error, last_error_at)
       SELECT id, trigger_type, name, enabled, config, last_state, created_at, owner_user_id, last_sent_at, last_error, last_error_at FROM notification_rules`
    );
    await knex.schema.dropTable('notification_rules');
    await knex.raw('ALTER TABLE notification_rules_new RENAME TO notification_rules');
  } else {
    let dropVerb = 'DROP CONSTRAINT';
    if (backend === 'mysql2') {
      const [versionRows] = await knex.raw('SELECT VERSION() AS v');
      if (!/mariadb/i.test(versionRows?.[0]?.v || '')) dropVerb = 'DROP CHECK';
    }
    await knex.raw(`ALTER TABLE notification_rules ${dropVerb} ??`, [CONSTRAINT_NAME]);
    const valueList = NEW_TRIGGER_TYPES.map((v) => knex.raw('?', [v]).toString()).join(', ');
    await knex.raw(`ALTER TABLE notification_rules ADD CONSTRAINT ?? CHECK (?? IN (${valueList}))`, [CONSTRAINT_NAME, 'trigger_type']);
  }
};

// Not implemented, same as 003: narrowing the list again would orphan rules created since.
exports.down = async function down() {};
