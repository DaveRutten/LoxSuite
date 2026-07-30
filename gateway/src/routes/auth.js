const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { generators } = require('openid-client');
const db = require('../db');
const ssoClient = require('../ssoClient');
const { isPrivateNetworkRequest } = require('../network');
const { logSystemEvent } = require('../auditLog');

// Local username/password login is refused when SSO's break-glass restriction is on AND the
// request isn't coming from the local network — the local network exemption is exactly the
// "break glass" part, so admins aren't locked out entirely if the external IdP goes down.
function localLoginAllowed(req) {
  return !ssoClient.isLocalLoginDisabled() || isPrivateNetworkRequest(req);
}

const router = express.Router();

// Password guessing is the only real brute-force surface here — SSO login has no password to
// guess, and its own external IdP already rate-limits itself. Keyed on IP only (no per-username
// tracking), so it caps how fast any one client can try passwords regardless of which account.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Please wait a few minutes and try again.',
});

router.get('/login', (req, res) => {
  res.render('login', {
    error: null,
    ssoEnabled: ssoClient.isEnabled(),
    ssoButtonLabel: ssoClient.getButtonLabel(),
    localLoginAllowed: localLoginAllowed(req),
  });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password, remember } = req.body;

  if (!localLoginAllowed(req)) {
    logSystemEvent(`Local sign-in blocked for "${username}" from ${req.ip} (SSO break-glass restriction, not a local address).`);
    return res.status(403).render('login', {
      error: 'Local sign-in is turned off from outside the local network — use Single Sign-On instead.',
      ssoEnabled: ssoClient.isEnabled(),
      ssoButtonLabel: ssoClient.getButtonLabel(),
      localLoginAllowed: false,
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  // password_hash is null for SSO-only accounts — bcrypt.compareSync would throw on a null hash,
  // so that has to be checked before comparing rather than falling through to it.
  if (!user || !user.password_hash || !bcrypt.compareSync(password || '', user.password_hash)) {
    logSystemEvent(`Failed local login attempt for "${username}" from ${req.ip}.`);
    return res.render('login', { error: 'Invalid username or password.', ssoEnabled: ssoClient.isEnabled(), ssoButtonLabel: ssoClient.getButtonLabel(), localLoginAllowed: true });
  }

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  req.session.userId = user.id;
  req.session.username = user.username;
  // Without "remember me" the cookie is a session cookie (default) and goes
  // away when the browser closes; with it, keep the login for 30 days.
  if (remember) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;

  logSystemEvent(`"${user.username}" logged in (local) from ${req.ip}.`);
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  const username = req.session.username;
  req.session.destroy(() => {
    if (username) logSystemEvent(`"${username}" logged out.`);
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
    res.render('login', { error: `Single Sign-On is unavailable: ${err.message}`, ssoEnabled: ssoClient.isEnabled(), ssoButtonLabel: ssoClient.getButtonLabel() });
  }
});

router.get('/auth/sso/callback', async (req, res) => {
  const renderError = (message) =>
    res.render('login', { error: message, ssoEnabled: ssoClient.isEnabled(), ssoButtonLabel: ssoClient.getButtonLabel() });

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

    let user = db.prepare('SELECT * FROM users WHERE sso_subject = ?').get(claims.sub);
    const displayName = claims.name || claims.preferred_username || null;
    const firstName = claims.given_name || null;
    const lastName = claims.family_name || null;

    if (!user) {
      const sso = db.prepare('SELECT default_role_id FROM sso_settings WHERE id = 1').get();
      const username = claims.preferred_username || claims.email || `pocketid-${claims.sub}`;
      const result = db.prepare(
        `INSERT INTO users (username, role_id, auth_provider, sso_subject, email, display_name, first_name, last_name, avatar_url, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(username, sso?.default_role_id || null, 'pocket_id', claims.sub, claims.email || null, displayName, firstName, lastName, claims.picture || null, new Date().toISOString());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
      console.log(`Provisioned new Pocket ID user "${username}" via SSO.`);
    } else {
      // Refreshed on every login, not just once at provisioning — a name/avatar changed on the
      // Pocket ID side should show up here without needing to recreate the account.
      db.prepare('UPDATE users SET email = ?, display_name = ?, first_name = ?, last_name = ?, avatar_url = ?, last_login_at = ? WHERE id = ?')
        .run(claims.email || null, displayName, firstName, lastName, claims.picture || null, new Date().toISOString(), user.id);
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    logSystemEvent(`"${user.username}" logged in (SSO) from ${req.ip}.`);
    res.redirect('/');
  } catch (err) {
    logSystemEvent(`SSO login failed from ${req.ip}: ${err.message}`);
    renderError(`Single Sign-On login failed: ${err.message}`);
  }
});

module.exports = router;
