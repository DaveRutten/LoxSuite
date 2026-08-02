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

module.exports = router;
