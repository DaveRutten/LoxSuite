// Energy manager: more than one Loxone signal per consumer. Next to its meter (optional now), a
// consumer can have an on/off state, a status (an enumerator: "0 = off, 1 = washing, 2 = spinning"...),
// a power (W/kW) and an energy counter (kWh/Wh) — the choice of states is in energy_loads.settings.
// What LoxSuite learns from them is kept here:
//
// load_status_hourly  per consumer, per UTC hour and per status (or 'on'/'off'): minutes in it and the
//                     kWh used meanwhile — the typical power per status, how long it usually runs.
// load_events         every change of on/off or status (the timeline on the consumer's page).
const { stringOnMysql, createTableIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await createTableIfMissing(knex, 'load_status_hourly', (t) => {
    t.increments('id');
    t.integer('load_id').notNullable();
    stringOnMysql(t, knex, 'hour', 32).notNullable();
    stringOnMysql(t, knex, 'status', 64).notNullable();
    t.float('minutes').notNullable().defaultTo(0);
    t.float('kwh').notNullable().defaultTo(0);
    t.integer('measured').notNullable().defaultTo(0); // 1 = the kWh came from a meter/power/counter, 0 = estimated
    t.unique(['load_id', 'hour', 'status'], { indexName: 'uq_load_status_hourly' });
  });
  await createTableIfMissing(knex, 'load_events', (t) => {
    t.increments('id');
    t.integer('load_id').notNullable();
    stringOnMysql(t, knex, 'ts', 32).notNullable();
    t.integer('on_state');
    t.text('status');
    t.text('label');
    t.float('kw');
    t.index(['load_id', 'ts'], 'idx_load_events_load_ts');
  });
};

exports.down = async function down(knex) {
  for (const t of ['load_events', 'load_status_hourly']) await knex.schema.dropTableIfExists(t);
};
