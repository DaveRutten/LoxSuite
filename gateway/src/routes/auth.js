const express = require('express');
const bcrypt = require('bcryptjs');
const { generators } = require('openid-client');
const db = require('../db');
const ssoClient = require('../ssoClient');

const router = express.Router();

router.get('/login', (req, res) => {
  res.render('login', { error: null, ssoEnabled: ssoClient.isEnabled(), ssoButtonLabel: ssoClient.getButtonLabel() });
});

router.post('/login', (req, res) => {
  const { username, password, remember } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  // password_hash is null for SSO-only accounts — bcrypt.compareSync would throw on a null hash,
  // so that has to be checked before comparing rather than falling through to it.
  if (!user || !user.password_hash || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.render('login', { error: 'Invalid username or password.', ssoEnabled: ssoClient.isEnabled(), ssoButtonLabel: ssoClient.getButtonLabel() });
  }

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  req.session.userId = user.id;
  req.session.username = user.username;
  // Without "remember me" the cookie is a session cookie (default) and goes
  // away when the browser closes; with it, keep the login for 30 days.
  if (remember) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;

  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
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

    if (!user) {
      const sso = db.prepare('SELECT default_role_id FROM sso_settings WHERE id = 1').get();
      const username = claims.preferred_username || claims.email || `pocketid-${claims.sub}`;
      const result = db.prepare(
        `INSERT INTO users (username, role_id, auth_provider, sso_subject, email, display_name, avatar_url, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(username, sso?.default_role_id || null, 'pocket_id', claims.sub, claims.email || null, displayName, claims.picture || null, new Date().toISOString());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
      console.log(`Provisioned new Pocket ID user "${username}" via SSO.`);
    } else {
      // Refreshed on every login, not just once at provisioning — a name/avatar changed on the
      // Pocket ID side should show up here without needing to recreate the account.
      db.prepare('UPDATE users SET email = ?, display_name = ?, avatar_url = ?, last_login_at = ? WHERE id = ?')
        .run(claims.email || null, displayName, claims.picture || null, new Date().toISOString(), user.id);
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    res.redirect('/');
  } catch (err) {
    renderError(`Single Sign-On login failed: ${err.message}`);
  }
});

module.exports = router;
