// external_charges: charging sessions away from home (a public charger, E-Flux and other charge cards),
// imported from the provider's export (CSV / Excel) or added by hand, so Driving & costs counts what
// charging really cost and not only the Wallbox at home. ext_id keeps an import from adding a session twice.
const { stringOnMysql, createTableIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await createTableIfMissing(knex, 'external_charges', (t) => {
    t.increments('id');
    t.integer('vehicle_id');
    stringOnMysql(t, knex, 'start_at', 32).notNullable();
    t.text('end_at');
    t.float('kwh').notNullable().defaultTo(0);
    t.float('cost_eur');
    stringOnMysql(t, knex, 'provider', 64);
    t.text('location');
    stringOnMysql(t, knex, 'source', 16).notNullable().defaultTo('manual');
    stringOnMysql(t, knex, 'ext_id', 128).notNullable().unique();
    t.text('created_at').notNullable();
    t.index(['vehicle_id', 'start_at'], 'ix_external_charges_vehicle');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('external_charges');
};
