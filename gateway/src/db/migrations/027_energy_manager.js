// Energy manager (energyManager.js): other big consumers next to the car, planned in shadow mode
// first (LoxSuite shows what it would do; nothing is sent until a load is switched to Live).
//
// energy_loads   one row per consumer: kind 'dhw' (tap water), 'heatpump' (space heating/cooling),
//                'appliance' (washing machine, dryer...); its Loxone meter, priority, settings (JSON)
//                and the names of the virtual inputs it would drive.
// load_hourly    kWh per load per UTC hour (live from the meter total, or imported from Loxone).
// load_runs      appliance runs (start/end/kWh, actual cost, best start in hindsight and its cost),
//                and planned runs the user asked for (ready-by).
// em_log         every change of a shadow signal (what LoxSuite would have sent, and why).
const { stringOnMysql, createTableIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await createTableIfMissing(knex, 'energy_loads', (t) => {
    t.increments('id');
    t.text('name').notNullable();
    stringOnMysql(t, knex, 'kind', 16).notNullable();
    t.integer('enabled').notNullable().defaultTo(1);
    t.integer('priority').notNullable().defaultTo(5);
    t.integer('miniserver_id');
    t.text('meter_uuid');
    t.text('status_uuid');
    t.text('settings');
    stringOnMysql(t, knex, 'output', 16).notNullable().defaultTo('shadow');
    t.text('created_at').notNullable();
  });
  await createTableIfMissing(knex, 'load_hourly', (t) => {
    t.increments('id');
    t.integer('load_id').notNullable();
    stringOnMysql(t, knex, 'hour', 32).notNullable();
    t.float('kwh').notNullable().defaultTo(0);
    stringOnMysql(t, knex, 'source', 16).notNullable().defaultTo('live');
    t.unique(['load_id', 'hour'], { indexName: 'uq_load_hourly' });
  });
  await createTableIfMissing(knex, 'load_runs', (t) => {
    t.increments('id');
    t.integer('load_id').notNullable();
    stringOnMysql(t, knex, 'start_at', 32).notNullable();
    t.text('end_at');
    t.float('kwh');
    t.float('cost_eur');
    t.text('best_start');
    t.float('best_cost_eur');
    t.text('ready_by');
    t.float('duration_h');
    t.text('label');
    stringOnMysql(t, knex, 'kind', 16).notNullable().defaultTo('run'); // 'run' (measured) | 'request' (planned)
    t.index(['load_id', 'start_at'], 'idx_load_runs_load_start');
  });
  await createTableIfMissing(knex, 'em_log', (t) => {
    t.increments('id');
    stringOnMysql(t, knex, 'ts', 32).notNullable();
    t.integer('load_id');
    stringOnMysql(t, knex, 'signal_name', 64).notNullable();
    t.text('value');
    t.text('reason');
    t.index(['ts'], 'idx_em_log_ts');
    t.index(['load_id', 'ts'], 'idx_em_log_load_ts');
  });
};

exports.down = async function down(knex) {
  for (const t of ['em_log', 'load_runs', 'load_hourly', 'energy_loads']) await knex.schema.dropTableIfExists(t);
};
