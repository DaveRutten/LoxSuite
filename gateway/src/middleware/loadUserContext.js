const db = require('../db');
const { loadRecentNotifications } = require('../routes/notificationCenter');
const asyncHandler = require('./asyncHandler');

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

// SQLite and Postgres both accept the SQL-standard `CAST(x AS INTEGER)`; MySQL (unlike MariaDB,
// which happens to accept INTEGER as an alias too — confirmed empirically, not assumed) rejects it
// outright with a syntax error and needs `CAST(x AS SIGNED)` instead. Same reasoning/pattern as
// routes/monitor.js's own GROUP_CONCAT/STRING_AGG dispatch: a genuine per-dialect keyword
// difference, not just punctuation, so it's branched inline rather than papered over.
function nullableIntegerCastExpr() {
  return db.getBackend() === 'mysql' ? 'CAST(? AS SIGNED)' : 'CAST(? AS INTEGER)';
}

// Every dashboard this user has starred (dashboard_favorites) AND can still actually reach —
// favoriting doesn't survive losing access, so a dashboard un-shared with them (or whose owner
// left) just quietly stops appearing here instead of leaving a dead link in the sidebar. Mirrors
// loadAccessibleDashboard's own three ways in (owner, direct share, role share) rather than
// importing it from routes/dashboards.js, since that module in turn requires this one indirectly
// (server.js wiring) — pulling it in here would risk a require cycle for a handful of lines of SQL.
async function loadFavoriteDashboards(userId, roleId) {
  return db.prepare(`
    SELECT custom_dashboards.id, custom_dashboards.name
    FROM dashboard_favorites
    JOIN custom_dashboards ON custom_dashboards.id = dashboard_favorites.dashboard_id
    WHERE dashboard_favorites.user_id = ?
      AND (
        custom_dashboards.user_id = ?
        OR EXISTS (SELECT 1 FROM dashboard_shares WHERE dashboard_shares.dashboard_id = custom_dashboards.id AND dashboard_shares.user_id = ?)
        OR (${nullableIntegerCastExpr()} IS NOT NULL AND EXISTS (SELECT 1 FROM dashboard_role_shares WHERE dashboard_role_shares.dashboard_id = custom_dashboards.id AND dashboard_role_shares.role_id = ?))
      )
    ORDER BY custom_dashboards.name
  `).all(userId, userId, userId, roleId, roleId);
}

module.exports = asyncHandler(async function loadUserContext(req, res, next) {
  res.locals.currentUser = null; // always defined so every view can safely reference it
  res.locals.collapsedSections = []; // ditto — which sidebar sections (see partials/head.ejs) this user has collapsed
  res.locals.favoriteDashboards = []; // ditto — this user's starred dashboards (see partials/head.ejs's sidebar)
  res.locals.unreadNotificationCount = 0; // ditto — the topbar bell's badge (see partials/head.ejs)
  res.locals.recentNotifications = []; // ditto — the bell popover's own list (see partials/foot.ejs)
  res.locals.tablePageSize = 25; // ditto — client-side pagination's own default (see public/tables.js), overridden below once a user (and their own saved preference, if any) is known
  Object.assign(res.locals, makeHelpers(null));

  if (!req.session || !req.session.userId) return next();

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return next();

  const role = user.role_id ? await db.prepare('SELECT * FROM access_roles WHERE id = ?').get(user.role_id) : null;
  const permissionRows = role
    ? await db.prepare('SELECT area, can_view, can_edit FROM access_role_permissions WHERE role_id = ?').all(role.id)
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
  res.locals.collapsedSections = (await db.prepare('SELECT section_key FROM user_nav_prefs WHERE user_id = ? AND collapsed = 1')
    .all(user.id)).map((r) => r.section_key);
  res.locals.favoriteDashboards = await loadFavoriteDashboards(user.id, req.user.roleId);
  // Computed fresh per-request like everything else here (no session caching) — correct on first
  // paint with zero extra round-trip; the topbar's own periodic poll (see foot.ejs) only has to
  // catch events that land while the user sits on one page without navigating.
  // Unread = past the bulk watermark AND not individually dismissed — see
  // routes/notificationCenter.js's own /unread-count for why both conditions matter (a per-item
  // acknowledgement — clicking through to one event's source, or its own "x" — must not also
  // silently mark every OTHER older, never-looked-at event as read the way a watermark-only check
  // used to).
  res.locals.unreadNotificationCount = (await db.prepare(`
    SELECT COUNT(*) AS n FROM notification_events
    WHERE id > ? AND id NOT IN (SELECT notification_event_id FROM notification_dismissals WHERE user_id = ?)
  `).get(user.last_seen_notification_id, user.id)).n;
  // Shared query (not repeated here) with that same file's own /recent endpoint, which foot.ejs
  // polls to keep this list from going stale between full page loads — see that endpoint's own
  // comment for why that's needed.
  res.locals.recentNotifications = await loadRecentNotifications(user.id);
  res.locals.tablePageSize = user.table_page_size || 25;

  next();
});
