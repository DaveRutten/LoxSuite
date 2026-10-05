// Modules (modules.js): which parts of LoxSuite are switched on in this installation. Filled on the
// first start after the update: every module already in use is switched on, so nothing disappears.
const { stringOnMysql, createTableIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await createTableIfMissing(knex, 'app_modules', (t) => {
    stringOnMysql(t, knex, 'module_key', 64).primary();
    t.integer('enabled').notNullable().defaultTo(0);
    t.text('updated_at');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('app_modules');
};
