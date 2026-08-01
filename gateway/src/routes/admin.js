const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { AREAS, MAIN_AREAS, LOG_AREAS } = require('../permissionAreas');
const { logSystemEvent } = require('../auditLog');
const { reloadLoginLimiter } = require('./auth');
const { encrypt } = require('../secretCrypto');

const router = express.Router();

function listUsers() {
  return db.prepare(
    `SELECT users.id, users.username, users.auth_provider, users.role_id, users.last_login_at,
            users.first_name, users.last_name, users.display_name, users.avatar_url,
            access_roles.name AS role_name
     FROM users LEFT JOIN access_roles ON access_roles.id = users.role_id
     ORDER BY users.username`
  ).all();
}

function listRoles() {
  const roles = db.prepare('SELECT * FROM access_roles ORDER BY name').all();
  const permStmt = db.prepare('SELECT area, can_view, can_edit FROM access_role_permissions WHERE role_id = ?');
  const userCountStmt = db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ?');

  return roles.map((role) => {
    const rows = permStmt.all(role.id);
    const permissions = {};
    for (const { key } of AREAS) permissions[key] = { view: false, edit: false };
    for (const row of rows) permissions[row.area] = { view: !!row.can_view, edit: !!row.can_edit };
    return { ...role, permissions, userCount: userCountStmt.get(role.id).c };
  });
}

// True only when removing/demoting this user would leave zero users with an admin role — the
// server-side backstop against ever locking every administrator out of Administration.
function isLastAdmin(userId) {
  const adminCount = db.prepare(
    `SELECT COUNT(*) AS c FROM users u JOIN access_roles r ON r.id = u.role_id WHERE r.is_admin = 1`
  ).get().c;
  if (adminCount > 1) return false;

  const user = db.prepare(
    `SELECT r.is_admin AS isAdmin FROM users u LEFT JOIN access_roles r ON r.id = u.role_id WHERE u.id = ?`
  ).get(userId);
  return !!(user && user.isAdmin && adminCount === 1);
}

router.get('/', (req, res) => res.redirect('/admin/general'));

router.get('/general', (req, res) => {
  res.render('admin-general', { error: null });
});

router.get('/users', (req, res) => {
  res.render('admin-users', { users: listUsers(), roles: db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error: null });
});

router.post('/users', (req, res) => {
  const { username, password, role_id, first_name, last_name } = req.body;
  try {
    if (!username || !password || !role_id) throw new Error('Username, password, and role are required.');
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (username, password_hash, role_id, auth_provider, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, hash, role_id, 'local', first_name?.trim() || null, last_name?.trim() || null);
    logSystemEvent(`"${req.user.username}" created user "${username}".`);
    res.redirect('/admin/users');
  } catch (err) {
    res.render('admin-users', { users: listUsers(), roles: db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error: err.message });
  }
});

// Local users only — an SSO account's name is refreshed from Pocket ID on every login (see
// routes/auth.js), so editing it here would just get overwritten the next time they sign in.
router.post('/users/:id/name', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user || user.auth_provider !== 'local') {
    return res.render('admin-users', { users: listUsers(), roles: db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error: 'This account signs in via SSO — its name comes from Pocket ID and cannot be edited here.' });
  }
  const firstName = (req.body.first_name || '').trim() || null;
  const lastName = (req.body.last_name || '').trim() || null;
  db.prepare('UPDATE users SET first_name = ?, last_name = ? WHERE id = ?').run(firstName, lastName, user.id);
  logSystemEvent(`"${req.user.username}" updated the name on user "${user.username}".`);
  res.redirect('/admin/users');
});

router.post('/users/:id/role', (req, res) => {
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  const targetRole = db.prepare('SELECT * FROM access_roles WHERE id = ?').get(req.body.role_id);
  if (!targetRole) {
    return res.render('admin-users', { users: listUsers(), roles: db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error: 'Role not found.' });
  }
  if (!targetRole.is_admin && isLastAdmin(req.params.id)) {
    return res.render('admin-users', {
      users: listUsers(),
      roles: db.prepare('SELECT * FROM access_roles ORDER BY name').all(),
      error: 'This is the only remaining administrator — assign another user as administrator first.',
    });
  }
  db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(targetRole.id, req.params.id);
  logSystemEvent(`"${req.user.username}" changed "${targetUser?.username}"'s role to "${targetRole.name}".`);
  res.redirect('/admin/users');
});

router.post('/users/:id/reset-password', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  const error = !user
    ? 'User not found.'
    : user.auth_provider !== 'local'
      ? 'This account signs in via SSO and has no local password to reset.'
      : !req.body.password || req.body.password.length < 8
        ? 'Password must be at least 8 characters.'
        : null;

  if (error) {
    return res.render('admin-users', { users: listUsers(), roles: db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error });
  }

  const hash = bcrypt.hashSync(req.body.password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  logSystemEvent(`"${req.user.username}" reset the password for user "${user.username}".`);
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.render('admin-users', { users: listUsers(), roles: db.prepare('SELECT * FROM access_roles ORDER BY name').all(), error: 'You cannot delete your own account.' });
  }
  if (isLastAdmin(req.params.id)) {
    return res.render('admin-users', {
      users: listUsers(),
      roles: db.prepare('SELECT * FROM access_roles ORDER BY name').all(),
      error: 'This is the only remaining administrator and cannot be deleted — assign another user as administrator first.',
    });
  }
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  // No PRAGMA foreign_keys enforcement in this DB (see db.js) — cleaned up explicitly rather than
  // relying on the schema's own ON DELETE CASCADE to do it. Their own personal notification rules
  // (routes/profile.js's "My rules") go too, not just their subscriptions to admin-wide ones —
  // otherwise an orphaned, still-enabled rule would keep matching readings forever with nobody left
  // to deliver to.
  db.prepare('DELETE FROM notification_rule_subscribers WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM notification_rule_channels WHERE rule_id IN (SELECT id FROM notification_rules WHERE owner_user_id = ?)').run(req.params.id);
  db.prepare('DELETE FROM notification_rules WHERE owner_user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM dashboard_favorites WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  logSystemEvent(`"${req.user.username}" deleted user "${targetUser?.username}".`);
  res.redirect('/admin/users');
});

router.get('/roles', (req, res) => {
  res.render('admin-roles', { roles: listRoles(), areas: MAIN_AREAS, logAreas: LOG_AREAS, error: null });
});

router.post('/roles', (req, res) => {
  const name = (req.body.name || '').trim();
  try {
    if (!name) throw new Error('Role name is required.');
    const result = db.prepare('INSERT INTO access_roles (name, is_admin) VALUES (?, 0)').run(name);
    const insertPerm = db.prepare('INSERT INTO access_role_permissions (role_id, area, can_view, can_edit) VALUES (?, ?, 0, 0)');
    for (const { key } of AREAS) insertPerm.run(result.lastInsertRowid, key);
    logSystemEvent(`"${req.user.username}" created role "${name}".`);
    res.redirect('/admin/roles');
  } catch (err) {
    res.render('admin-roles', { roles: listRoles(), areas: MAIN_AREAS, logAreas: LOG_AREAS, error: err.message });
  }
});

router.post('/roles/:id/rename', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    const oldRole = db.prepare('SELECT name FROM access_roles WHERE id = ?').get(req.params.id);
    db.prepare('UPDATE access_roles SET name = ? WHERE id = ?').run(name, req.params.id);
    logSystemEvent(`"${req.user.username}" renamed role "${oldRole?.name}" to "${name}".`);
  }
  res.redirect('/admin/roles');
});

router.post('/roles/:id/permissions', (req, res) => {
  const roleId = req.params.id;
  const role = db.prepare('SELECT * FROM access_roles WHERE id = ?').get(roleId);
  if (!role) return res.status(404).send('Role not found');

  // Demoting the sole admin role's is_admin flag is just as dangerous as deleting the role itself.
  const wasOnlyAdminRole = role.is_admin && db.prepare('SELECT COUNT(*) AS c FROM access_roles WHERE is_admin = 1').get().c === 1;
  const stillAdmin = !!req.body.is_admin;
  if (wasOnlyAdminRole && !stillAdmin && db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ?').get(roleId).c > 0) {
    return res.render('admin-roles', { roles: listRoles(), areas: MAIN_AREAS, logAreas: LOG_AREAS, error: 'This is the only administrator role and still has users on it — assign them elsewhere first.' });
  }

  const applyAll = db.transaction(() => {
    db.prepare('UPDATE access_roles SET is_admin = ? WHERE id = ?').run(stillAdmin ? 1 : 0, roleId);
    const upsert = db.prepare(
      `INSERT INTO access_role_permissions (role_id, area, can_view, can_edit) VALUES (?, ?, ?, ?)
       ON CONFLICT(role_id, area) DO UPDATE SET can_view = excluded.can_view, can_edit = excluded.can_edit`
    );
    for (const { key } of AREAS) {
      const edit = req.body.perm?.[key]?.edit ? 1 : 0;
      const view = edit || req.body.perm?.[key]?.view ? 1 : 0; // edit implies view
      upsert.run(roleId, key, view, edit);
    }
  });
  applyAll();

  logSystemEvent(`"${req.user.username}" updated permissions for role "${role.name}".`);
  res.redirect('/admin/roles');
});

router.post('/roles/:id/delete', (req, res) => {
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ?').get(req.params.id).c;
  if (inUse > 0) {
    return res.render('admin-roles', { roles: listRoles(), areas: MAIN_AREAS, logAreas: LOG_AREAS, error: `${inUse} user(s) still have this role — reassign them first.` });
  }
  const role = db.prepare('SELECT name FROM access_roles WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM access_roles WHERE id = ?').run(req.params.id);
  logSystemEvent(`"${req.user.username}" deleted role "${role?.name}".`);
  res.redirect('/admin/roles');
});

// Single Sign-On and the login rate limit are both Administration -> Security cards on one page
// now (used to be a separate "Single Sign-On" tab) — this loads everything both cards need
// regardless of which form was actually just submitted, so either POST handler can re-render the
// same view with fresh data (and the other card's own edits, if any, aren't lost either).
function loadSecurityPageData() {
  return {
    sso: db.prepare('SELECT * FROM sso_settings WHERE id = 1').get(),
    roles: db.prepare('SELECT * FROM access_roles ORDER BY name').all(),
    gatewaySettings: db.prepare('SELECT * FROM gateway_settings WHERE id = 1').get(),
  };
}

router.get('/security', (req, res) => {
  res.render('admin-security', { ...loadSecurityPageData(), error: null, saved: false, baseUrl: `${req.protocol}://${req.get('host')}` });
});

// /admin/sso is kept as the SSO form's own POST target (unchanged from before the merge) rather
// than renaming it to /admin/security/sso — nothing else needed to change to make that work.
router.post('/sso', (req, res) => {
  const { enabled, issuer_url, client_id, client_secret, default_role_id, button_label, local_login_disabled } = req.body;

  // Blank secret field = keep the existing one; it's never shown back to the browser, so
  // re-typing is only needed to actually change it (same convention as Miniserver passwords).
  const existing = db.prepare('SELECT client_secret FROM sso_settings WHERE id = 1').get();
  const newSecret = client_secret ? encrypt(client_secret) : existing?.client_secret;

  db.prepare(
    `UPDATE sso_settings SET enabled = ?, issuer_url = ?, client_id = ?, client_secret = ?, default_role_id = ?, button_label = ?, local_login_disabled = ?
     WHERE id = 1`
  ).run(
    enabled ? 1 : 0,
    issuer_url || null,
    client_id || null,
    newSecret || null,
    default_role_id || null,
    button_label || 'Pocket ID',
    local_login_disabled ? 1 : 0
  );
  logSystemEvent(`"${req.user.username}" updated SSO settings.`);
  res.render('admin-security', { ...loadSecurityPageData(), error: null, saved: true, baseUrl: `${req.protocol}://${req.get('host')}` });
});

router.post('/security', (req, res) => {
  const max = Number(req.body.login_rate_limit_max);
  const windowMinutes = Number(req.body.login_rate_limit_window_minutes);

  if (!Number.isFinite(max) || max < 1) {
    return res.render('admin-security', { ...loadSecurityPageData(), error: 'Max login attempts must be at least 1.', saved: false, baseUrl: `${req.protocol}://${req.get('host')}` });
  }
  if (!Number.isFinite(windowMinutes) || windowMinutes < 1) {
    return res.render('admin-security', { ...loadSecurityPageData(), error: 'The login attempts time window must be at least 1 minute.', saved: false, baseUrl: `${req.protocol}://${req.get('host')}` });
  }

  db.prepare('UPDATE gateway_settings SET login_rate_limit_max = ?, login_rate_limit_window_minutes = ? WHERE id = 1')
    .run(Math.round(max), Math.round(windowMinutes));
  reloadLoginLimiter();
  logSystemEvent(`"${req.user.username}" updated the login rate limit.`);
  res.render('admin-security', { ...loadSecurityPageData(), error: null, saved: true, baseUrl: `${req.protocol}://${req.get('host')}` });
});

module.exports = router;
