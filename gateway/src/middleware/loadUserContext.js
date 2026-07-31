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

// Every dashboard this user has starred (dashboard_favorites) AND can still actually reach —
// favoriting doesn't survive losing access, so a dashboard un-shared with them (or whose owner
// left) just quietly stops appearing here instead of leaving a dead link in the sidebar. Mirrors
// loadAccessibleDashboard's own three ways in (owner, direct share, role share) rather than
// importing it from routes/dashboards.js, since that module in turn requires this one indirectly
// (server.js wiring) — pulling it in here would risk a require cycle for a handful of lines of SQL.
function loadFavoriteDashboards(userId, roleId) {
  return db.prepare(`
    SELECT custom_dashboards.id, custom_dashboards.name
    FROM dashboard_favorites
    JOIN custom_dashboards ON custom_dashboards.id = dashboard_favorites.dashboard_id
    WHERE dashboard_favorites.user_id = ?
      AND (
        custom_dashboards.user_id = ?
        OR EXISTS (SELECT 1 FROM dashboard_shares WHERE dashboard_shares.dashboard_id = custom_dashboards.id AND dashboard_shares.user_id = ?)
        OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM dashboard_role_shares WHERE dashboard_role_shares.dashboard_id = custom_dashboards.id AND dashboard_role_shares.role_id = ?))
      )
    ORDER BY custom_dashboards.name
  `).all(userId, userId, userId, roleId, roleId);
}

module.exports = function loadUserContext(req, res, next) {
  res.locals.currentUser = null; // always defined so every view can safely reference it
  res.locals.collapsedSections = []; // ditto — which sidebar sections (see partials/head.ejs) this user has collapsed
  res.locals.favoriteDashboards = []; // ditto — this user's starred dashboards (see partials/head.ejs's sidebar)
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
  res.locals.favoriteDashboards = loadFavoriteDashboards(user.id, req.user.roleId);

  next();
};
