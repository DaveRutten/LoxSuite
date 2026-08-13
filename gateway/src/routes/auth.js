const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { generators } = require('openid-client');
const db = require('../db');
const ssoClient = require('../ssoClient');
const { isPrivateNetworkRequest } = require('../network');
const { logSystemEvent } = require('../auditLog');
const { getSqliteImportStatus } = require('../sqliteImportStatus');
const asyncHandler = require('../middleware/asyncHandler');

// Local username/password login is refused when SSO's break-glass restriction is on AND the
// request isn't coming from the local network — the local network exemption is exactly the
// "break glass" part, so admins aren't locked out entirely if the external IdP goes down.
async function localLoginAllowed(req) {
  return !(await ssoClient.isLocalLoginDisabled()) || isPrivateNetworkRequest(req);
}

// Sends a freshly-logged-in Administrator through the setup wizard (routes/setup.js) instead of
// straight to the Dashboard, but only once ever, install-wide (see db.js's setup_wizard_completed
// column) and only for an admin — a non-admin role has no business being walked through changing
// global settings/adding Miniservers. The wizard itself stays reachable any time afterward from
// Settings, this is just the one-time nudge toward it.
async function postLoginRedirect(user) {
  const role = user.role_id ? await db.prepare('SELECT is_admin FROM access_roles WHERE id = ?').get(user.role_id) : null;
  const isAdmin = !!(role && role.is_admin);
  // Takes priority over setup_wizard_completed below and fires on every login, not just the very
  // first one ever — unlike the rest of the wizard, this can become relevant on an install that
  // finished setup long ago (whenever DB_BACKEND actually gets switched away from SQLite), so it
  // can't be gated behind the same "only once, ever" flag. See sqliteImportStatus.js.
  if (isAdmin && getSqliteImportStatus().available) return '/setup/import';
  const settings = await db.prepare('SELECT setup_wizard_completed FROM gateway_settings WHERE id = 1').get();
  if (settings.setup_wizard_completed) return '/';
  return isAdmin ? '/setup' : '/';
}

const router = express.Router();

// Password guessing is the only real brute-force surface here — SSO login has no password to
// guess, and its own external IdP already rate-limits itself. Keyed on IP only (no per-username
// tracking), so it caps how fast any one client can try passwords regardless of which account.
// Configurable from Settings -> General (routes/settings.js) — express-rate-limit v7 lets `max`
// vary per-request via a function, but `windowMs` is a plain fixed number at construction time, so
// changing the window means building a brand new limiter. reloadLoginLimiter() does that and
// reassigns the module-level reference; the route below calls through it indirectly (`(req, res,
// next) => loginLimiter(req, res, next)`, not `loginLimiter` itself) so it always dispatches to
// whichever instance is current instead of the one that existed at startup.
async function buildLoginLimiter() {
  const settings = await db.prepare('SELECT login_rate_limit_max, login_rate_limit_window_minutes FROM gateway_settings WHERE id = 1').get();
  return rateLimit({
    windowMs: (settings?.login_rate_limit_window_minutes ?? 15) * 60 * 1000,
    max: settings?.login_rate_limit_max ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many login attempts. Please wait a few minutes and try again.',
  });
}

// A synchronous default (no gateway_settings row read yet) so `router.post('/login', ...)` below
// always has a real limiter to dispatch through even before reloadLoginLimiter()'s first async
// rebuild (triggered once at boot — see server.js) resolves against the real saved settings.
let loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: 'Too many login attempts. Please wait a few minutes and try again.' });

async function reloadLoginLimiter() {
  loginLimiter = await buildLoginLimiter();
}

router.get('/login', asyncHandler(async (req, res) => {
  res.render('login', {
    error: null,
    ssoEnabled: await ssoClient.isEnabled(),
    ssoButtonLabel: await ssoClient.getButtonLabel(),
    localLoginAllowed: await localLoginAllowed(req),
  });
}));

router.post('/login', (req, res, next) => loginLimiter(req, res, next), asyncHandler(async (req, res) => {
  const { username, password, remember } = req.body;

  if (!(await localLoginAllowed(req))) {
    await logSystemEvent(`Local sign-in blocked for "${username}" from ${req.ip} (SSO break-glass restriction, not a local address).`);
    return res.status(403).render('login', {
      error: 'Local sign-in is turned off from outside the local network — use Single Sign-On instead.',
      ssoEnabled: await ssoClient.isEnabled(),
      ssoButtonLabel: await ssoClient.getButtonLabel(),
      localLoginAllowed: false,
    });
  }

  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  // password_hash is null for SSO-only accounts — bcrypt.compareSync would throw on a null hash,
  // so that has to be checked before comparing rather than falling through to it.
  if (!user || !user.password_hash || !bcrypt.compareSync(password || '', user.password_hash)) {
    await logSystemEvent(`Failed local login attempt for "${username}" from ${req.ip}.`);
    return res.render('login', { error: 'Invalid username or password.', ssoEnabled: await ssoClient.isEnabled(), ssoButtonLabel: await ssoClient.getButtonLabel(), localLoginAllowed: true });
  }

  await db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  req.session.userId = user.id;
  req.session.username = user.username;
  // Without "remember me" the cookie is a session cookie (default) and goes
  // away when the browser closes; with it, keep the login for 30 days.
  if (remember) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;

  await logSystemEvent(`"${user.username}" logged in (local) from ${req.ip}.`);
  res.redirect(await postLoginRedirect(user));
}));

router.post('/logout', (req, res) => {
  const username = req.session.username;
  req.session.destroy(() => {
    if (username) logSystemEvent(`"${username}" logged out.`).catch((err) => console.error('Failed to log logout event:', err.message));
    res.redirect('/login');
  });
});

router.get('/login/sso', async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const client = await ssoClient.getClient(baseUrl);

    const codeVerifier = generators.codeVerifier();
    const state = generators.state();
    req.session.ssoCodeVerifier = codeVerifier;
    req.session.ssoState = state;

    const url = client.authorizationUrl({
      scope: 'openid profile email',
      code_challenge: generators.codeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
    });
    res.redirect(url);
  } catch (err) {
    res.render('login', { error: `Single Sign-On is unavailable: ${err.message}`, ssoEnabled: await ssoClient.isEnabled(), ssoButtonLabel: await ssoClient.getButtonLabel() });
  }
});

router.get('/auth/sso/callback', async (req, res) => {
  const renderError = async (message) =>
    res.render('login', { error: message, ssoEnabled: await ssoClient.isEnabled(), ssoButtonLabel: await ssoClient.getButtonLabel() });

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const client = await ssoClient.getClient(baseUrl);

    const params = client.callbackParams(req);
    const codeVerifier = req.session.ssoCodeVerifier;
    const expectedState = req.session.ssoState;
    delete req.session.ssoCodeVerifier;
    delete req.session.ssoState;

    if (!codeVerifier || !expectedState) return renderError('Your login attempt expired — please try again.');

    const tokenSet = await client.callback(`${baseUrl}/auth/sso/callback`, params, {
      code_verifier: codeVerifier,
      state: expectedState,
    });
    const claims = tokenSet.claims();
    if (!claims.sub) return renderError('Pocket ID did not return an account identifier.');

    let user = await db.prepare('SELECT * FROM users WHERE sso_subject = ?').get(claims.sub);
    const displayName = claims.name || claims.preferred_username || null;
    const firstName = claims.given_name || null;
    const lastName = claims.family_name || null;

    if (!user) {
      const sso = await db.prepare('SELECT default_role_id FROM sso_settings WHERE id = 1').get();
      const username = claims.preferred_username || claims.email || `pocketid-${claims.sub}`;
      const newId = await db.insertReturningId(
        `INSERT INTO users (username, role_id, auth_provider, sso_subject, email, display_name, first_name, last_name, avatar_url, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [username, sso?.default_role_id || null, 'pocket_id', claims.sub, claims.email || null, displayName, firstName, lastName, claims.picture || null, new Date().toISOString()]
      );
      user = await db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
      console.log(`Provisioned new Pocket ID user "${username}" via SSO.`);
    } else {
      // Refreshed on every login, not just once at provisioning — a name/avatar changed on the
      // Pocket ID side should show up here without needing to recreate the account.
      await db.prepare('UPDATE users SET email = ?, display_name = ?, first_name = ?, last_name = ?, avatar_url = ?, last_login_at = ? WHERE id = ?')
        .run(claims.email || null, displayName, firstName, lastName, claims.picture || null, new Date().toISOString(), user.id);
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    await logSystemEvent(`"${user.username}" logged in (SSO) from ${req.ip}.`);
    res.redirect(await postLoginRedirect(user));
  } catch (err) {
    await logSystemEvent(`SSO login failed from ${req.ip}: ${err.message}`);
    await renderError(`Single Sign-On login failed: ${err.message}`);
  }
});

// Attached to the router itself (rather than exporting {router, reloadLoginLimiter}) since
// server.js already does `app.use(authRoutes)` expecting a router, not a wrapper object.
router.reloadLoginLimiter = reloadLoginLimiter;
module.exports = router;
