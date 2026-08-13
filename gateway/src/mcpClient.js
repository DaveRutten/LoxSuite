// LoxSuite's own MCP (Model Context Protocol) client for the optional AI Assistant feature —
// connects directly to a Loxone Miniserver's native MCP server plugin, on the same LAN (or its
// Remote Connect address) LoxSuite itself already runs on, the same way Claude Code's own local
// MCP bridge does — rather than through Claude's hosted Connectors, which need the endpoint
// reachable over standard HTTPS/443 from Anthropic's own cloud (see the AI Assistant admin
// settings page's own copy for why that's the wrong shape for a self-hosted app).
//
// OAuth 2.1 + PKCE + Dynamic Client Registration is handled entirely by
// @modelcontextprotocol/sdk's own client/auth.js helpers — an engine already built specifically
// for MCP servers' RFC 9728 (protected-resource metadata) + RFC 8414 (authorization-server
// metadata) discovery chain, rather than hand-rolled or borrowed from ssoClient.js's openid-client
// (which assumes a plain RFC 8414-suffixed issuer — the wrong shape for the RFC 9728 indirection
// MCP servers use, and the exact "OAuth discovery quirk" this project's own plan flagged as a risk
// before finding this).
//
// Pooled per-Miniserver like loxoneWebSocket.js's own `connections` Map — one persistent MCP
// client per AI-enabled, already-authorized Miniserver, rescanned periodically the same way
// startLiveConnections() rescans for newly-added Miniservers.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { auth: runMcpAuthFlow } = require('@modelcontextprotocol/sdk/client/auth.js');
const crypto = require('crypto');
const db = require('./db');
const { encrypt, decrypt } = require('./secretCrypto');
const { version: packageVersion } = require('../package.json');

const RESCAN_TICK_MS = 60000;

const clients = new Map(); // miniserver id -> { client, transport, tools, status, lastError }

function deriveMcpUrl(miniserver) {
  if (miniserver.mcp_url) return miniserver.mcp_url;
  const scheme = miniserver.use_https ? 'https' : 'http';
  return `${scheme}://${miniserver.host}:${miniserver.http_port}/mcp`;
}

function callbackUrlFor(miniserverId, baseUrl) {
  return `${baseUrl}/miniservers/${miniserverId}/mcp/callback`;
}

// Implements @modelcontextprotocol/sdk's OAuthClientProvider interface, backed by the
// `miniservers` row's own mcp_* columns (encrypted at rest via secretCrypto, same convention as
// that table's own password column) for anything that needs to survive past one request, plus the
// PKCE code_verifier/state pair — which only ever needs to survive a single browser redirect round
// trip — kept in req.session instead, mirroring ssoClient.js's own ssoCodeVerifier/ssoState (see
// routes/auth.js). The same class serves two different contexts:
//   - Interactive (routes/miniservers.js's /mcp/authorize + /mcp/callback): constructed with a real
//     `res`/`session` from the request, drives the one-time browser authorization.
//   - Runtime (ensureMcpClient below): constructed with no `res`/a throwaway session, used only to
//     supply/refresh an already-issued token when actually talking to the Miniserver's MCP server.
//     redirectToAuthorization() throws here instead of trying to redirect a nonexistent response —
//     if that ever fires on this path, the Miniserver's authorization has lapsed and needs redoing
//     from its edit page, not a silent background retry.
class LoxoneOAuthProvider {
  constructor({ miniserver, baseUrl, session, res, username }) {
    this.miniserver = miniserver;
    this.baseUrl = baseUrl;
    this.session = session || {};
    this.res = res || null;
    this.username = username || null;
  }

  get redirectUrl() {
    return callbackUrlFor(this.miniserver.id, this.baseUrl);
  }

  get clientMetadata() {
    return {
      redirect_uris: [this.redirectUrl],
      // Public client, no secret — matches how a browser-based/CLI MCP client (Claude Code's own
      // local bridge, mcp-remote) authorizes; Loxone's plugin recommends a dedicated, minimally-
      // privileged Loxone user for whichever account completes this, not a client secret.
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'LoxSuite',
    };
  }

  async clientInformation() {
    const row = await db.prepare('SELECT mcp_oauth_client_id, mcp_oauth_client_secret FROM miniservers WHERE id = ?').get(this.miniserver.id);
    if (!row?.mcp_oauth_client_id) return undefined;
    return { client_id: row.mcp_oauth_client_id, client_secret: row.mcp_oauth_client_secret ? decrypt(row.mcp_oauth_client_secret) : undefined };
  }

  async saveClientInformation(info) {
    await db.prepare('UPDATE miniservers SET mcp_oauth_client_id = ?, mcp_oauth_client_secret = ? WHERE id = ?')
      .run(info.client_id, info.client_secret ? encrypt(info.client_secret) : null, this.miniserver.id);
  }

  async tokens() {
    const row = await db.prepare('SELECT mcp_access_token, mcp_refresh_token, mcp_token_expires_at FROM miniservers WHERE id = ?').get(this.miniserver.id);
    if (!row?.mcp_access_token) return undefined;
    const expiresAt = row.mcp_token_expires_at ? new Date(row.mcp_token_expires_at).getTime() : 0;
    return {
      access_token: decrypt(row.mcp_access_token),
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
      refresh_token: row.mcp_refresh_token ? decrypt(row.mcp_refresh_token) : undefined,
    };
  }

  async saveTokens(tokens) {
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
    await db.prepare(
      `UPDATE miniservers SET mcp_access_token = ?, mcp_refresh_token = ?, mcp_token_expires_at = ?, mcp_authorized_by = ?, mcp_last_error = NULL WHERE id = ?`
    ).run(
      encrypt(tokens.access_token),
      tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      expiresAt,
      this.username,
      this.miniserver.id
    );
  }

  redirectToAuthorization(url) {
    if (!this.res) throw new Error(`Miniserver "${this.miniserver.name}"'s AI Assistant authorization has lapsed — re-authorize it from its edit page.`);
    this.res.redirect(url.toString());
  }

  saveCodeVerifier(verifier) {
    this.session.mcpOAuth = { ...this.session.mcpOAuth, miniserverId: this.miniserver.id, codeVerifier: verifier };
  }

  codeVerifier() {
    if (this.session.mcpOAuth?.miniserverId !== this.miniserver.id) {
      throw new Error('Your authorization attempt expired — please try again.');
    }
    return this.session.mcpOAuth.codeVerifier;
  }

  state() {
    const state = crypto.randomBytes(16).toString('hex');
    this.session.mcpOAuth = { ...this.session.mcpOAuth, miniserverId: this.miniserver.id, state };
    return state;
  }

  // Verified against a real Miniserver: Loxone's MCP plugin advertises its own canonical Remote
  // Connect (dyndns) identity as the RFC 8707 resource indicator during RFC 9728 discovery,
  // regardless of whether we actually dialed that address or the local IP — the two legitimately
  // differ for one physical Miniserver. The SDK's own default validation rejects that as a
  // mismatch (it's designed for the general case where the queried URL and the declared resource
  // really might be different services). We already know which Miniserver this is — this.miniserver's
  // own stored host/mcp_url — so accept whatever resource it declares rather than requiring a
  // textual match against the address we happened to dial.
  async validateResourceURL(serverUrl, resource) {
    return resource ? new URL(resource) : new URL(serverUrl);
  }
}

async function fetchToolsRaw(entry) {
  const { tools } = await entry.client.listTools();
  entry.tools = tools;
  return tools;
}

// A tool with no readOnlyHint at all is treated as Write (unsafe), not Read — absence of an
// explicit "this is safe" signal isn't itself a safety signal. readOnlyHint is the standard MCP
// tool-annotation field (see the MCP spec's ToolAnnotations) — not a Loxone-specific convention,
// though Loxone's own use of it should still be spot-checked against a real Miniserver.
function isWriteTool(tool) {
  return tool?.annotations?.readOnlyHint !== true;
}

async function ensureMcpClient(miniserver) {
  const existing = clients.get(miniserver.id);
  if (existing?.status === 'connected') return existing;

  const provider = new LoxoneOAuthProvider({ miniserver });
  const tokens = await provider.tokens();
  if (!tokens) throw new Error(`Miniserver "${miniserver.name}" has not been authorized for AI Assistant access yet.`);

  const transport = new StreamableHTTPClientTransport(new URL(deriveMcpUrl(miniserver)), { authProvider: provider });
  const client = new Client({ name: 'loxsuite', version: packageVersion }, {});

  try {
    await client.connect(transport);
  } catch (err) {
    await db.prepare('UPDATE miniservers SET mcp_last_error = ? WHERE id = ?').run(err.message, miniserver.id);
    clients.set(miniserver.id, { client: null, transport: null, tools: null, status: 'error', lastError: err.message });
    throw err;
  }

  const entry = { client, transport, tools: null, status: 'connected', lastError: null };
  clients.set(miniserver.id, entry);
  return entry;
}

function resetMcpClient(miniserverId) {
  const entry = clients.get(miniserverId);
  if (entry?.client) entry.client.close().catch(() => {});
  clients.delete(miniserverId);
}

async function listTools(miniserver) {
  const entry = await ensureMcpClient(miniserver);
  const tools = await fetchToolsRaw(entry);
  if (miniserver.ai_allow_write_commands) return tools;
  return tools.filter((t) => !isWriteTool(t));
}

async function callTool(miniserver, name, input) {
  const entry = await ensureMcpClient(miniserver);
  const tools = entry.tools || (await fetchToolsRaw(entry));
  const tool = tools.find((t) => t.name === name);
  const write = isWriteTool(tool);
  if (write && !miniserver.ai_allow_write_commands) {
    throw new Error(`Tool "${name}" is not permitted — this Miniserver's AI Assistant is read-only.`);
  }

  const result = await entry.client.callTool({ name, arguments: input });

  // Lands in the existing Logs > Loxone commands tab (same table/source loxoneCommandLog.js's own
  // inbound-command logging uses) with zero new UI — Read-only calls aren't logged here (would be
  // noise); they're visible in-chat only, once the chat UI exists.
  if (write) {
    await db.prepare(
      `INSERT INTO log_entries (source, source_label, line, source_id, recorded_at) VALUES ('loxone_commands', 'AI Assistant', ?, ?, ?)`
    ).run(`${name}(${JSON.stringify(input)})`, miniserver.id, new Date().toISOString());
  }

  return result;
}

function getStatus(miniserverId) {
  return clients.get(miniserverId)?.status || 'disconnected';
}

// Backs the Miniserver edit page's own "Test" button, alongside its existing Local/External/
// Loxone API/Logbook/Live data checks — same shape (`{ok: true, ms}` or `{ok: false, error}`) as
// runDetailedCheck()'s own sub-results and loxoneWebSocket.js's testLiveConnection(), so the
// existing renderLine() on that page needs no special-casing for this one. Resets any existing
// client first, same "a stale rejection shouldn't just be reported back unretried" reasoning as
// loxoneWebSocket.js's own resetConnection() before testLiveConnection().
async function testConnection(miniserver) {
  const start = Date.now();
  resetMcpClient(miniserver.id);
  try {
    await ensureMcpClient(miniserver);
    return { ok: true, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// The one-time authorize/re-authorize/restart-login routes all call runMcpAuthFlow() directly —
// the SDK's own auth() orchestrator, which makes its own network calls (OAuth discovery, Dynamic
// Client Registration, a token refresh) with no timeout of its own. Verified against a real
// Miniserver that a SUCCESSFUL run completes in under a second; if it's instead silently hanging
// (packets dropped rather than a clean connection refusal — plausible on a different host's
// network path to the Miniserver/Loxone's cloud than the one this was tested from), nothing ever
// settles that promise, and the caller's own `await` waits forever right along with it — no
// response, no error, nothing to show the user, no matter how long they wait. This bounds that at
// a fixed ceiling so the request always eventually finishes one way or the other.
const AUTH_FLOW_TIMEOUT_MS = 25000;

function runMcpAuthFlowWithTimeout(provider, opts) {
  return Promise.race([
    runMcpAuthFlow(provider, opts),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Timed out after ${AUTH_FLOW_TIMEOUT_MS / 1000}s waiting for the Miniserver/Loxone's cloud service to respond — check that this container can actually reach it over the network.`)),
      AUTH_FLOW_TIMEOUT_MS
    )),
  ]);
}

async function startMcpClients() {
  async function scan() {
    const rows = await db.prepare('SELECT * FROM miniservers WHERE ai_enabled = 1 AND mcp_access_token IS NOT NULL').all();
    const enabledIds = new Set(rows.map((r) => r.id));
    for (const id of [...clients.keys()]) if (!enabledIds.has(id)) resetMcpClient(id);
    for (const ms of rows) {
      if (clients.has(ms.id)) continue;
      try {
        await ensureMcpClient(ms);
      } catch (err) {
        console.error(`[mcpClient] Miniserver ${ms.id} ("${ms.name}") connect failed:`, err.message);
      }
    }
  }
  await scan();
  setInterval(() => scan().catch((err) => console.error('[mcpClient] rescan failed:', err.message)), RESCAN_TICK_MS);
}

module.exports = {
  LoxoneOAuthProvider,
  deriveMcpUrl,
  startMcpClients,
  resetMcpClient,
  ensureMcpClient,
  listTools,
  callTool,
  getStatus,
  testConnection,
  runMcpAuthFlow,
  runMcpAuthFlowWithTimeout,
};
