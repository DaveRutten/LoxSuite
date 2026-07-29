const db = require('../db');

// Mounted right after requireAuth on every route. Loads the logged-in user's role and permissions
// fresh from the DB on every request (never cached in the session cookie) so a role change made by
// an admin takes effect on that user's very next request instead of waiting for them to log back in.
// Exposed on res.locals so every view can gate a mutating button/form without redefining this
// logic per-template (see head.ejs's nav for the read-side equivalent).
function makeHelpers(user) {
  return {
    canView: (area) => !!user && (user.isAdmin || !!user.permissions[area]?.view),
    canEdit: (area) => !!user && (user.isAdmin || !!user.permissions[area]?.edit),
  };
}

module.exports = function loadUserContext(req, res, next) {
  res.locals.currentUser = null; // always defined so every view can safely reference it
  res.locals.collapsedSections = []; // ditto — which sidebar sections (see partials/head.ejs) this user has collapsed
  Object.assign(res.locals, makeHelpers(null));

  if (!req.session || !req.session.userId) return next();

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return next();

  const role = user.role_id ? db.prepare('SELECT * FROM access_roles WHERE id = ?').get(user.role_id) : null;
  const permissionRows = role
    ? db.prepare('SELECT area, can_view, can_edit FROM access_role_permissions WHERE role_id = ?').all(role.id)
    : [];

  const permissions = {};
  for (const row of permissionRows) {
    permissions[row.area] = { view: !!row.can_view, edit: !!row.can_edit };
  }

  req.user = {
    id: user.id,
    username: user.username,
    displayName: user.display_name || null,
    email: user.email || null,
    avatarUrl: user.avatar_url || null,
    authProvider: user.auth_provider,
    roleId: role ? role.id : null,
    roleName: role ? role.name : null,
    isAdmin: !!(role && role.is_admin),
    permissions,
  };
  res.locals.currentUser = req.user;
  Object.assign(res.locals, makeHelpers(req.user));
  res.locals.collapsedSections = db.prepare('SELECT section_key FROM user_nav_prefs WHERE user_id = ? AND collapsed = 1')
    .all(user.id).map((r) => r.section_key);

  next();
};
