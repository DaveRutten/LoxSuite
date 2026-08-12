// The AI Assistant feature's global half: which LLM provider drives it, the encrypted API key, and
// the knobs shared across every Miniserver (as opposed to 005_ai_mcp_columns.js's per-Miniserver
// enable/MCP-connection fields). Singleton table, same `CHECK (id = 1)` shape as mqtt_settings/
// sso_settings/backup_settings in 001_baseline.js — `enabled` defaults to 0, so an upgrading
// install that runs this migration gets an inert row, not a live feature it never asked for.
//
// provider/model/effort all get an explicit schema-level default AND are plain TEXT — per
// 001_baseline.js's own top-of-file comment, MySQL/MariaDB can't declare a DEFAULT on a TEXT/BLOB
// column at all, so (unlike an unbounded value that needs its default supplied by the application
// instead, e.g. gateway_settings.notification_templates) these three get the bounded VARCHAR form
// via the same stringOnMysql() helper 001_baseline.js defines — safe to bound since all three are
// short, fixed-vocabulary values enforced by their own CHECK constraints below, not free text.
//
// Kept as its own tiny local copy rather than importing 001_baseline.js's version — that file's
// own helper isn't exported, matching how insertReturningId() there explains the same choice for
// itself.
function stringOnMysql(t, knex, col) {
  return knex.client.config.client === 'mysql2' ? t.string(col) : t.text(col);
}

exports.up = async function up(knex) {
  await knex.schema.createTable('ai_settings', (t) => {
    t.integer('id').primary();
    t.integer('enabled').notNullable().defaultTo(0);
    stringOnMysql(t, knex, 'provider').notNullable().defaultTo('anthropic');
    t.text('api_key');
    stringOnMysql(t, knex, 'model').notNullable().defaultTo('claude-opus-5');
    stringOnMysql(t, knex, 'effort').notNullable().defaultTo('medium');
    t.integer('suggestions_mode').notNullable().defaultTo(0);
    t.integer('max_tool_calls_per_turn').notNullable().defaultTo(20);
    t.check('?? = 1', ['id'], 'chk_ai_settings_singleton');
    // Widen this list (and its adapter in gateway/src/llm/) when a second provider adapter ships —
    // deliberately narrow for now rather than accepting a provider name nothing can actually serve.
    t.check('?? IN (?)', ['provider', 'anthropic'], 'chk_ai_settings_provider');
    t.check('?? IN (?, ?, ?, ?, ?)', ['effort', 'low', 'medium', 'high', 'xhigh', 'max'], 'chk_ai_settings_effort');
  });

  // This table has no seedFreshInstall()-style caller — unlike mqtt_settings/sso_settings/
  // backup_settings, which only get their singleton row from 001_baseline.js's own one-time fresh-
  // install seed (or an upgrading install's own ensureXSettings() helper), ai_settings didn't exist
  // at baseline at all. Every install, fresh or upgrading, reaches its row the same way: by running
  // this migration once — so seeding it here, directly in the same up() that creates the table, is
  // both correct and the only place that needs to.
  await knex('ai_settings').insert({ id: 1 });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ai_settings');
};
