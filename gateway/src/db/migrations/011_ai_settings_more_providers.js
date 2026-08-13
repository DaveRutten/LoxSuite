// Widens chk_ai_settings_provider again — 010_ai_settings_ollama.js added 'ollama' to the original
// ('anthropic') list; this adds 'openai' and 'gemini' (see gateway/src/llm/openai.js and gemini.js)
// the same way that migration's own comment predicted ("Widen this list ... when a second provider
// adapter ships") — now a third and fourth. Same Postgres/MySQL DDL-bind-parameter restriction as
// every other CHECK-widening migration in this app (003_backup_succeeded_trigger.js first found and
// fixed it, 010 repeated the fix for this exact constraint) — these values are fixed constants, not
// external input, so inlining them as escaped SQL literals via knex.raw('?', [v])'s own
// dialect-aware escaping is what either backend actually accepts here. SQLite still has no ALTER
// TABLE ... DROP/ADD CONSTRAINT at all, hence the same "rebuild the table" dance.
const PROVIDERS = ['anthropic', 'ollama', 'openai', 'gemini'];
const CONSTRAINT_NAME = 'chk_ai_settings_provider';

exports.up = async function up(knex) {
  const backend = knex.client.config.client;

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
    await nudgeFreshRowToOllama(knex);
    return;
  }

  const dropVerb = backend === 'mysql2' ? 'DROP CHECK' : 'DROP CONSTRAINT';
  await knex.raw(`ALTER TABLE ai_settings ${dropVerb} ??`, [CONSTRAINT_NAME]);
  const valueList = PROVIDERS.map((v) => knex.raw('?', [v]).toString()).join(', ');
  await knex.raw(`ALTER TABLE ai_settings ADD CONSTRAINT ?? CHECK (?? IN (${valueList}))`, [CONSTRAINT_NAME, 'provider']);

  await nudgeFreshRowToOllama(knex);
};

// 006_ai_settings.js's own seedFreshInstall-equivalent (its own up() inserts the singleton row
// directly) picked 'anthropic' as the provider default at the time — this project's own direction
// has since moved to recommending Ollama first (self-hosted, no API key, no per-token billing; see
// docker-compose.yml's own bundled service and admin-ai.ejs's provider order). A schema-level
// DEFAULT change here wouldn't retroactively do anything (006's INSERT already ran, once, forever,
// on every install that's ever migrated at all) — this instead flips the row directly, but ONLY
// when it still looks exactly like what 006 originally seeded and NOTHING has touched it since
// (enabled=0, provider='anthropic', api_key/base_url both still null). That signature can only ever
// match a row a human hasn't looked at yet — a fresh install migrating straight through 001-011 in
// one batch, or an existing install that's simply never opened Administration > AI Assistant at
// all — never one where an admin already made a real choice (including deliberately choosing/
// keeping Anthropic with it still disabled), which changes at least one of those columns already.
async function nudgeFreshRowToOllama(knex) {
  await knex('ai_settings')
    .where({ id: 1, enabled: 0, provider: 'anthropic' })
    .whereNull('api_key')
    .whereNull('base_url')
    .update({ provider: 'ollama', model: 'llama3.1' });
}

// Not implemented — same reasoning as every other migration in this app: rolling the provider list
// back would orphan any row someone already saved with provider='openai'/'gemini'.
exports.down = async function down() {};
