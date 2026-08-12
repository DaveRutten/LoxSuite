// Adds 'backup_succeeded' as a selectable trigger_type (see notifications.js's TRIGGER_TYPES and
// its own notifyBackupSucceeded) — a sibling of the existing 'backup_failed', kept as its own
// distinct trigger rather than making 'backup_failed' also fire on success, so an existing
// "Backup failed" rule someone already set up keeps meaning exactly what its name says; anyone who
// also wants a success notification adds a second, separate rule for it.
//
// notification_rules.trigger_type is guarded by a named CHECK constraint (see 001_baseline.js) —
// widening its allowed value list needs backend-specific handling, since none of the three ways to
// do this are actually the same SQL:
//  - Postgres: ALTER TABLE ... DROP CONSTRAINT <name> / ADD CONSTRAINT <name> CHECK (...) — the
//    standard syntax, and what it's actually named there.
//  - MySQL/MariaDB (8.0.16+, the only versions that support CHECK at all): the equivalent verb is
//    DROP CHECK, not DROP CONSTRAINT — MySQL keeps its own vocabulary for these even though the ADD
//    side reuses the same ADD CONSTRAINT ... CHECK (...) syntax as Postgres.
//  - SQLite has no ALTER TABLE ... DROP/ADD CONSTRAINT of any kind — the only way to change a CHECK
//    constraint at all is the standard "rebuild the table" dance: create a new table with the
//    constraint already right, copy every row across, drop the old table, rename the new one into
//    its place. Safe to do here without any foreign-key bookkeeping around notification_rule_
//    channels/notification_rule_subscribers (both FK-reference this table's id) — this app never
//    turns SQLite's own `foreign_keys` pragma on (see db/index.js), so nothing is enforced or
//    cascaded at the engine level regardless of which physical table currently holds this name.
const NEW_TRIGGER_TYPES = [
  'monitor_threshold', 'miniserver_status', 'mqtt_client_status', 'backup_failed', 'backup_succeeded',
  'firmware_changed', 'loxsuite_update_available', 'battery_weak', 'device_firmware_changed',
  'device_offline', 'gateway_client_firmware_mismatch',
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
      t.check(checkSql, checkBindings, CONSTRAINT_NAME);
    });
    await knex.raw(
      `INSERT INTO notification_rules_new (id, trigger_type, name, enabled, config, last_state, created_at, owner_user_id)
       SELECT id, trigger_type, name, enabled, config, last_state, created_at, owner_user_id FROM notification_rules`
    );
    await knex.schema.dropTable('notification_rules');
    await knex.raw('ALTER TABLE notification_rules_new RENAME TO notification_rules');
  } else {
    // Postgres and MySQL/MariaDB both reject bound ($1.../?) parameters inside an ALTER TABLE ...
    // CHECK (...) expression — found running this for real against Postgres: "bind message
    // supplies 11 parameters, but prepared statement requires 0". Postgres's DDL parser simply
    // doesn't support parameter placeholders inside a CHECK expression the way it does for a DML
    // statement's literals, and MySQL/MariaDB's own DDL parser has the same restriction even where
    // mysql2's client-side text-protocol substitution might otherwise have papered over it. These
    // 11 values are fixed constants defined above in this file, not external input, so inlining
    // them as escaped SQL string literals directly in the DDL text — via knex.raw('?', [v])'s own
    // dialect-aware escaping, not hand-rolled quoting — is safe, and is the only form either
    // backend actually accepts here.
    const dropVerb = backend === 'mysql2' ? 'DROP CHECK' : 'DROP CONSTRAINT';
    await knex.raw(`ALTER TABLE notification_rules ${dropVerb} ??`, [CONSTRAINT_NAME]);
    const valueList = NEW_TRIGGER_TYPES.map((v) => knex.raw('?', [v]).toString()).join(', ');
    await knex.raw(`ALTER TABLE notification_rules ADD CONSTRAINT ?? CHECK (?? IN (${valueList}))`, [CONSTRAINT_NAME, 'trigger_type']);
  }
};

// Not implemented — same as 001_baseline.js's own down() only ever tearing everything down rather
// than surgically reverting one change; rolling the CHECK list back would also just orphan any
// 'backup_succeeded' rule row someone had already created since this ran.
exports.down = async function down() {};
