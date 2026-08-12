// Chat history for the AI Assistant feature — personal to each user (user_id, ON DELETE CASCADE),
// not shared/admin-visible, confirmed as the v1 scope. A conversation optionally targets one
// Miniserver (the one whose MCP tools the assistant can use in it); deleting that Miniserver
// clears the reference (SET NULL) rather than erasing the conversation itself — the chat history
// is still meaningful to read even if the Miniserver it was about is gone.
//
// Kept as its own local copy of 001_baseline.js's stringOnMysql() helper — see 006_ai_settings.js's
// own comment for why (that file's helper isn't exported/shared either).
function stringOnMysql(t, knex, col) {
  return knex.client.config.client === 'mysql2' ? t.string(col) : t.text(col);
}

exports.up = async function up(knex) {
  await knex.schema.createTable('ai_conversations', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('miniserver_id').unsigned().references('id').inTable('miniservers').onDelete('SET NULL');
    t.text('title');
    t.text('created_at').notNullable();
    // updated_at needs the bounded VARCHAR form (not plain TEXT) specifically because it's part of
    // an index below — same reason monitor_history.recorded_at/log_entries.recorded_at get the same
    // treatment in 001_baseline.js: MySQL/MariaDB refuse to build a key over a TEXT/BLOB column at
    // all ("BLOB/TEXT column used in key specification without a key length").
    stringOnMysql(t, knex, 'updated_at').notNullable();
    t.index(['user_id', 'updated_at'], 'idx_ai_conversations_user_updated');
  });

  await knex.schema.createTable('ai_messages', (t) => {
    t.increments('id');
    t.integer('conversation_id').unsigned().notNullable().references('id').inTable('ai_conversations').onDelete('CASCADE');
    // Plain TEXT, not stringOnMysql — same as monitors.source_type/dashboard_panels.panel_type in
    // 001_baseline.js: a CHECK constraint alone doesn't trigger either MySQL TEXT restriction, only
    // a schema-level default or key/index usage does, and this column has neither.
    t.text('role').notNullable();
    // No schema-level .defaultTo('') here even though every insert supplies one — content is an
    // unbounded chat message body, exactly the "genuinely unbounded column that also needs an
    // explicit default" case 001_baseline.js's own top-of-file comment describes for
    // gateway_settings.notification_templates: MySQL/MariaDB can't put a DEFAULT on TEXT at all, so
    // the empty-string starting value for a still-streaming assistant row is supplied by the
    // application (aiChat.js's own insert), not the schema.
    t.text('content').notNullable();
    t.text('tool_calls_json');
    stringOnMysql(t, knex, 'status').notNullable().defaultTo('complete');
    t.text('error');
    t.text('created_at').notNullable();
    t.index(['conversation_id', 'id'], 'idx_ai_messages_conversation_id');
    t.check('?? IN (?, ?, ?)', ['role', 'user', 'assistant', 'tool'], 'chk_ai_messages_role');
    t.check('?? IN (?, ?, ?)', ['status', 'streaming', 'complete', 'error'], 'chk_ai_messages_status');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ai_messages');
  await knex.schema.dropTableIfExists('ai_conversations');
};
