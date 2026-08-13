// Backs the setup wizard's own "existing SQLite data found" step (see routes/setup.js) — set once
// an admin either runs the import or explicitly dismisses it, so the step never asks again after
// that. Nullable/additive, same pattern as every other single-purpose gateway_settings column added
// since 001_baseline.js (setup_wizard_completed, etc.) — null means "not yet resolved".
exports.up = async function up(knex) {
  await knex.schema.alterTable('gateway_settings', (t) => {
    t.text('sqlite_import_resolved_at');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('gateway_settings', (t) => {
    t.dropColumn('sqlite_import_resolved_at');
  });
};
