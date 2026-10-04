// Widens notification_rules.trigger_type's named CHECK constraint to a new list of allowed values,
// for migrations that add notification triggers. Same backend-specific handling as
// migrations/003_backup_succeeded_trigger.js (read its header for the why): SQLite rebuilds the
// table, Postgres drops/adds the constraint, MySQL vs MariaDB differ in the DROP verb.
const CONSTRAINT_NAME = 'chk_notification_rules_trigger_type';

async function setNotificationTriggerTypes(knex, types) {
  const backend = knex.client.config.client;
  if (backend === 'better-sqlite3') {
    const checkSql = `?? IN (${types.map(() => '?').join(', ')})`;
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
      t.check(checkSql, ['trigger_type', ...types], CONSTRAINT_NAME);
    });
    await knex.raw(
      `INSERT INTO notification_rules_new (id, trigger_type, name, enabled, config, last_state, created_at, owner_user_id, last_sent_at, last_error, last_error_at)
       SELECT id, trigger_type, name, enabled, config, last_state, created_at, owner_user_id, last_sent_at, last_error, last_error_at FROM notification_rules`
    );
    await knex.schema.dropTable('notification_rules');
    await knex.raw('ALTER TABLE notification_rules_new RENAME TO notification_rules');
    return;
  }
  let dropVerb = 'DROP CONSTRAINT';
  if (backend === 'mysql2') {
    const [versionRows] = await knex.raw('SELECT VERSION() AS v');
    if (!/mariadb/i.test(versionRows?.[0]?.v || '')) dropVerb = 'DROP CHECK';
  }
  await knex.raw(`ALTER TABLE notification_rules ${dropVerb} ??`, [CONSTRAINT_NAME]);
  const valueList = types.map((v) => knex.raw('?', [v]).toString()).join(', ');
  await knex.raw(`ALTER TABLE notification_rules ADD CONSTRAINT ?? CHECK (?? IN (${valueList}))`, [CONSTRAINT_NAME, 'trigger_type']);
}

const BASE_TRIGGER_TYPES = [
  'monitor_threshold', 'miniserver_status', 'mqtt_client_status', 'backup_failed', 'backup_succeeded',
  'firmware_changed', 'loxsuite_update_available', 'battery_weak', 'device_firmware_changed',
  'device_offline', 'gateway_client_firmware_mismatch', 'vehicle_source_status',
];

module.exports = { setNotificationTriggerTypes, BASE_TRIGGER_TYPES };
