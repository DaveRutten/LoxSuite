// Backs "Schedule command" on the Client Activity page (routes/incoming.js) — an opt-in per-device
// schedule that re-sends one already-known MQTT command (from the Common Commands catalog, e.g. a
// Shelly's "Reboot") on a repeating schedule, without needing the whole cron-expression concept
// exposed to the person configuring it.
//
// mqtt_topic/mqtt_payload are resolved ONCE, at creation time, from whichever catalog command was
// picked (device id already substituted in) — not a live reference back to the catalog by key. The
// catalog is itself user-editable (command_catalog_overrides) and a later edit or removal of that
// entry must never silently change or break an already-saved schedule; a schedule keeps doing
// exactly what it said it would when it was created, same as e.g. a dashboard panel's own config
// isn't re-derived from a monitor's current settings on every render either.
exports.up = async function up(knex) {
  await knex.schema.createTable('scheduled_device_commands', (t) => {
    t.increments('id');
    t.text('device_key').notNullable();
    t.text('family_key').notNullable();
    t.text('command_label').notNullable();
    t.text('mqtt_topic').notNullable();
    t.text('mqtt_payload').notNullable();
    t.text('interval_type').notNullable();
    t.integer('interval_days');
    t.text('weekdays');
    t.text('time_of_day').notNullable();
    t.integer('enabled').notNullable().defaultTo(1);
    t.text('last_run_at');
    t.text('last_status');
    t.text('last_error');
    t.text('created_at').notNullable();
    t.check('?? IN (?, ?, ?)', ['interval_type', 'daily', 'every_n_days', 'weekly'], 'chk_scheduled_device_commands_interval_type');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('scheduled_device_commands');
};
