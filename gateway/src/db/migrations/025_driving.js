// Wallbox > Driving (driving.js): the electric consumption learned from odometer + state of charge,
// stored per car so the planner, agenda and reminders use it when no consumption is set by hand.
//   kwh_per_km_learned     learned kWh per km (null until there is enough data)
//   kwh_per_km_learned_km  km of driving it is based on
const { addColumnsIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await addColumnsIfMissing(knex, 'vehicles', {
    kwh_per_km_learned: (t) => t.float('kwh_per_km_learned'),
    kwh_per_km_learned_km: (t) => t.float('kwh_per_km_learned_km'),
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('vehicles', (t) => { t.dropColumn('kwh_per_km_learned'); t.dropColumn('kwh_per_km_learned_km'); });
};
