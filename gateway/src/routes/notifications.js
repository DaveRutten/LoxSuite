const express = require('express');
const db = require('../db');
const { TRIGGER_TYPES, sendTestMessage } = require('../notifications');
const { logSystemEvent } = require('../auditLog');

const router = express.Router();

function listChannels() {
  return db.prepare('SELECT * FROM notification_channels ORDER BY name').all();
}

// Admin-wide rules only — a user's own personal rule (owner_user_id set, see
// migrateNotificationRulesOwner in db.js) is managed entirely from their own Profile page instead
// (routes/profile.js), not shown or editable here.
function listRules() {
  const rules = db.prepare('SELECT * FROM notification_rules WHERE owner_user_id IS NULL ORDER BY name').all();
  const channelStmt = db.prepare(`
    SELECT nc.id, nc.name FROM notification_channels nc
    JOIN notification_rule_channels nrc ON nrc.channel_id = nc.id
    WHERE nrc.rule_id = ? ORDER BY nc.name
  `);
  return rules.map((rule) => ({
    ...rule,
    config: JSON.parse(rule.config || '{}'),
    channels: channelStmt.all(rule.id),
    channelIds: channelStmt.all(rule.id).map((c) => c.id),
  }));
}

async function renderPage(res, extra = {}) {
  res.render('admin-notifications', {
    channels: listChannels(),
    rules: listRules(),
    triggerTypes: TRIGGER_TYPES,
    monitors: db.prepare('SELECT id, label FROM monitors ORDER BY label').all(),
    miniservers: db.prepare('SELECT id, name FROM miniservers ORDER BY name').all(),
    error: null,
    testResult: null,
    ...extra,
  });
}

router.get('/', (req, res) => renderPage(res));

// ---- Channels ----

router.post('/channels', (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) return renderPage(res, { error: 'Channel name and Apprise URL are both required.' });
  db.prepare('INSERT INTO notification_channels (name, url, enabled, created_at) VALUES (?, ?, 1, ?)')
    .run(name.trim(), url.trim(), new Date().toISOString());
  logSystemEvent(`"${req.user.username}" added notification channel "${name}".`);
  res.redirect('/admin/notifications');
});

router.post('/channels/:id/update', (req, res) => {
  const { name, url, enabled } = req.body;
  if (!name || !url) return renderPage(res, { error: 'Channel name and Apprise URL are both required.' });
  db.prepare('UPDATE notification_channels SET name = ?, url = ?, enabled = ? WHERE id = ?')
    .run(name.trim(), url.trim(), enabled ? 1 : 0, req.params.id);
  res.redirect('/admin/notifications');
});

router.post('/channels/:id/delete', (req, res) => {
  const channel = db.prepare('SELECT name FROM notification_channels WHERE id = ?').get(req.params.id);
  // No PRAGMA foreign_keys enforcement in this DB (see db.js) — the join rows have to be cleaned
  // up explicitly rather than relying on the schema's own ON DELETE CASCADE to do it.
  db.prepare('DELETE FROM notification_rule_channels WHERE channel_id = ?').run(req.params.id);
  db.prepare('DELETE FROM notification_channels WHERE id = ?').run(req.params.id);
  if (channel) logSystemEvent(`"${req.user.username}" deleted notification channel "${channel.name}".`);
  res.redirect('/admin/notifications');
});

router.post('/channels/:id/test', async (req, res) => {
  const channel = db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(req.params.id);
  if (!channel) return renderPage(res, { error: 'Channel not found.' });
  try {
    await sendTestMessage(channel);
    renderPage(res, { testResult: { channelId: channel.id, ok: true } });
  } catch (err) {
    renderPage(res, { testResult: { channelId: channel.id, ok: false, error: err.message } });
  }
});

// ---- Rules ----

// Builds the trigger-specific config blob from whatever subset of fields that trigger type
// actually uses — the form sends all of them at once (see admin-notifications.ejs's per-type field
// groups, toggled client-side), so only the relevant ones are picked out here per trigger_type.
function buildRuleConfig(triggerType, body) {
  switch (triggerType) {
    case 'monitor_threshold':
      return {
        monitor_id: Number(body.monitor_id) || null,
        operator: body.operator || 'gt',
        value: Number(body.threshold_value),
        notify_on_recover: !!body.notify_on_recover,
      };
    case 'miniserver_status':
      return { miniserver_id: body.miniserver_id ? Number(body.miniserver_id) : null };
    // Its own field name, not a shared "miniserver_id" with the case above — the HTML `hidden`
    // attribute the trigger-type toggle script uses (see admin-notifications.ejs) only affects
    // rendering, not form submission, so a same-named <select> in both (visually hidden) field
    // groups would still both submit and collide on which one "wins" in req.body.
    case 'firmware_changed':
      return { miniserver_id: body.firmware_miniserver_id ? Number(body.firmware_miniserver_id) : null };
    case 'mqtt_client_status':
      return { username: (body.mqtt_username || '').trim() || null };
    case 'backup_failed':
    default:
      return {};
  }
}

router.post('/rules', (req, res) => {
  const { name, trigger_type: triggerType, channel_ids: channelIds } = req.body;
  if (!name || !TRIGGER_TYPES.some((t) => t.key === triggerType)) {
    return renderPage(res, { error: 'Rule name and a valid trigger type are both required.' });
  }
  if (triggerType === 'monitor_threshold' && (!req.body.monitor_id || !req.body.threshold_value)) {
    return renderPage(res, { error: 'A monitor threshold rule needs a monitor and a value.' });
  }

  const config = buildRuleConfig(triggerType, req.body);
  const result = db.prepare('INSERT INTO notification_rules (trigger_type, name, enabled, config, last_state, created_at) VALUES (?, ?, 1, ?, \'{}\', ?)')
    .run(triggerType, name.trim(), JSON.stringify(config), new Date().toISOString());

  const ids = [].concat(channelIds || []).map(Number).filter(Boolean);
  const insertLink = db.prepare('INSERT OR IGNORE INTO notification_rule_channels (rule_id, channel_id) VALUES (?, ?)');
  for (const channelId of ids) insertLink.run(result.lastInsertRowid, channelId);

  logSystemEvent(`"${req.user.username}" added notification rule "${name}".`);
  res.redirect('/admin/notifications');
});

router.post('/rules/:id/update', (req, res) => {
  const { name, trigger_type: triggerType, enabled, channel_ids: channelIds } = req.body;
  if (!name || !TRIGGER_TYPES.some((t) => t.key === triggerType)) {
    return renderPage(res, { error: 'Rule name and a valid trigger type are both required.' });
  }

  const config = buildRuleConfig(triggerType, req.body);
  // A changed trigger_type or config invalidates whatever last_state was tracking (e.g. a
  // threshold rule repointed at a different monitor has nothing meaningful to compare its old
  // "was it breached" flag against) — reset it so the next reading starts clean instead of
  // possibly firing (or wrongly staying silent) based on stale state from a different rule shape.
  // AND owner_user_id IS NULL — this form only ever has admin-wide rules to pick from (see
  // listRules), so a stale/tampered id pointing at someone's personal rule just no-ops here
  // instead of an admin's own form silently touching it.
  db.prepare('UPDATE notification_rules SET trigger_type = ?, name = ?, enabled = ?, config = ?, last_state = \'{}\' WHERE id = ? AND owner_user_id IS NULL')
    .run(triggerType, name.trim(), enabled ? 1 : 0, JSON.stringify(config), req.params.id);

  db.prepare('DELETE FROM notification_rule_channels WHERE rule_id = ?').run(req.params.id);
  const ids = [].concat(channelIds || []).map(Number).filter(Boolean);
  const insertLink = db.prepare('INSERT OR IGNORE INTO notification_rule_channels (rule_id, channel_id) VALUES (?, ?)');
  for (const channelId of ids) insertLink.run(req.params.id, channelId);

  res.redirect('/admin/notifications');
});

router.post('/rules/:id/delete', (req, res) => {
  const rule = db.prepare('SELECT name FROM notification_rules WHERE id = ? AND owner_user_id IS NULL').get(req.params.id);
  if (!rule) return res.redirect('/admin/notifications'); // no such admin-wide rule (already gone, or it's someone's personal one)
  db.prepare('DELETE FROM notification_rule_channels WHERE rule_id = ?').run(req.params.id);
  db.prepare('DELETE FROM notification_rule_subscribers WHERE rule_id = ?').run(req.params.id);
  db.prepare('DELETE FROM notification_rules WHERE id = ?').run(req.params.id);
  if (rule) logSystemEvent(`"${req.user.username}" deleted notification rule "${rule.name}".`);
  res.redirect('/admin/notifications');
});

module.exports = router;
// Reused by routes/profile.js for the "My rules" personal-rule form — same trigger-type-to-config
// shape regardless of who's creating the rule, no reason for a second copy to maintain in sync.
module.exports.buildRuleConfig = buildRuleConfig;
