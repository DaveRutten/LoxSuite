// Widens ai_settings for a second LLM provider adapter (see gateway/src/llm/ollama.js) — exactly
// the moment 006_ai_settings.js's own comment on chk_ai_settings_provider called out ("Widen this
// list ... when a second provider adapter ships"). Two changes:
//  - chk_ai_settings_provider: 'anthropic' -> 'anthropic' or 'ollama'.
//  - base_url: nullable, only meaningful for Ollama (its own/an OpenWebUI instance's HTTP address,
//    e.g. "http://ollama:11434") — Anthropic's own endpoint is fixed and never configurable here.
//
// Postgres and MySQL/MariaDB both reject bound ($1.../?) parameters inside an ALTER TABLE ... ADD
// CONSTRAINT ... CHECK (...) expression — the exact bug found (and fixed the same way) in
// 003_backup_succeeded_trigger.js: Postgres's DDL parser doesn't support parameter placeholders
// inside a CHECK expression the way it does for a DML statement's literals. These two values are
// fixed constants, not external input, so inlining them as escaped SQL literals via
// knex.raw('?', [v])'s own dialect-aware escaping (not hand-rolled quoting) is safe, and is the
// only form either backend actually accepts here. SQLite has no ALTER TABLE ... DROP/ADD
// CONSTRAINT at all — same "rebuild the table" dance 003_backup_succeeded_trigger.js's own comment
// explains in full.
const PROVIDERS = ['anthropic', 'ollama'];
const CONSTRAINT_NAME = 'chk_ai_settings_provider';

exports.up = async function up(knex) {
  const backend = knex.client.config.client;

  await knex.schema.alterTable('ai_settings', (t) => {
    t.text('base_url');
  });

  if (backend === 'better-sqlite3') {
    await knex.schema.createTable('ai_settings_new', (t) => {
      t.integer('id').primary();
      t.integer('enabled').notNullable().defaultTo(0);
      t.text('provider').notNullable().defaultTo('anthropic');
      t.text('api_key');
      t.text('model').notNullable().defaultTo('claude-opus-5');
      t.text('effort').notNullable().defaultTo('medium');
      t.integer('suggestions_mode').notNullable().defaultTo(0);
      t.integer('max_tool_calls_per_turn').notNullable().defaultTo(20);
      t.text('base_url');
      t.check('?? = 1', ['id'], 'chk_ai_settings_singleton');
      t.check(`?? IN (${PROVIDERS.map(() => '?').join(', ')})`, ['provider', ...PROVIDERS], CONSTRAINT_NAME);
      t.check('?? IN (?, ?, ?, ?, ?)', ['effort', 'low', 'medium', 'high', 'xhigh', 'max'], 'chk_ai_settings_effort');
    });
    await knex.raw(
      `INSERT INTO ai_settings_new (id, enabled, provider, api_key, model, effort, suggestions_mode, max_tool_calls_per_turn, base_url)
       SELECT id, enabled, provider, api_key, model, effort, suggestions_mode, max_tool_calls_per_turn, base_url FROM ai_settings`
    );
    await knex.schema.dropTable('ai_settings');
    await knex.raw('ALTER TABLE ai_settings_new RENAME TO ai_settings');
    return;
  }

  const dropVerb = backend === 'mysql2' ? 'DROP CHECK' : 'DROP CONSTRAINT';
  await knex.raw(`ALTER TABLE ai_settings ${dropVerb} ??`, [CONSTRAINT_NAME]);
  const valueList = PROVIDERS.map((v) => knex.raw('?', [v]).toString()).join(', ');
  await knex.raw(`ALTER TABLE ai_settings ADD CONSTRAINT ?? CHECK (?? IN (${valueList}))`, [CONSTRAINT_NAME, 'provider']);
};

// Not implemented — same reasoning as every other migration in this app: rolling the provider list
// back would orphan any row someone already saved with provider='ollama'.
exports.down = async function down() {};
