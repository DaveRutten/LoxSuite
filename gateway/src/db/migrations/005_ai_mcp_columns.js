// Backs the optional AI Assistant feature's per-Miniserver half: whether this specific Miniserver
// is opted into it, where its native MCP (Model Context Protocol) server plugin lives, and the
// OAuth 2.1 tokens LoxSuite's own MCP client (mcpClient.js, a later PR) uses to talk to it. Plain
// additive alterTable, same shape as 004_audio_zone_columns.js — every column nullable/additive,
// nothing here changes any existing row's meaning.
//
// ai_allow_write_commands defaults to 0 (off) independently of whatever Read/Write tool grants the
// Loxone user account that completes the OAuth flow actually has server-side — a second,
// LoxSuite-side switch an administrator controls, not a mirror of the first.
//
// mcp_oauth_client_secret/mcp_access_token/mcp_refresh_token are encrypted at rest via
// secretCrypto.js before being written, same convention as miniservers.password — plain nullable
// TEXT columns, no schema-level default, so none of MySQL's TEXT-column restrictions (see
// 001_baseline.js's own top-of-file comment) apply here.
exports.up = async function up(knex) {
  await knex.schema.alterTable('miniservers', (t) => {
    t.integer('ai_enabled').notNullable().defaultTo(0);
    t.text('mcp_url');
    t.integer('ai_allow_write_commands').notNullable().defaultTo(0);
    t.text('mcp_oauth_client_id');
    t.text('mcp_oauth_client_secret');
    t.text('mcp_access_token');
    t.text('mcp_refresh_token');
    t.text('mcp_token_expires_at');
    t.text('mcp_authorized_by');
    t.text('mcp_last_error');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('miniservers', (t) => {
    t.dropColumn('ai_enabled');
    t.dropColumn('mcp_url');
    t.dropColumn('ai_allow_write_commands');
    t.dropColumn('mcp_oauth_client_id');
    t.dropColumn('mcp_oauth_client_secret');
    t.dropColumn('mcp_access_token');
    t.dropColumn('mcp_refresh_token');
    t.dropColumn('mcp_token_expires_at');
    t.dropColumn('mcp_authorized_by');
    t.dropColumn('mcp_last_error');
  });
};
