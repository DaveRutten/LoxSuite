const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

function loadProfile(userId) {
  return db.prepare('SELECT id, username, email, display_name, avatar_url, auth_provider, role_id FROM users WHERE id = ?').get(userId);
}

router.get('/', (req, res) => {
  res.render('profile', { profile: loadProfile(req.user.id), error: null, saved: false });
});

router.post('/details', (req, res) => {
  if (req.user.authProvider !== 'local') {
    return res.render('profile', { profile: loadProfile(req.user.id), error: 'Your name and email come from Pocket ID and can\'t be edited here.', saved: false });
  }

  const displayName = (req.body.display_name || '').trim();
  const email = (req.body.email || '').trim();
  db.prepare('UPDATE users SET display_name = ?, email = ? WHERE id = ?').run(displayName || null, email || null, req.user.id);

  res.render('profile', { profile: loadProfile(req.user.id), error: null, saved: true });
});

router.post('/password', (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;

  if (req.user.authProvider !== 'local') {
    return res.render('profile', { profile: loadProfile(req.user.id), error: 'Your account signs in via SSO — there is no local password to change.', saved: false });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.password_hash || !bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.render('profile', { profile: loadProfile(req.user.id), error: 'Current password is incorrect.', saved: false });
  }
  if (!new_password || new_password.length < 8) {
    return res.render('profile', { profile: loadProfile(req.user.id), error: 'New password must be at least 8 characters.', saved: false });
  }
  if (new_password !== confirm_password) {
    return res.render('profile', { profile: loadProfile(req.user.id), error: 'New password and confirmation do not match.', saved: false });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.render('profile', { profile: loadProfile(req.user.id), error: null, saved: true });
});

module.exports = router;
