// What the energy-manager modules learn from (energyModules.js): the tank, weather, room and run samples,
// one row per series and hour (a JSON array of that hour's minute samples), so a restart doesn't start
// the learning over. Kept 60 days.
const { createTableIfMissing, stringOnMysql } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await createTableIfMissing(knex, 'em_samples', (t) => {
    t.increments('id');
    stringOnMysql(t, knex, 'series', 16).notNullable();
    stringOnMysql(t, knex, 'hour', 32).notNullable();
    t.text('data').notNullable();
    t.unique(['series', 'hour'], { indexName: 'uq_em_samples' });
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('em_samples');
};
