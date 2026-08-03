const express = require('express');
const db = require('../db');

const router = express.Router();

// The topbar bell's own two endpoints — deliberately separate from both /admin/notifications
// (admin-only rule configuration) and /logs/notifications (the permission-gated full logbook).
// This is ambient chrome for any logged-in user (see head.ejs/foot.ejs), same tier as Help/the
// account menu, so it's requireAuth-only at the mount point in server.js — no requirePermission
// gate — matching the decision that seeing *that* something notified isn't gated the way reading
// the full history is.

// Shared with middleware/loadUserContext.js (the initial page-load render) so the popover's list
// is never a second, drifting copy of this query — this file owns it since it's also what the
// /recent poll below re-runs on every fetch.
function loadRecentNotifications(userId) {
  return db.prepare(`
    SELECT * FROM notification_events
    WHERE id NOT IN (SELECT notification_event_id FROM notification_dismissals WHERE user_id = ?)
    ORDER BY id DESC LIMIT 15
  `).all(userId);
}

router.get('/unread-count', (req, res) => {
  // req.user (loadUserContext.js) doesn't carry last_seen_notification_id — re-read it directly
  // rather than widening that object for a value nothing else currently needs.
  const user = db.prepare('SELECT last_seen_notification_id FROM users WHERE id = ?').get(req.user.id);
  const row = db.prepare('SELECT COUNT(*) AS n FROM notification_events WHERE id > ?').get(user.last_seen_notification_id);
  res.json({ count: row.n });
});

// Re-renders the popover's own item list — polled alongside /unread-count (see foot.ejs) so the
// LIST catches up to a newly-arrived notification too, not just the badge count. Before this
// existed, the list was whatever got baked into the page at its last full load; the badge could
// already show "1" while the popover's own content still didn't include that new item at all,
// until an actual navigation or F5 re-rendered the page from scratch.
router.get('/recent', (req, res) => {
  res.render('partials/notification-center-items', { recentNotifications: loadRecentNotifications(req.user.id) });
});

router.post('/mark-read', (req, res) => {
  db.prepare('UPDATE users SET last_seen_notification_id = (SELECT COALESCE(MAX(id), 0) FROM notification_events) WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

// Advances the watermark to (at least) this one event, not to whatever's newest overall (that's
// /mark-read above), so an unread event that arrived after this one and hasn't been looked at yet
// still counts. MAX(..., ...) here is SQLite's 2+-argument scalar max, not the single-argument
// aggregate — never lets a stale/out-of-order request move the watermark backwards. Shared by
// both routes below it: clicking through to an item's source and dismissing it are two different
// gestures, but both are an explicit "I've dealt with this one" — same effect on the badge.
function markReadUpTo(userId, id) {
  db.prepare('UPDATE users SET last_seen_notification_id = MAX(last_seen_notification_id, ?) WHERE id = ?').run(id, userId);
}

// Fired when the popover's own item link is clicked (see foot.ejs), i.e. the user actually
// navigated to that event's source rather than just glancing at the popover.
router.post('/:id/mark-read', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Invalid notification id.' });
  markReadUpTo(req.user.id, id);
  res.json({ ok: true });
});

// Removes one event from THIS user's own popover list (see loadUserContext.js's own dismissed
// filter) — not a delete, so Logs > Notifications and every other user's popover are unaffected.
// INSERT OR IGNORE: clicking "x" twice on the same item (a slow connection, a double click before
// the DOM removal below finishes) is a no-op the second time, not an error. Also advances the
// watermark the same way /:id/mark-read does — dismissing is at least as explicit an
// acknowledgement as clicking through, so leaving the badge counting a just-dismissed item would
// be inconsistent.
router.post('/:id/dismiss', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Invalid notification id.' });
  db.prepare('INSERT OR IGNORE INTO notification_dismissals (user_id, notification_event_id, dismissed_at) VALUES (?, ?, ?)')
    .run(req.user.id, id, new Date().toISOString());
  markReadUpTo(req.user.id, id);
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
module.exports.loadRecentNotifications = loadRecentNotifications;
