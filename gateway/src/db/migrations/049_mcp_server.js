// LoxSuite's own MCP server (/mcp, see mcp/server.js): an AI assistant such as Claude Code reads what
// LoxSuite knows (mappings, MQTT clients and topics, the Loxone commands log, charts) to find out why
// something doesn't work, and — when allowed — sets things up (mappings, monitors, dashboards).
//   mcp_tokens   one per assistant/device; acts as `user_id` and never gets more than that user's role.
//                Only the SHA-256 of the token is stored; scopes = comma list ('read', 'setup').
//   mcp_changes  every write goes in two steps: a plan (status 'planned', preview_json shown to the user)
//                and applying it ('applied', undo_json = what puts it back; 'undone' after an undo).
//                Doubles as the audit trail of what an assistant changed.
//   gateway_settings.mcp_enabled  the endpoint answers at all (off by default)
//   gateway_settings.mcp_remote   also from outside the local network (off by default)
//   gateway_settings.mcp_write    'off' | 'on' | 'timed' (on until mcp_write_until, then off again)
const { createTableIfMissing, stringOnMysql, addColumnsIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await createTableIfMissing(knex, 'mcp_tokens', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('name').notNullable();
    stringOnMysql(t, knex, 'token_hash', 64).notNullable().unique();
    t.text('token_hint').notNullable();
    t.text('scopes').notNullable();
    t.text('created_at').notNullable();
    t.text('last_used_at');
    t.text('revoked_at');
  });
  await createTableIfMissing(knex, 'mcp_changes', (t) => {
    t.increments('id');
    t.integer('token_id').unsigned().references('id').inTable('mcp_tokens').onDelete('SET NULL');
    t.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
    t.text('action').notNullable();
    t.text('summary').notNullable();
    t.text('params_json').notNullable();
    t.text('preview_json').notNullable();
    t.text('undo_json');
    stringOnMysql(t, knex, 'status', 16).notNullable();
    stringOnMysql(t, knex, 'created_at', 32).notNullable();
    t.text('applied_at');
    t.text('undone_at');
    t.index(['status', 'created_at'], 'idx_mcp_changes_status_time');
  });
  await addColumnsIfMissing(knex, 'gateway_settings', {
    mcp_enabled: (t) => t.integer('mcp_enabled').notNullable().defaultTo(0),
    mcp_remote: (t) => t.integer('mcp_remote').notNullable().defaultTo(0),
    mcp_write: (t) => t.text('mcp_write'),
    mcp_write_until: (t) => t.text('mcp_write_until'),
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('mcp_changes');
  await knex.schema.dropTableIfExists('mcp_tokens');
  for (const col of ['mcp_enabled', 'mcp_remote', 'mcp_write', 'mcp_write_until']) {
    if (await knex.schema.hasColumn('gateway_settings', col)) await knex.schema.alterTable('gateway_settings', (t) => t.dropColumn(col));
  }
};
