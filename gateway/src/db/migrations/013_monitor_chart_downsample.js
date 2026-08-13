// Backs the "Downsample large chart series" toggle (see settings-general.ejs, routes/monitor.js's
// series.json) — on by default, since the alternative (a monitor with far more readings than the
// chart's own row budget silently showing only its newest slice, with no indication older data
// within the range even exists) is worse for virtually everyone. Additive/nullable-by-default-value
// pattern, same as every other single-purpose gateway_settings column added since 001_baseline.js.
exports.up = async function up(knex) {
  await knex.schema.alterTable('gateway_settings', (t) => {
    t.integer('monitor_chart_downsample_enabled').notNullable().defaultTo(1);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('gateway_settings', (t) => {
    t.dropColumn('monitor_chart_downsample_enabled');
  });
};
