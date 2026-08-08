const express = require('express');
const db = require('../db');
const {
  TRIGGER_TYPES, sendTestMessage, sendTemplateTestMessage, getNotificationTemplates, saveNotificationTemplates, TEMPLATE_PREVIEW_SAMPLES,
} = require('../notifications');
const { logSystemEvent } = require('../auditLog');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

async function listChannels() {
  return db.prepare('SELECT * FROM notification_channels ORDER BY name').all();
}

// Admin-wide rules only — a user's own personal rule (owner_user_id set, see
// migrateNotificationRulesOwner in db.js) is managed entirely from their own Profile page instead
// (routes/profile.js), not shown or editable here.
async function listRules() {
  const rules = await db.prepare('SELECT * FROM notification_rules WHERE owner_user_id IS NULL ORDER BY name').all();
  const channelStmt = db.prepare(`
    SELECT nc.id, nc.name FROM notification_channels nc
    JOIN notification_rule_channels nrc ON nrc.channel_id = nc.id
    WHERE nrc.rule_id = ? ORDER BY nc.name
  `);
  return Promise.all(rules.map(async (rule) => ({
    ...rule,
    config: JSON.parse(rule.config || '{}'),
    channels: await channelStmt.all(rule.id),
    channelIds: (await channelStmt.all(rule.id)).map((c) => c.id),
  })));
}

async function renderPage(res, extra = {}) {
  res.render('admin-notifications', {
    channels: await listChannels(),
    rules: await listRules(),
    triggerTypes: TRIGGER_TYPES,
    monitors: await db.prepare('SELECT id, label FROM monitors ORDER BY label').all(),
    miniservers: await db.prepare('SELECT id, name FROM miniservers ORDER BY sort_order, id').all(),
    templates: await getNotificationTemplates(),
    templatePreviewSamples: TEMPLATE_PREVIEW_SAMPLES,
    error: null,
    testResult: null,
    templateTestResult: null,
    presetTrigger: '',
    ...extra,
  });
}

// ?trigger_type=battery_weak (see hardware.ejs's own link) pre-selects that trigger and opens the
// "Add rule" panel straight away — otherwise landing here means guessing which of the trigger
// dropdown's many options is the right one before you can even see its fields.
router.get('/', asyncHandler(async (req, res) => {
  const presetTrigger = TRIGGER_TYPES.some((t) => t.key === req.query.trigger_type) ? req.query.trigger_type : '';
  await renderPage(res, { presetTrigger });
}));

// ---- Channels ----

router.post('/channels', asyncHandler(async (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) return renderPage(res, { error: 'Channel name and Apprise URL are both required.' });
  await db.prepare('INSERT INTO notification_channels (name, url, enabled, created_at) VALUES (?, ?, 1, ?)')
    .run(name.trim(), url.trim(), new Date().toISOString());
  await logSystemEvent(`"${req.user.username}" added notification channel "${name}".`);
  res.redirect('/admin/notifications');
}));

router.post('/channels/:id/update', asyncHandler(async (req, res) => {
  const { name, url, enabled } = req.body;
  if (!name || !url) return renderPage(res, { error: 'Channel name and Apprise URL are both required.' });
  await db.prepare('UPDATE notification_channels SET name = ?, url = ?, enabled = ? WHERE id = ?')
    .run(name.trim(), url.trim(), enabled ? 1 : 0, req.params.id);
  res.redirect('/admin/notifications');
}));

router.post('/channels/:id/delete', asyncHandler(async (req, res) => {
  const channel = await db.prepare('SELECT name FROM notification_channels WHERE id = ?').get(req.params.id);
  // No PRAGMA foreign_keys enforcement in this DB (see db.js) — the join rows have to be cleaned
  // up explicitly rather than relying on the schema's own ON DELETE CASCADE to do it.
  await db.prepare('DELETE FROM notification_rule_channels WHERE channel_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM notification_channels WHERE id = ?').run(req.params.id);
  if (channel) await logSystemEvent(`"${req.user.username}" deleted notification channel "${channel.name}".`);
  res.redirect('/admin/notifications');
}));

router.post('/channels/:id/test', asyncHandler(async (req, res) => {
  const channel = await db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(req.params.id);
  if (!channel) return renderPage(res, { error: 'Channel not found.' });
  try {
    await sendTestMessage(channel);
    await renderPage(res, { testResult: { channelId: channel.id, ok: true } });
  } catch (err) {
    await renderPage(res, { testResult: { channelId: channel.id, ok: false, error: err.message } });
  }
}));

// ---- Rules ----

// Only the three device/hardware-level trigger types (battery_weak, device_firmware_changed,
// device_offline) expose a configurable severity — the older trigger types each already had their
// own fixed, previously-uncontested severity baked into notifications.js, and retrofitting a
// selector onto all of them wasn't asked for.
const SEVERITIES = ['info', 'warning', 'critical'];

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
    case 'gateway_client_firmware_mismatch':
      return {
        miniserver_id: body.gateway_mismatch_miniserver_id ? Number(body.gateway_mismatch_miniserver_id) : null,
        severity: SEVERITIES.includes(body.gateway_mismatch_severity) ? body.gateway_mismatch_severity : 'warning',
      };
    case 'mqtt_client_status':
      return { username: (body.mqtt_username || '').trim() || null };
    case 'battery_weak':
      return {
        miniserver_id: body.battery_miniserver_id ? Number(body.battery_miniserver_id) : null,
        severity: SEVERITIES.includes(body.battery_severity) ? body.battery_severity : 'warning',
      };
    case 'device_firmware_changed':
      return {
        miniserver_id: body.device_firmware_miniserver_id ? Number(body.device_firmware_miniserver_id) : null,
        severity: SEVERITIES.includes(body.device_firmware_severity) ? body.device_firmware_severity : 'info',
      };
    case 'device_offline':
      return {
        miniserver_id: body.device_offline_miniserver_id ? Number(body.device_offline_miniserver_id) : null,
        severity: SEVERITIES.includes(body.device_offline_severity) ? body.device_offline_severity : 'warning',
      };
    case 'backup_failed':
    default:
      return {};
  }
}

// Backs the Hardware page's own compact enable/disable toggle buttons (hardware.ejs, in its table
// toolbar) for the 3 device-level hardware rule types. First click ever creates the rule (enabled,
// "Any Miniserver", an established default severity — channels/severity/scoping are still one edit
// away on this page); every click after that just flips enabled on/off, same as the toggle switch
// in the full rule editor's own "Enabled" field. Operates on whichever rule of that trigger_type
// has the lowest id if more than one somehow exists (e.g. a second one hand-created and re-scoped
// to a specific Miniserver) — this button is a convenience for the common single-rule case, not a
// replacement for the full editor.
const HARDWARE_QUICK_RULES = [
  { triggerType: 'battery_weak', name: 'Battery weak', severity: 'warning' },
  { triggerType: 'device_firmware_changed', name: 'Device firmware changed', severity: 'info' },
  { triggerType: 'device_offline', name: 'Device online/offline', severity: 'warning' },
];

router.post('/rules/toggle-hardware', asyncHandler(async (req, res) => {
  const info = HARDWARE_QUICK_RULES.find((r) => r.triggerType === req.body.trigger_type);
  if (!info) return res.redirect(req.body.return_to === 'hardware' ? '/hardware' : '/admin/notifications');

  const existing = await db.prepare('SELECT id, enabled FROM notification_rules WHERE trigger_type = ? ORDER BY id LIMIT 1').get(info.triggerType);
  if (!existing) {
    await db.prepare('INSERT INTO notification_rules (trigger_type, name, enabled, config, last_state, created_at) VALUES (?, ?, 1, ?, \'{}\', ?)')
      .run(info.triggerType, info.name, JSON.stringify({ miniserver_id: null, severity: info.severity }), new Date().toISOString());
    await logSystemEvent(`"${req.user.username}" quick-enabled notification rule "${info.name}".`);
  } else {
    const newEnabled = existing.enabled ? 0 : 1;
    await db.prepare('UPDATE notification_rules SET enabled = ? WHERE id = ?').run(newEnabled, existing.id);
    await logSystemEvent(`"${req.user.username}" ${newEnabled ? 're-enabled' : 'disabled'} notification rule "${info.name}".`);
  }

  res.redirect(req.body.return_to === 'hardware' ? '/hardware' : '/admin/notifications');
}));

router.post('/rules', asyncHandler(async (req, res) => {
  const { name, trigger_type: triggerType, channel_ids: channelIds } = req.body;
  if (!name || !TRIGGER_TYPES.some((t) => t.key === triggerType)) {
    return renderPage(res, { error: 'Rule name and a valid trigger type are both required.' });
  }
  if (triggerType === 'monitor_threshold' && (!req.body.monitor_id || !req.body.threshold_value)) {
    return renderPage(res, { error: 'A monitor threshold rule needs a monitor and a value.' });
  }

  const config = buildRuleConfig(triggerType, req.body);
  const ruleId = await db.insertReturningId(
    'INSERT INTO notification_rules (trigger_type, name, enabled, config, last_state, created_at) VALUES (?, ?, 1, ?, \'{}\', ?)',
    [triggerType, name.trim(), JSON.stringify(config), new Date().toISOString()]
  );

  const ids = [].concat(channelIds || []).map(Number).filter(Boolean);
  for (const channelId of ids) {
    await db.insertIgnore('notification_rule_channels', { rule_id: ruleId, channel_id: channelId }, ['rule_id', 'channel_id']);
  }

  await logSystemEvent(`"${req.user.username}" added notification rule "${name}".`);
  res.redirect('/admin/notifications');
}));

router.post('/rules/:id/update', asyncHandler(async (req, res) => {
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
  await db.prepare('UPDATE notification_rules SET trigger_type = ?, name = ?, enabled = ?, config = ?, last_state = \'{}\' WHERE id = ? AND owner_user_id IS NULL')
    .run(triggerType, name.trim(), enabled ? 1 : 0, JSON.stringify(config), req.params.id);

  await db.prepare('DELETE FROM notification_rule_channels WHERE rule_id = ?').run(req.params.id);
  const ids = [].concat(channelIds || []).map(Number).filter(Boolean);
  for (const channelId of ids) {
    await db.insertIgnore('notification_rule_channels', { rule_id: req.params.id, channel_id: channelId }, ['rule_id', 'channel_id']);
  }

  res.redirect('/admin/notifications');
}));

router.post('/rules/:id/delete', asyncHandler(async (req, res) => {
  const rule = await db.prepare('SELECT name FROM notification_rules WHERE id = ? AND owner_user_id IS NULL').get(req.params.id);
  if (!rule) return res.redirect('/admin/notifications'); // no such admin-wide rule (already gone, or it's someone's personal one)
  await db.prepare('DELETE FROM notification_rule_channels WHERE rule_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM notification_rule_subscribers WHERE rule_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM notification_rules WHERE id = ?').run(req.params.id);
  if (rule) await logSystemEvent(`"${req.user.username}" deleted notification rule "${rule.name}".`);
  res.redirect('/admin/notifications');
}));

// ---- Message templates ----

// One shared form covering every trigger type at once (template_title_<key>/template_body_<key>)
// rather than a save button per type — simpler than 9 separate forms/routes for what's still one
// conceptual "Message templates" setting. A blank pair for a given type clears its override, back
// to that type's own hardcoded default (see notifications.js's applyTemplate).
router.post('/templates', asyncHandler(async (req, res) => {
  const templates = {};
  TRIGGER_TYPES.forEach((t) => {
    const title = (req.body[`template_title_${t.key}`] || '').trim();
    const body = (req.body[`template_body_${t.key}`] || '').trim();
    if (title || body) templates[t.key] = { title: title || null, body: body || null };
  });
  await saveNotificationTemplates(templates);
  await logSystemEvent(`"${req.user.username}" updated notification message templates.`);
  res.redirect('/admin/notifications');
}));

// JSON in, JSON out — the "Send test" control below each template lives inside the templates
// card's own big <form> (Save templates), so it can't be a real nested <form> of its own (invalid
// HTML, unreliable which one actually submits). A plain fetch() from admin-notifications.ejs's own
// script instead, updating just that one template's own result line in place rather than a full
// page reload/re-render.
router.post('/templates/:key/test', asyncHandler(async (req, res) => {
  const triggerType = req.params.key;
  if (!TRIGGER_TYPES.some((t) => t.key === triggerType)) return res.status(400).json({ ok: false, error: 'Unknown trigger type.' });
  const channel = await db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(req.body.channel_id);
  if (!channel) return res.status(400).json({ ok: false, error: 'Choose a channel to send the test to.' });
  try {
    await sendTemplateTestMessage(channel, triggerType);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}));

module.exports = router;
// Reused by routes/profile.js for the "My rules" personal-rule form — same trigger-type-to-config
// shape regardless of who's creating the rule, no reason for a second copy to maintain in sync.
module.exports.buildRuleConfig = buildRuleConfig;
