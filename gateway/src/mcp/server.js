// LoxSuite's MCP server: POST /mcp (Streamable HTTP, stateless JSON responses), mounted before the session
// and CSRF middleware like /api/loxone-in. Authenticated with `Authorization: Bearer lxs_…` (Administration
// → MCP); off until switched on there, and only from the local network unless "remote" is on too. One
// server instance per request, with the tools the token's scopes allow.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const tokens = require('./tokens');
const { READ_TOOLS, ToolError } = require('./diagnose');
const { SETUP_TOOLS } = require('./setup');
const { isPrivateNetworkRequest } = require('../network');
const { version } = require('../../package.json');

const INSTRUCTIONS = `LoxSuite sits between Loxone Miniservers and MQTT: Loxone → MQTT mappings turn Virtual Output commands into MQTT messages, MQTT → Loxone mappings send topic values to a Miniserver's Virtual Input (UDP "MQTT:<topic>=<value>" or HTTP).
To find out why a device doesn't work, start with trace(term). Combine with the Loxone Config MCP (Virtual Outputs/Inputs: address, port, command recognition) and the Miniserver's own MCP (live state).
Changes (token scope "setup") always go plan_change → show the preview to the user → apply_change after their OK; undo_change puts it back.`;

function toolsFor(scopes) {
  const setup = scopes.includes('setup');
  return [...READ_TOOLS, ...SETUP_TOOLS.filter((t) => setup || t.name === 'changes')];
}

function buildServer(ctx) {
  const server = new Server({ name: 'loxsuite', version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const list = toolsFor(ctx.token.scopes);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: list.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = list.find((t) => t.name === request.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool "${request.params.name}".` }] };
    try {
      const args = request.params.arguments || {};
      const result = tool.ctx ? await tool.run(ctx, args) : await tool.run(ctx.user, args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
    } catch (err) {
      if (!(err instanceof ToolError)) console.error(`MCP tool ${tool.name} failed:`, err);
      return { isError: true, content: [{ type: 'text', text: err instanceof ToolError ? err.message : `Failed: ${err.message}` }] };
    }
  });
  return server;
}

const rpcError = (res, status, message) => res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });

async function authenticate(req, res) {
  const s = await tokens.settings();
  if (!s.enabled) { rpcError(res, 403, 'The MCP server is switched off (LoxSuite → Administration → MCP).'); return null; }
  if (!s.remote && !isPrivateNetworkRequest(req)) { rpcError(res, 403, 'MCP is only allowed from the local network.'); return null; }
  const header = req.get('authorization') || '';
  const found = await tokens.verifyToken(header.startsWith('Bearer ') ? header.slice(7).trim() : '');
  if (!found) { res.set('WWW-Authenticate', 'Bearer'); rpcError(res, 401, 'Missing or invalid token.'); return null; }
  return found;
}

function createMcpRouter() {
  const router = express.Router();
  router.use(rateLimit({ windowMs: 60000, max: 240, standardHeaders: true, legacyHeaders: false }));
  router.post('/', async (req, res) => {
    try {
      const ctx = await authenticate(req, res);
      if (!ctx) return;
      const server = buildServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) rpcError(res, 500, 'Internal error.');
    }
  });
  // Stateless: no event stream to open and no session to end.
  router.all('/', (req, res) => rpcError(res, 405, 'Use POST.'));
  return router;
}

module.exports = { createMcpRouter, buildServer, toolsFor, INSTRUCTIONS };
