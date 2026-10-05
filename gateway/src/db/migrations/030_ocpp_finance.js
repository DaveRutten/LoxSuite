// OCPP costs and reimbursement (ocppFinance.js): per bridge what a charged kWh cost you and what you
// get back for it.
//
// ocpp_tariffs           the reimbursement per kWh with the date it takes effect (several rows = a
//                        history, e.g. a new rate per 1 January). None = no reimbursement shown.
// ocpp_bridges.finance   JSON: how the cost is calculated (real hourly price + solar, or a fixed
//                        rate), the value of solar, VAT of the tariff and of the display.
const { stringOnMysql, createTableIfMissing, addColumnsIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await createTableIfMissing(knex, 'ocpp_tariffs', (t) => {
    t.increments('id');
    t.integer('bridge_id').notNullable();
    stringOnMysql(t, knex, 'valid_from', 10).notNullable(); // YYYY-MM-DD, local date
    t.float('eur_per_kwh').notNullable();
    t.text('note');
    t.index(['bridge_id'], 'idx_ocpp_tariffs_bridge');
  });
  await addColumnsIfMissing(knex, 'ocpp_bridges', { finance: (t) => t.text('finance') });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ocpp_tariffs');
  if (await knex.schema.hasColumn('ocpp_bridges', 'finance')) await knex.schema.alterTable('ocpp_bridges', (t) => t.dropColumn('finance'));
};
