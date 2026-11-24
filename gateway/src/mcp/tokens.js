// Tokens for LoxSuite's MCP server and its switches (gateway_settings.mcp_*). A token acts as one user:
// every tool checks that user's role (same areas as Access Roles), so a token never gets more than the
// person it belongs to. The token itself is shown once; only its SHA-256 is stored.
const crypto = require('crypto');
const db = require('../db');

const SCOPES = ['read', 'setup'];
const PREFIX = 'lxs_';

const hash = (plain) => crypto.createHash('sha256').update(String(plain)).digest('hex');

function normalizeScopes(list) {
  const wanted = new Set((Array.isArray(list) ? list : String(list || '').split(',')).map((s) => String(s).trim()));
  wanted.add('read'); // every token can read; setup is the extra
  return SCOPES.filter((s) => wanted.has(s));
}

async function createToken({ userId, name, scopes }) {
  const plain = PREFIX + crypto.randomBytes(32).toString('base64url');
  const id = await db.insertReturningId(
    'INSERT INTO mcp_tokens (user_id, name, token_hash, token_hint, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, String(name || '').trim() || 'MCP', hash(plain), plain.slice(-4), normalizeScopes(scopes).join(','), new Date().toISOString()]
  );
  return { id, token: plain };
}

async function revokeToken(id) {
  await db.prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), id);
}

async function listTokens() {
  return db.prepare(`
    SELECT mcp_tokens.id, mcp_tokens.name, mcp_tokens.token_hint, mcp_tokens.scopes, mcp_tokens.created_at,
           mcp_tokens.last_used_at, mcp_tokens.revoked_at, users.username
    FROM mcp_tokens LEFT JOIN users ON users.id = mcp_tokens.user_id
    ORDER BY mcp_tokens.revoked_at IS NOT NULL, mcp_tokens.id DESC
  `).all();
}

// The same user shape loadUserContext puts on req.user (role and permissions fresh from the DB).
async function loadUser(userId) {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.disabled_at) return null;
  const role = user.role_id ? await db.prepare('SELECT * FROM access_roles WHERE id = ?').get(user.role_id) : null;
  const rows = role ? await db.prepare('SELECT area, can_view, can_edit FROM access_role_permissions WHERE role_id = ?').all(role.id) : [];
  const permissions = {};
  for (const r of rows) permissions[r.area] = { view: !!r.can_view, edit: !!r.can_edit };
  return {
    id: user.id,
    username: user.username,
    roleId: role ? role.id : null,
    isAdmin: !!(role && role.is_admin),
    permissions,
  };
}

const canView = (user, area) => !!user && (user.isAdmin || !!user.permissions[area]?.view || !!user.permissions[area]?.edit);
const canEdit = (user, area) => !!user && (user.isAdmin || !!user.permissions[area]?.edit);

// { token, user } for a valid, unrevoked token of an enabled user, else null.
async function verifyToken(plain) {
  if (!plain || !String(plain).startsWith(PREFIX)) return null;
  const token = await db.prepare('SELECT * FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(hash(plain));
  if (!token) return null;
  const user = await loadUser(token.user_id);
  if (!user) return null;
  const now = new Date().toISOString();
  if (!token.last_used_at || Date.parse(now) - Date.parse(token.last_used_at) > 60000) {
    await db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').run(now, token.id);
  }
  return { token: { id: token.id, name: token.name, scopes: normalizeScopes(token.scopes) }, user };
}

async function settings() {
  const row = await db.prepare('SELECT mcp_enabled, mcp_remote, mcp_write, mcp_write_until FROM gateway_settings WHERE id = 1').get();
  return {
    enabled: !!row?.mcp_enabled,
    remote: !!row?.mcp_remote,
    write: row?.mcp_write || 'off',
    writeUntil: row?.mcp_write_until || null,
  };
}

// Writing is allowed: switched on, or on until a time that hasn't passed yet.
function writeAllowed(s, nowMs = Date.now()) {
  if (s.write === 'on') return true;
  return s.write === 'timed' && !!s.writeUntil && Date.parse(s.writeUntil) > nowMs;
}

async function saveSettings({ enabled, remote, write, minutes }) {
  const mode = ['off', 'on', 'timed'].includes(write) ? write : 'off';
  const until = mode === 'timed' ? new Date(Date.now() + Math.max(5, Number(minutes) || 60) * 60000).toISOString() : null;
  await db.prepare('UPDATE gateway_settings SET mcp_enabled = ?, mcp_remote = ?, mcp_write = ?, mcp_write_until = ? WHERE id = 1')
    .run(enabled ? 1 : 0, remote ? 1 : 0, mode, until);
}

module.exports = { SCOPES, PREFIX, hash, normalizeScopes, createToken, revokeToken, listTokens, loadUser, canView, canEdit, verifyToken, settings, writeAllowed, saveSettings };
