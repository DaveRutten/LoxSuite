const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');

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
async function loadRecentNotifications(userId) {
  return db.prepare(`
    SELECT * FROM notification_events
    WHERE id NOT IN (SELECT notification_event_id FROM notification_dismissals WHERE user_id = ?)
    ORDER BY id DESC LIMIT 15
  `).all(userId);
}

// Unread = arrived after the bulk "seen up to here" watermark (mark-read/View all — see
// /mark-read below) AND not individually dismissed (the "x" button, or clicking through to an
// item's own source — see /:id/dismiss and /:id/mark-read below). Both conditions matter: without
// the dismissal check, clicking through to just ONE of several unread items would have no way to
// mark just that one without the watermark bump also sweeping in every other item at or below its
// id — confirmed as a real bug (two unread events, clicking the newer one's source cleared the
// badge to 0 even though the older one had never been looked at).
router.get('/unread-count', asyncHandler(async (req, res) => {
  // req.user (loadUserContext.js) doesn't carry last_seen_notification_id — re-read it directly
  // rather than widening that object for a value nothing else currently needs.
  const user = await db.prepare('SELECT last_seen_notification_id FROM users WHERE id = ?').get(req.user.id);
  const row = await db.prepare(`
    SELECT COUNT(*) AS n FROM notification_events
    WHERE id > ? AND id NOT IN (SELECT notification_event_id FROM notification_dismissals WHERE user_id = ?)
  `).get(user.last_seen_notification_id, req.user.id);
  res.json({ count: row.n });
}));

// Re-renders the popover's own item list — polled alongside /unread-count (see foot.ejs) so the
// LIST catches up to a newly-arrived notification too, not just the badge count. Before this
// existed, the list was whatever got baked into the page at its last full load; the badge could
// already show "1" while the popover's own content still didn't include that new item at all,
// until an actual navigation or F5 re-rendered the page from scratch.
router.get('/recent', asyncHandler(async (req, res) => {
  res.render('partials/notification-center-items', { recentNotifications: await loadRecentNotifications(req.user.id) });
}));

router.post('/mark-read', asyncHandler(async (req, res) => {
  await db.prepare('UPDATE users SET last_seen_notification_id = (SELECT COALESCE(MAX(id), 0) FROM notification_events) WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
}));

// Fired when the popover's own item link is clicked (see foot.ejs), i.e. the user actually
// navigated to that event's source rather than just glancing at the popover — an explicit
// per-item acknowledgement, same insertIgnore into notification_dismissals as the "x" button
// below (NOT a watermark bump — see unread-count's own comment for why that used to incorrectly
// also mark OTHER, never-looked-at items as read).
router.post('/:id/mark-read', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Invalid notification id.' });
  await db.insertIgnore('notification_dismissals', { user_id: req.user.id, notification_event_id: id, dismissed_at: new Date().toISOString() }, ['user_id', 'notification_event_id']);
  res.json({ ok: true });
}));

// Removes one event from THIS user's own popover list (see loadUserContext.js's own dismissed
// filter) — not a delete, so Logs > Notifications and every other user's popover are unaffected.
// insertIgnore: clicking "x" twice on the same item (a slow connection, a double click before
// the DOM removal below finishes) is a no-op the second time, not an error.
router.post('/:id/dismiss', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Invalid notification id.' });
  await db.insertIgnore('notification_dismissals', { user_id: req.user.id, notification_event_id: id, dismissed_at: new Date().toISOString() }, ['user_id', 'notification_event_id']);
  res.json({ ok: true });
}));

// "Clear all" in the popover footer — dismisses every event currently in this user's own list in
// one round trip, rather than the client firing one /dismiss call per visible item.
router.post('/dismiss-all', asyncHandler(async (req, res) => {
  const now = new Date().toISOString();
  // A bulk INSERT ... SELECT ... ON CONFLICT DO NOTHING — not a shape Knex's own object-based
  // .insert().onConflict() builder covers, so this stays raw SQL, but in the SQL-standard `ON
  // CONFLICT (cols) DO NOTHING` form (valid on SQLite and Postgres unchanged) instead of SQLite's
  // own proprietary `INSERT OR IGNORE` keyword, which Postgres doesn't have at all. The `WHERE 1=1`
  // is required, not decorative: SQLite's own parser treats a bare `FROM notification_events ON
  // CONFLICT` as ambiguous with a JOIN's own `ON` keyword and rejects it outright (verified
  // directly — this is a real grammar quirk, not a typo) unless something legal comes between the
  // FROM clause and the ON CONFLICT clause; harmless everywhere else, including Postgres.
  await db.prepare(`
    INSERT INTO notification_dismissals (user_id, notification_event_id, dismissed_at)
    SELECT ?, id, ? FROM notification_events WHERE 1=1
    ON CONFLICT (user_id, notification_event_id) DO NOTHING
  `).run(req.user.id, now);
  res.json({ ok: true });
}));

module.exports = router;
module.exports.loadRecentNotifications = loadRecentNotifications;
