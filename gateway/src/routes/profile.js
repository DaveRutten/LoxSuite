const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { TRIGGER_TYPES, sendTestMessage } = require('../notifications');
const { buildRuleConfig } = require('./notifications');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

async function loadProfile(userId) {
  return db.prepare('SELECT id, username, email, display_name, avatar_url, auth_provider, role_id, notify_url, table_page_size FROM users WHERE id = ?').get(userId);
}

// Every enabled ADMIN-WIDE rule (owner_user_id IS NULL — see admin-notifications.ejs and
// migrateNotificationRulesOwner in db.js), each flagged with whether THIS user has personally
// opted into it (notification_rule_subscribers). A user's own personal rules (below) are managed
// entirely separately and never appear in this list — subscribing to your own rule would be a
// confusing double negative when unchecking it. A disabled rule never fires at all, so there's
// nothing meaningful to subscribe to there and it's left out entirely rather than shown greyed out.
async function loadNotifyRules(userId) {
  const rules = await db.prepare('SELECT id, trigger_type, name FROM notification_rules WHERE enabled = 1 AND owner_user_id IS NULL ORDER BY name').all();
  const subscribed = new Set(
    (await db.prepare('SELECT rule_id FROM notification_rule_subscribers WHERE user_id = ?').all(userId)).map((r) => r.rule_id)
  );
  return rules.map((rule) => ({
    ...rule,
    triggerLabel: (TRIGGER_TYPES.find((t) => t.key === rule.trigger_type) || {}).label || rule.trigger_type,
    subscribed: subscribed.has(rule.id),
  }));
}

// This user's own rules (owner_user_id = them) — always auto-delivered to their own channel (see
// the auto-subscribe in the create route below), no separate on/off toggle the way admin-wide
// rules need one: unlike those, nobody ELSE could have already subscribed a personal rule for you.
async function loadMyRules(userId) {
  const rules = await db.prepare('SELECT * FROM notification_rules WHERE owner_user_id = ? ORDER BY name').all(userId);
  return rules.map((rule) => ({
    ...rule,
    config: JSON.parse(rule.config || '{}'),
    triggerLabel: (TRIGGER_TYPES.find((t) => t.key === rule.trigger_type) || {}).label || rule.trigger_type,
  }));
}

// A personal rule can only ever point at a Monitor/Miniserver this user can currently view — same
// boundary the rest of the app already draws for them, just enforced here too rather than letting
// the rule form leak the existence/names of things outside their Access Role.
async function loadRuleFormOptions(res) {
  return {
    monitors: res.locals.canView('monitor') ? await db.prepare('SELECT id, label FROM monitors ORDER BY label').all() : [],
    miniservers: res.locals.canView('miniservers') ? await db.prepare('SELECT id, name FROM miniservers ORDER BY sort_order, id').all() : [],
  };
}

async function renderPage(res, userId, extra = {}) {
  res.render('profile', {
    profile: await loadProfile(userId),
    tab: 'account',
    notifyRules: await loadNotifyRules(userId),
    myRules: await loadMyRules(userId),
    triggerTypes: TRIGGER_TYPES,
    ...(await loadRuleFormOptions(res)),
    error: null,
    saved: false,
    testResult: null,
    ...extra,
  });
}

router.get('/', asyncHandler(async (req, res) => {
  await renderPage(res, req.user.id, { tab: req.query.tab === 'notifications' ? 'notifications' : 'account' });
}));

router.post('/details', asyncHandler(async (req, res) => {
  if (req.user.authProvider !== 'local') {
    return renderPage(res, req.user.id, { error: 'Your name and email come from Pocket ID and can\'t be edited here.' });
  }

  const displayName = (req.body.display_name || '').trim();
  const email = (req.body.email || '').trim();
  await db.prepare('UPDATE users SET display_name = ?, email = ? WHERE id = ?').run(displayName || null, email || null, req.user.id);

  await renderPage(res, req.user.id, { saved: true });
}));

router.post('/password', asyncHandler(async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;

  if (req.user.authProvider !== 'local') {
    return renderPage(res, req.user.id, { error: 'Your account signs in via SSO — there is no local password to change.' });
  }

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.password_hash || !bcrypt.compareSync(current_password || '', user.password_hash)) {
    return renderPage(res, req.user.id, { error: 'Current password is incorrect.' });
  }
  if (!new_password || new_password.length < 8) {
    return renderPage(res, req.user.id, { error: 'New password must be at least 8 characters.' });
  }
  if (new_password !== confirm_password) {
    return renderPage(res, req.user.id, { error: 'New password and confirmation do not match.' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  await renderPage(res, req.user.id, { saved: true });
}));

// ---- Notifications tab ----
// Deliberately its own small section rather than folded into /details: a personal Apprise channel
// isn't part of "your name and email" (SSO users, who can't touch those two fields at all, should
// still be able to set this), and keeping it separate means an SSO user's read-only /details error
// never fires here.

router.post('/notifications/channel', asyncHandler(async (req, res) => {
  const url = (req.body.notify_url || '').trim();
  await db.prepare('UPDATE users SET notify_url = ? WHERE id = ?').run(url || null, req.user.id);
  await renderPage(res, req.user.id, { tab: 'notifications', saved: true });
}));

router.post('/notifications/channel/test', asyncHandler(async (req, res) => {
  const profile = await loadProfile(req.user.id);
  if (!profile.notify_url) {
    return renderPage(res, req.user.id, { tab: 'notifications', error: 'Add your channel URL and save it before sending a test.' });
  }
  try {
    await sendTestMessage({ name: 'My notifications', url: profile.notify_url });
    await renderPage(res, req.user.id, { tab: 'notifications', testResult: { ok: true } });
  } catch (err) {
    await renderPage(res, req.user.id, { tab: 'notifications', testResult: { ok: false, error: err.message } });
  }
}));

router.post('/notifications/subscriptions', asyncHandler(async (req, res) => {
  const ruleIds = [].concat(req.body.rule_ids || []).map(Number).filter(Boolean);
  await db.transaction(async (tx) => {
    // Scoped to admin-wide rules only — clearing every subscriber row unconditionally would also
    // drop the auto-subscription this user's OWN rules set up for them (see the create route
    // below), which this checklist never lists or lets them touch in the first place.
    await tx.prepare('DELETE FROM notification_rule_subscribers WHERE user_id = ? AND rule_id IN (SELECT id FROM notification_rules WHERE owner_user_id IS NULL)').run(req.user.id);
    for (const ruleId of ruleIds) {
      await tx.prepare('INSERT OR IGNORE INTO notification_rule_subscribers (rule_id, user_id) VALUES (?, ?)').run(ruleId, req.user.id);
    }
  });
  await renderPage(res, req.user.id, { tab: 'notifications', saved: true });
}));

// ---- My rules (personal, admin-independent notification rules) ----

router.post('/notifications/rules', asyncHandler(async (req, res) => {
  const { name, trigger_type: triggerType } = req.body;
  if (!name || !TRIGGER_TYPES.some((t) => t.key === triggerType)) {
    return renderPage(res, req.user.id, { tab: 'notifications', error: 'Rule name and a valid trigger type are both required.' });
  }
  if (triggerType === 'monitor_threshold' && (!req.body.monitor_id || !req.body.threshold_value)) {
    return renderPage(res, req.user.id, { tab: 'notifications', error: 'A monitor threshold rule needs a monitor and a value.' });
  }

  const config = buildRuleConfig(triggerType, req.body);
  // db.transaction()'s tx doesn't expose insertReturningId directly (it's a top-level facade
  // helper) — the insert + read-back-the-id + subscribe both happen against the SAME tx connection
  // instead, using .run()'s own lastInsertRowid, exactly like every other in-transaction insert.
  await db.transaction(async (tx) => {
    const result = await tx.prepare(
      'INSERT INTO notification_rules (trigger_type, name, enabled, config, last_state, created_at, owner_user_id) VALUES (?, ?, 1, ?, \'{}\', ?, ?)'
    ).run(triggerType, name.trim(), JSON.stringify(config), new Date().toISOString(), req.user.id);
    // Auto-subscribed to their own new rule — reuses the exact same delivery path an admin-wide
    // rule's own subscription would (see fireRule in notifications.js), rather than this needing a
    // second "personal rule's own channel" concept of its own.
    await tx.prepare('INSERT INTO notification_rule_subscribers (rule_id, user_id) VALUES (?, ?)').run(result.lastInsertRowid, req.user.id);
  });

  await renderPage(res, req.user.id, { tab: 'notifications', saved: true });
}));

router.post('/notifications/rules/:id/update', asyncHandler(async (req, res) => {
  const owned = await db.prepare('SELECT id FROM notification_rules WHERE id = ? AND owner_user_id = ?').get(req.params.id, req.user.id);
  if (!owned) return renderPage(res, req.user.id, { tab: 'notifications', error: 'Rule not found.' });

  const { name, trigger_type: triggerType, enabled } = req.body;
  if (!name || !TRIGGER_TYPES.some((t) => t.key === triggerType)) {
    return renderPage(res, req.user.id, { tab: 'notifications', error: 'Rule name and a valid trigger type are both required.' });
  }

  const config = buildRuleConfig(triggerType, req.body);
  // Same last_state reset as the admin form's own update route, and for the same reason — a
  // changed trigger_type/config has nothing meaningful left to compare a stale "was it breached"
  // flag against.
  await db.prepare('UPDATE notification_rules SET trigger_type = ?, name = ?, enabled = ?, config = ?, last_state = \'{}\' WHERE id = ? AND owner_user_id = ?')
    .run(triggerType, name.trim(), enabled ? 1 : 0, JSON.stringify(config), req.params.id, req.user.id);

  await renderPage(res, req.user.id, { tab: 'notifications', saved: true });
}));

router.post('/notifications/rules/:id/delete', asyncHandler(async (req, res) => {
  const owned = await db.prepare('SELECT id FROM notification_rules WHERE id = ? AND owner_user_id = ?').get(req.params.id, req.user.id);
  if (!owned) return renderPage(res, req.user.id, { tab: 'notifications', error: 'Rule not found.' });

  // No PRAGMA foreign_keys enforcement in this DB (see db.js) — cleaned up explicitly. A personal
  // rule is never linked into notification_rule_channels (that form is admin-channel-only, see
  // admin-notifications.ejs), so only its own subscriber row (the auto-subscription from creation)
  // needs clearing alongside the rule itself.
  await db.prepare('DELETE FROM notification_rule_subscribers WHERE rule_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM notification_rules WHERE id = ? AND owner_user_id = ?').run(req.params.id, req.user.id);

  await renderPage(res, req.user.id, { tab: 'notifications', saved: true });
}));

module.exports = router;
