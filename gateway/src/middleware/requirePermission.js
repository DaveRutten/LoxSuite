// Server-side enforcement of the Access Roles permission matrix (see permissionAreas.js). Nav
// links hiding a page a role can't see is UX only — these two are the actual security boundary.
function requirePermission(area, level) {
  return function (req, res, next) {
    if (req.user && (req.user.isAdmin || req.user.permissions[area]?.[level])) return next();
    res.status(403).render('forbidden', { area });
  };
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.isAdmin) return next();
  res.status(403).render('forbidden', { area: 'Administration' });
}

module.exports = { requirePermission, requireAdmin };
