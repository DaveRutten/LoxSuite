const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { invalidateTimezoneCache } = require('../dateFormat');
const { checkMiniserver } = require('../healthcheck');
const { logSystemEvent } = require('../auditLog');

const router = express.Router();
const TIMEZONES = Intl.supportedValuesOf('timeZone');
const STEPS = ['welcome', 'password', 'timezone', 'miniserver', 'done'];

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function currentStep(req) {
  const step = STEPS.includes(req.query.step) ? req.query.step : STEPS[0];
  return step;
}

function render(req, res, extra = {}) {
  res.render('setup-wizard', {
    step: currentStep(req),
    steps: STEPS,
    timezones: TIMEZONES,
    gatewaySettings: db.prepare('SELECT * FROM gateway_settings WHERE id = 1').get(),
    miniserverCount: db.prepare('SELECT COUNT(*) AS c FROM miniservers').get().c,
    error: null,
    ...extra,
  });
}

function markCompleted() {
  db.prepare('UPDATE gateway_settings SET setup_wizard_completed = 1 WHERE id = 1').run();
}

router.get('/', (req, res) => render(req, res));

router.post('/password', (req, res) => {
  const { new_password: newPassword, confirm_password: confirmPassword } = req.body;
  if (req.user.authProvider !== 'local') return res.redirect('/setup?step=timezone');

  if (newPassword) {
    if (newPassword.length < 8) return render(req, res, { error: 'New password must be at least 8 characters.' });
    if (newPassword !== confirmPassword) return render(req, res, { error: 'New password and confirmation do not match.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
    logSystemEvent(`"${req.user.username}" changed their password via the setup wizard.`);
  }
  res.redirect('/setup?step=timezone');
});

router.post('/timezone', (req, res) => {
  const timezone = (req.body.display_timezone || '').trim();
  if (timezone) {
    if (!isValidTimezone(timezone)) return render(req, res, { error: `"${timezone}" isn't a recognized timezone name.` });
    db.prepare('UPDATE gateway_settings SET display_timezone = ? WHERE id = 1').run(timezone);
    invalidateTimezoneCache();
  }
  res.redirect('/setup?step=miniserver');
});

router.post('/miniserver', async (req, res) => {
  const { name, host, http_port: httpPort, username, password, use_https: useHttps } = req.body;
  if (!name && !host && !username && !password) return res.redirect('/setup?step=done');
  if (!name || !host || !username || !password) {
    return render(req, res, { error: 'Name, host, username and password are all required to add a Miniserver — or leave every field blank to skip this step.' });
  }

  const result = db.prepare(
    `INSERT INTO miniservers (name, host, http_port, username, password, use_https) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(name, host, Number(httpPort) || 80, username, password, useHttps ? 1 : 0);
  logSystemEvent(`"${req.user.username}" added Miniserver "${name}" (${host}) via the setup wizard.`);

  // Same "don't leave it on Unknown" reasoning as the regular Add Miniserver form (routes/miniservers.js).
  const inserted = db.prepare('SELECT * FROM miniservers WHERE id = ?').get(result.lastInsertRowid);
  await checkMiniserver(inserted);

  res.redirect('/setup?step=done');
});

router.post('/finish', (req, res) => {
  markCompleted();
  res.redirect('/');
});

// Reachable from step 1 too ("Skip setup entirely") — marks it done outright rather than walking
// through every step, same end state as clicking Finish on the last one.
router.post('/skip', (req, res) => {
  markCompleted();
  res.redirect('/');
});

module.exports = router;
