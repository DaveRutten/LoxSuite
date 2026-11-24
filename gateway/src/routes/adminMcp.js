// Administration → MCP: switch LoxSuite's MCP server on/off, allow it from outside the local network,
// switch writing on (or on for a while), make and revoke tokens, and see / undo what assistants changed.
const express = require('express');
const db = require('../db');
const tokens = require('../mcp/tokens');
const { undoChange } = require('../mcp/setup');
const { ToolError } = require('../mcp/diagnose');
const { logSystemEvent } = require('../auditLog');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const newToken = req.session.mcpNewToken || null;
  delete req.session.mcpNewToken;
  const s = await tokens.settings();
  res.render('admin-mcp', {
    settings: s,
    writing: tokens.writeAllowed(s),
    list: await tokens.listTokens(),
    users: await db.prepare('SELECT id, username FROM users WHERE disabled_at IS NULL ORDER BY username').all(),
    changes: await db.prepare('SELECT mcp_changes.*, mcp_tokens.name AS token_name FROM mcp_changes LEFT JOIN mcp_tokens ON mcp_tokens.id = mcp_changes.token_id ORDER BY mcp_changes.id DESC LIMIT 30').all(),
    newToken,
    baseUrl: `${req.protocol}://${req.get('host')}`,
    error: req.query.error || null,
  });
}));

router.post('/settings', asyncHandler(async (req, res) => {
  const { enabled, remote, write, minutes } = req.body;
  await tokens.saveSettings({ enabled: !!enabled, remote: !!remote, write, minutes });
  const s = await tokens.settings();
  await logSystemEvent(`${req.user.username} set MCP: server ${s.enabled ? 'on' : 'off'}, remote ${s.remote ? 'on' : 'off'}, writing ${s.write}${s.writeUntil ? ` until ${s.writeUntil}` : ''}.`);
  res.redirect('/admin/mcp');
}));

router.post('/tokens', asyncHandler(async (req, res) => {
  const userId = Number(req.body.user_id) || req.user.id;
  const user = await db.prepare('SELECT id, username FROM users WHERE id = ? AND disabled_at IS NULL').get(userId);
  if (!user) return res.redirect('/admin/mcp');
  const scopes = req.body.setup ? ['read', 'setup'] : ['read'];
  const { token } = await tokens.createToken({ userId: user.id, name: req.body.name, scopes });
  req.session.mcpNewToken = token;
  await logSystemEvent(`${req.user.username} made MCP token "${String(req.body.name || 'MCP').trim()}" for ${user.username} (${scopes.join(', ')}).`);
  res.redirect('/admin/mcp');
}));

router.post('/tokens/:id/revoke', asyncHandler(async (req, res) => {
  await tokens.revokeToken(Number(req.params.id));
  await logSystemEvent(`${req.user.username} revoked MCP token #${req.params.id}.`);
  res.redirect('/admin/mcp');
}));

router.post('/changes/:id/undo', asyncHandler(async (req, res) => {
  try {
    await undoChange({ token: { id: null, name: 'Administration', scopes: ['read', 'setup'] }, user: req.user }, { change_id: Number(req.params.id), force: !!req.body.force }, { fromAdmin: true });
    res.redirect('/admin/mcp');
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    res.redirect(`/admin/mcp?error=${encodeURIComponent(err.message)}`);
  }
}));

module.exports = router;
