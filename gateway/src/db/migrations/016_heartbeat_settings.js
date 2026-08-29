// Dead-man's-switch heartbeat. LoxSuite is your alert channel for the house, but nothing tells you
// when LoxSuite ITSELF is down — a crash, a container that won't come back up after an update, a
// wedged event loop — because the very thing that would send that alert is what's gone. The fix is
// to ping OUTWARD to an external watchdog (a healthchecks.io / Uptime Kuma "push" URL) on a fixed
// interval; if the pings stop arriving, that external service is what alerts you. This can't be
// done from inside the notification channels for the same reason it's needed at all.
//
// heartbeat_url — the watchdog URL to GET on each tick; empty (default) means the heartbeat is off.
// heartbeat_interval_minutes — how often to ping; 0 (default) also means off. Both are read live by
//   heartbeat.js's own ticker, so changing them in Settings takes effect without a restart.
exports.up = async function up(knex) {
  await knex.schema.alterTable('gateway_settings', (t) => {
    t.text('heartbeat_url');
    t.integer('heartbeat_interval_minutes').notNullable().defaultTo(0);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('gateway_settings', (t) => {
    t.dropColumn('heartbeat_url');
    t.dropColumn('heartbeat_interval_minutes');
  });
};
