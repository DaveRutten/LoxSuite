// Account menu > App & push (webPush.js): install LoxSuite on the phone's home screen, switch push on
// for this device, send a test, and hook push up to notification rules.
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const webPush = require('../webPush');
const reminders = require('../reminders');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const channel = await db.prepare("SELECT id, name FROM notification_channels WHERE LOWER(url) LIKE LOWER('loxsuite-push://%') ORDER BY id LIMIT 1").get();
  const me = await db.prepare('SELECT notify_url FROM users WHERE id = ?').get(req.user?.id || req.session?.userId);
  res.locals.isAdminUser = !!req.user?.isAdmin;
  res.render('app', {
    devices: await webPush.listDevices(), channel, myPush: (me?.notify_url || '').startsWith('loxsuite-push://'),
    userId: req.user?.id || req.session?.userId, saved: req.query.saved || null,
    pushSubject: (await webPush.keys().catch(() => null))?.subject || null,
  });
}));

router.get('/vapid.json', asyncHandler(async (req, res) => {
  res.json({ publicKey: await webPush.publicKey() });
}));

router.post('/subscribe', asyncHandler(async (req, res) => {
  try {
    await webPush.subscribe(req.user?.id || req.session?.userId, req.body?.subscription, req.get('user-agent'));
    // The https address this device uses becomes the push contact (Apple rejects a made-up one).
    const origin = req.get('origin') || (req.get('x-forwarded-proto') && req.get('x-forwarded-host') ? `${req.get('x-forwarded-proto')}://${req.get('x-forwarded-host')}` : `${req.protocol}://${req.get('host')}`);
    await webPush.adoptOrigin(origin).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
}));

router.post('/unsubscribe', asyncHandler(async (req, res) => {
  if (req.body?.endpoint) await webPush.unsubscribe(req.body.endpoint);
  res.json({ ok: true });
}));

router.post('/test', asyncHandler(async (req, res) => {
  try {
    const r = await webPush.send({ userId: req.user?.id || req.session?.userId }, {
      title: 'LoxSuite', body: 'Push works. Car reminders and other notifications can now arrive on this device.', url: '/planner', tag: 'test',
    });
    res.json({ ok: true, sent: r.sent, failed: r.failed, errors: r.errors });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
}));

router.post('/subject', asyncHandler(async (req, res) => {
  if (!req.user?.isAdmin) return res.json({ ok: false, message: 'Only an administrator can change this.' });
  try { res.json({ ok: true, subject: await webPush.setSubject(req.body?.subject) }); } catch (err) { res.json({ ok: false, message: err.message }); }
}));

// Buttons in a push notification (sent by the service worker).
router.post('/action', asyncHandler(async (req, res) => {
  const action = String(req.body?.action || '');
  if (!/^(snooze|skip|vehicle:\d+)$/.test(action)) return res.json({ ok: false });
  await reminders.handleAction(action);
  res.json({ ok: true });
}));

// One click: a notification channel for all devices, and/or this user's own notifications to push.
router.post('/channel', asyncHandler(async (req, res) => {
  if (!req.user?.isAdmin) return res.redirect('/app');
  const exists = await db.prepare("SELECT id FROM notification_channels WHERE url = 'loxsuite-push://all'").get();
  if (!exists) await db.prepare("INSERT INTO notification_channels (name, url, enabled, created_at) VALUES ('LoxSuite app (all devices)', 'loxsuite-push://all', 1, ?)").run(new Date().toISOString());
  res.redirect('/app?saved=channel');
}));

router.post('/me', asyncHandler(async (req, res) => {
  const id = req.user?.id || req.session?.userId;
  await db.prepare('UPDATE users SET notify_url = ? WHERE id = ?').run(`loxsuite-push://user/${id}`, id);
  res.redirect('/app?saved=me');
}));

module.exports = router;
