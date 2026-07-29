const { nanoid } = require('nanoid');

// Synchronizer-token CSRF protection, scoped to what a plain cross-site <form> can actually
// forge: a classic application/x-www-form-urlencoded POST. JSON requests are exempt — a plain
// HTML form can't set that content-type, and a script-driven cross-origin fetch() to it would be
// blocked by the browser's CORS preflight (this server sends no Access-Control-Allow-Origin).
// Multipart (file upload) requests are exempt here too, since express.urlencoded/json never
// parses them — multer parses the body later, at the route itself, where the token is instead
// checked directly (see routes/backup.js's /restore route).
function attachCsrfToken(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = nanoid();
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function verifyCsrfToken(req, res, next) {
  const stateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (!stateChanging) return next();
  if (req.is('application/json') || req.is('multipart/form-data')) return next();

  if (req.body && typeof req.body._csrf === 'string' && req.body._csrf === req.session.csrfToken) {
    return next();
  }
  res.status(403).send('Forbidden: missing or invalid CSRF token. Go back, refresh the page, and try again.');
}

module.exports = { attachCsrfToken, verifyCsrfToken };
