// The relative humidity per hour, with the outdoor temperature from the same Open-Meteo call: an air
// source heat pump defrosts most around freezing in humid air, so the heat pump module learns its
// defrosting and COP per temperature and humidity (heatPumpWeather.js) and plans with the forecast.
const { addColumnsIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await addColumnsIfMissing(knex, 'solar_forecast', { rh_pct: (t) => t.float('rh_pct') });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('solar_forecast', 'rh_pct')) await knex.schema.alterTable('solar_forecast', (t) => t.dropColumn('rh_pct'));
};
