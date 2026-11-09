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
  const muted = await mutedTypes(userId);
  return db.prepare(`
    SELECT * FROM notification_events
    WHERE id NOT IN (SELECT notification_event_id FROM notification_dismissals WHERE user_id = ?)${muted.length ? ` AND event_type NOT IN (${muted.map(() => '?').join(', ')})` : ''}
    ORDER BY id DESC LIMIT 15
  `).all(userId, ...muted);
}

// ---- What each user wants to get, per category (the Notifications page, "What do I want to get"):
//   bell  — off: that category is left out of this user's bell (the page still shows it)
//   push  — on: LoxSuite makes personal rules ("My rules") for the category's kinds, so they also go to
//           the user's own channel (Telegram …) and/or push on their devices (Profile → Notifications)
const PUSH_CATEGORIES = ['energy', 'quality', 'charging', 'loxone', 'system']; // Monitor needs a monitor and a value per rule
const AUTO_PREFIX = 'Auto · ';
async function mutedCategories(userId) {
  const all = await require('../wallboxSettings').get('notify_muted', {}).catch(() => ({}));
  return Array.isArray(all[userId]) ? all[userId] : [];
}
async function mutedTypes(userId) {
  const { CATEGORIES } = require('../notificationCategories');
  const cats = await mutedCategories(userId);
  return CATEGORIES.filter((c) => cats.includes(c.key)).flatMap((c) => c.types);
}
async function prefsFor(userId) {
  const { CATEGORIES } = require('../notificationCategories');
  const muted = await mutedCategories(userId);
  const own = await db.prepare('SELECT trigger_type FROM notification_rules WHERE owner_user_id = ? AND LOWER(name) LIKE LOWER(?)').all(userId, `${AUTO_PREFIX}%`).catch(() => []);
  const have = new Set(own.map((r) => r.trigger_type));
  const user = await db.prepare('SELECT notify_url, push_on FROM users WHERE id = ?').get(userId).catch(() => null);
  return {
    channel: { url: !!user?.notify_url, push: Number(user?.push_on) === 1 },
    rows: CATEGORIES.map((c) => ({ key: c.key, label: c.label, icon: c.icon, bell: !muted.includes(c.key), canPush: PUSH_CATEGORIES.includes(c.key), push: c.types.some((t) => have.has(t)) })),
  };
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
  const muted = await mutedTypes(req.user.id);
  const row = await db.prepare(`
    SELECT COUNT(*) AS n FROM notification_events
    WHERE id > ? AND id NOT IN (SELECT notification_event_id FROM notification_dismissals WHERE user_id = ?)${muted.length ? ` AND event_type NOT IN (${muted.map(() => '?').join(', ')})` : ''}
  `).get(user.last_seen_notification_id, req.user.id, ...muted);
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

// The Notifications page: every notification of the last 60 days as a card, grouped per day, with the
// category (notificationCategories.js), new/read, a link to where it is about, and filters. Like the bell
// it is for any logged-in user; a link only shows when the user may see its page (notificationLinks.js).
router.get('/', asyncHandler(async (req, res) => {
  const { categoryOf, CATEGORIES, OTHER, byDay } = require('../notificationCategories');
  const { localParts } = require('../localTime');
  const from = new Date(Date.now() - 60 * 86400000).toISOString();
  const events = await db.prepare('SELECT * FROM notification_events WHERE created_at >= ? ORDER BY id DESC LIMIT 400').all(from);
  const dismissed = new Set((await db.prepare('SELECT notification_event_id AS id FROM notification_dismissals WHERE user_id = ?').all(req.user.id)).map((r) => r.id));
  const user = await db.prepare('SELECT last_seen_notification_id FROM users WHERE id = ?').get(req.user.id);
  const seenUpTo = Number(user?.last_seen_notification_id) || 0;
  const list = events.map((e) => ({ ...e, category: categoryOf(e.event_type).key, unread: e.id > seenUpTo && !dismissed.has(e.id) }));
  const dayOf = (iso) => { const q = localParts(Date.parse(iso)); return `${q.y}-${String(q.m).padStart(2, '0')}-${String(q.d).padStart(2, '0')}`; };
  const counts = {};
  for (const e of list) counts[e.category] = (counts[e.category] || 0) + 1;
  const cats = [...CATEGORIES, OTHER].filter((c) => counts[c.key]).map((c) => ({ key: c.key, label: c.label, icon: c.icon, n: counts[c.key] }));
  const prefs = await prefsFor(req.user.id);
  res.render('notifications', { prefs, groups: byDay(list, dayOf), today: dayOf(new Date().toISOString()), yesterday: dayOf(new Date(Date.now() - 86400000).toISOString()), cats, total: list.length, unread: list.filter((e) => e.unread).length, active: 'notifications' });
}));

// What needs attention on a page (the Energy manager's "Attention" card): the warnings and errors of these
// types from the last days that this user has not dismissed yet, newest first.
async function attentionFor(userId, types, { days = 14, limit = 6 } = {}) {
  if (!types.length) return [];
  const from = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare(`
    SELECT * FROM notification_events
    WHERE event_type IN (${types.map(() => '?').join(', ')}) AND severity IN ('warning', 'error', 'critical') AND created_at >= ?
      AND id NOT IN (SELECT notification_event_id FROM notification_dismissals WHERE user_id = ?)
    ORDER BY id DESC LIMIT ?
  `).all(...types, from, userId, limit).catch(() => []);
}

// One category's choice: { category, bell?: bool, push?: bool }.
router.post('/prefs.json', asyncHandler(async (req, res) => {
  const { CATEGORIES } = require('../notificationCategories');
  const cat = CATEGORIES.find((c) => c.key === req.body?.category);
  if (!cat) return res.status(400).json({ ok: false, message: 'Unknown category.' });
  const uid = req.user.id;
  if (typeof req.body.bell === 'boolean') {
    const settings = require('../wallboxSettings');
    const all = await settings.get('notify_muted', {}).catch(() => ({}));
    const set = new Set(Array.isArray(all[uid]) ? all[uid] : []);
    if (req.body.bell) set.delete(cat.key); else set.add(cat.key);
    await settings.set('notify_muted', { ...all, [uid]: [...set] });
  }
  if (typeof req.body.push === 'boolean') {
    if (!PUSH_CATEGORIES.includes(cat.key)) return res.json({ ok: false, message: 'Set these up under Administration → Notifications (a rule needs a monitor and a value).' });
    const { TRIGGER_TYPES } = require('../notifications');
    const { buildRuleConfig } = require('./notifications');
    await db.transaction(async (tx) => {
      // the personal auto rules of this category: removed, and made again when it is switched on
      const old = await tx.prepare(`SELECT id FROM notification_rules WHERE owner_user_id = ? AND LOWER(name) LIKE LOWER(?) AND trigger_type IN (${cat.types.map(() => '?').join(', ')})`).all(uid, `${AUTO_PREFIX}%`, ...cat.types);
      for (const r of old) {
        await tx.prepare('DELETE FROM notification_rule_subscribers WHERE rule_id = ?').run(r.id);
        await tx.prepare('DELETE FROM notification_rules WHERE id = ?').run(r.id);
      }
      if (req.body.push) {
        for (const type of cat.types) {
          const tt = TRIGGER_TYPES.find((t) => t.key === type);
          if (!tt) continue;
          const ruleId = await tx.insertReturningId(
            'INSERT INTO notification_rules (trigger_type, name, enabled, config, last_state, created_at, owner_user_id) VALUES (?, ?, 1, ?, \'{}\', ?, ?)',
            [type, `${AUTO_PREFIX}${tt.label}`.slice(0, 200), JSON.stringify(buildRuleConfig(type, {})), new Date().toISOString(), uid],
          );
          await tx.prepare('INSERT INTO notification_rule_subscribers (rule_id, user_id) VALUES (?, ?)').run(ruleId, uid);
        }
      }
    });
  }
  res.json({ ok: true, prefs: await prefsFor(uid) });
}));

module.exports = router;
module.exports.loadRecentNotifications = loadRecentNotifications;
module.exports.attentionFor = attentionFor;
