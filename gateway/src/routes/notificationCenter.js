const express = require('express');
const db = require('../db');

const router = express.Router();

// The topbar bell's own two endpoints — deliberately separate from both /admin/notifications
// (admin-only rule configuration) and /logs/notifications (the permission-gated full logbook).
// This is ambient chrome for any logged-in user (see head.ejs/foot.ejs), same tier as Help/the
// account menu, so it's requireAuth-only at the mount point in server.js — no requirePermission
// gate — matching the decision that seeing *that* something notified isn't gated the way reading
// the full history is.

router.get('/unread-count', (req, res) => {
  // req.user (loadUserContext.js) doesn't carry last_seen_notification_id — re-read it directly
  // rather than widening that object for a value nothing else currently needs.
  const user = db.prepare('SELECT last_seen_notification_id FROM users WHERE id = ?').get(req.user.id);
  const row = db.prepare('SELECT COUNT(*) AS n FROM notification_events WHERE id > ?').get(user.last_seen_notification_id);
  res.json({ count: row.n });
});

router.post('/mark-read', (req, res) => {
  db.prepare('UPDATE users SET last_seen_notification_id = (SELECT COALESCE(MAX(id), 0) FROM notification_events) WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

// Removes one event from THIS user's own popover list (see loadUserContext.js's own dismissed
// filter) — not a delete, so Logs > Notifications and every other user's popover are unaffected.
// INSERT OR IGNORE: clicking "x" twice on the same item (a slow connection, a double click before
// the DOM removal below finishes) is a no-op the second time, not an error.
router.post('/:id/dismiss', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Invalid notification id.' });
  db.prepare('INSERT OR IGNORE INTO notification_dismissals (user_id, notification_event_id, dismissed_at) VALUES (?, ?, ?)')
    .run(req.user.id, id, new Date().toISOString());
  res.json({ ok: true });
});

// "Clear all" in the popover footer — dismisses every event currently in this user's own list in
// one round trip, rather than the client firing one /dismiss call per visible item.
router.post('/dismiss-all', (req, res) => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO notification_dismissals (user_id, notification_event_id, dismissed_at)
    SELECT ?, id, ? FROM notification_events
  `).run(req.user.id, now);
  res.json({ ok: true });
});

module.exports = router;
