// Temperatures, for learning how consumption depends on the weather (temperature.js):
//
// solar_forecast.temp_c  outdoor temperature per hour (Open-Meteo, the same call as the solar forecast;
//                        past hours keep the latest — closest to what it really was)
// load_temp_hourly       per consumer and hour: the average of its temperature signal (room for a heat
//                        pump, tank for a boiler) and the minutes it was on — how fast it cools down
const { addColumnsIfMissing, createTableIfMissing, stringOnMysql } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await addColumnsIfMissing(knex, 'solar_forecast', { temp_c: (t) => t.float('temp_c') });
  await createTableIfMissing(knex, 'load_temp_hourly', (t) => {
    t.increments('id');
    t.integer('load_id').notNullable();
    stringOnMysql(t, knex, 'hour', 32).notNullable();
    t.float('temp_sum').notNullable().defaultTo(0);
    t.integer('temp_n').notNullable().defaultTo(0);
    t.float('on_min').notNullable().defaultTo(0);
    t.unique(['load_id', 'hour'], { indexName: 'uq_load_temp_hourly' });
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('load_temp_hourly');
  if (await knex.schema.hasColumn('solar_forecast', 'temp_c')) await knex.schema.alterTable('solar_forecast', (t) => t.dropColumn('temp_c'));
};
