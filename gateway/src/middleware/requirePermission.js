// Server-side enforcement of the Access Roles permission matrix (see permissionAreas.js). Nav
// links hiding a page a role can't see is UX only — these two are the actual security boundary.
function requirePermission(area, level) {
  return function (req, res, next) {
    if (req.user && (req.user.isAdmin || req.user.permissions[area]?.[level])) return next();
    res.status(403).render('forbidden', { area });
  };
}

// Allowed when the user has `level` on at least one of the areas (a page shared by several functions).
function requireAnyPermission(areas, level) {
  return function (req, res, next) {
    if (req.user && (req.user.isAdmin || areas.some((a) => req.user.permissions[a]?.[level]))) return next();
    res.status(403).render('forbidden', { area: areas[0] });
  };
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.isAdmin) return next();
  res.status(403).render('forbidden', { area: 'Administration' });
}

module.exports = { requirePermission, requireAnyPermission, requireAdmin };
