// Two queries this app runs very often had no supporting index at all — harmless on SQLite (a
// local file, no network round-trip to pay for a sequential scan) but measured as a genuine slow
// query on a real Postgres install: mqttClient.js's own message handler re-read every enabled
// mapping on every single incoming MQTT message (the broker subscription is '#', every topic), and
// monitorCollector.js's Loxone poll loop re-reads every enabled Loxone monitor on every 5s tick.
// The mapping re-query per message was ALSO fixed with an in-memory cache (see mqttClient.js's own
// reloadMappings()) — this index still matters for that cache's own periodic full reload, and for
// the Loxone monitor poll loop, which reads fresh from the DB every tick by design.
exports.up = async function up(knex) {
  await knex.schema.alterTable('mappings_mqtt_to_loxone', (t) => {
    t.index(['enabled'], 'idx_mappings_mqtt_to_loxone_enabled');
  });
  await knex.schema.alterTable('monitors', (t) => {
    t.index(['source_type', 'enabled'], 'idx_monitors_source_type_enabled');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('mappings_mqtt_to_loxone', (t) => {
    t.dropIndex(['enabled'], 'idx_mappings_mqtt_to_loxone_enabled');
  });
  await knex.schema.alterTable('monitors', (t) => {
    t.dropIndex(['source_type', 'enabled'], 'idx_monitors_source_type_enabled');
  });
};
