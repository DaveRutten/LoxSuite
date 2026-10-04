// Smart charging > Charge log (chargeLog.js): what the Wallbox, LoxSuite and the car did during each
// session, sampled every 10 s on change (at least once a minute), kept 45 days.
//   ts           ISO time
//   session_key  's<connect ms>' per plug-in, 'idle' for values sent with no car connected
//   event        what happened at that moment (plug-in, value sent, unplug), else null
//   data         JSON snapshot (Wallbox states, values sent, planner advice, car readings)
const { stringOnMysql, createTableIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await createTableIfMissing(knex, 'charge_log', (t) => {
    t.increments('id');
    stringOnMysql(t, knex, 'ts', 32).notNullable();
    stringOnMysql(t, knex, 'session_key', 32).notNullable();
    t.text('event');
    t.text('data');
    t.index(['session_key', 'ts'], 'idx_charge_log_session_ts');
    t.index(['ts'], 'idx_charge_log_ts');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('charge_log');
};
