// What LoxSuite predicted next to what really happened, so it can see how good its predictions are and
// correct itself (forecastLog.js).
//
// forecast_log  kind: 'pv' / 'house' (kWh in an hour), 'load:<id>' (a consumer's kWh in an hour),
//               'depart' / 'arrive' (the car: when it would leave / come home, epoch ms).
//               target: the hour (ISO) or the day of the event; horizon: 'h1' (made ~1 hour ahead),
//               'd1' (made the day before), 'event' (the car). predicted / actual in the kind's unit.
const { stringOnMysql, createTableIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await createTableIfMissing(knex, 'forecast_log', (t) => {
    t.increments('id');
    stringOnMysql(t, knex, 'kind', 32).notNullable();
    stringOnMysql(t, knex, 'target', 32).notNullable();
    stringOnMysql(t, knex, 'horizon', 8).notNullable();
    t.float('predicted');
    t.float('actual');
    t.text('made_at').notNullable();
    t.text('note');
    t.unique(['kind', 'target', 'horizon'], { indexName: 'uq_forecast_log' });
    t.index(['kind', 'target'], 'idx_forecast_log_kind_target');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('forecast_log');
};
