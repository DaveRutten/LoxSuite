const { execFile } = require('child_process');
const db = require('./db');
const { logSystemEvent } = require('./auditLog');
const { matchedRung } = require('./thresholdLadder');
const { formatDateTime } = require('./dateFormat');

// The five trigger types selectable when creating a rule — kept here since routes/notifications.js
// and this file are the only two places that need the list.
const TRIGGER_TYPES = [
  { key: 'monitor_threshold', label: 'Monitor threshold breached' },
  { key: 'miniserver_status', label: 'Miniserver online/offline' },
  { key: 'mqtt_client_status', label: 'MQTT client online/offline' },
  { key: 'backup_failed', label: 'Backup failed' },
  { key: 'firmware_changed', label: 'Miniserver firmware changed' },
  { key: 'gateway_client_firmware_mismatch', label: 'Gateway/Client firmware mismatch' },
  { key: 'loxsuite_update_available', label: 'LoxSuite update available' },
  { key: 'battery_weak', label: 'Loxone device battery weak' },
  { key: 'device_firmware_changed', label: 'Loxone device firmware changed' },
  { key: 'device_offline', label: 'Loxone device online/offline' },
];

// Sending goes through Apprise (https://github.com/caronc/apprise, installed as a CLI in the
// Docker image — see Dockerfile) rather than hand-rolled Teams/Slack/Telegram/SMTP integrations
// of our own: one battle-tested tool that already speaks 100+ services' own APIs correctly
// (retries, rate limits, the right payload shape per service), the same "shell out to the one
// established tool for this" choice already made for offsite backup copies (see backup.js's
// uploadToRclone / rclone). A channel is just a name plus one Apprise URL — e.g.
// `msteams://TokenA/TokenB/TokenC/`, `slack://TokenA/TokenB/TokenC/Channel`,
// `tgram://bottoken/ChatID`, `mailtos://user:pass@smtp.example.com?to=you@example.com` — built by
// following Apprise's own docs for the target service, not something this app tries to construct
// from separate host/token/etc. fields itself.
// -v is required for apprise to actually explain a failure at all — quiet by default, it exits 1
// on a failed send with completely empty stdout/stderr, which would otherwise leave every error
// this app ever surfaces (the admin page's "Send test", a rule's own failure logged via
// logSystemEvent) as a useless generic "Command failed: apprise ...".
function runApprise(url, title, body, notifyType, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile('apprise', ['-t', title, '-b', body, '-n', notifyType, '-v', url], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        // apprise's own -v logging actually writes to stdout (confirmed by testing — despite most
        // CLI conventions putting diagnostic/log output on stderr), so that's checked first here;
        // stderr is still passed as a fallback in case a future apprise version changes that.
        reject(new Error(extractAppriseError(stdout) || extractAppriseError(stderr) || err.message || 'apprise failed'));
        return;
      }
      resolve();
    });
  });
}

// apprise -v logs each line as "<timestamp> - <LEVEL> - <message>" — strips that down to just the
// message, and to just the last WARNING/ERROR line specifically (earlier INFO lines are just
// "loading this plugin"/"querying that URL" noise, not the actual reason it failed).
function extractAppriseError(output) {
  const lines = (output || '').toString().trim().split('\n').filter(Boolean);
  const relevant = lines.filter((l) => / - (WARNING|ERROR) - /.test(l));
  const line = relevant[relevant.length - 1] || lines[lines.length - 1];
  if (!line) return null;
  const match = line.match(/ - (?:WARNING|ERROR) - (.*)$/);
  return match ? match[1] : line;
}

function apLevel(severity) {
  // Apprise's own -n values — most services map these to a color/icon/prefix on their end.
  return severity === 'critical' ? 'failure' : severity === 'warning' ? 'warning' : 'info';
}

function renderBody(event) {
  if (!event.fields || event.fields.length === 0) return event.message;
  return `${event.message}\n\n${event.fields.map((f) => `${f.label}: ${f.value}`).join('\n')}`;
}

// One optional {title, body} override per trigger_type (see db.js's migrateNotificationTemplatesSetting
// and admin-notifications.ejs's own "Message templates" card) — {{title}}/{{message}}/{{severity}}
// plus every one of this event's own fields[].label are available as {{placeholders}}, substituted
// against the SAME event data every check* function already builds below, so a custom template
// never needs its own separate variable-gathering step.
async function getNotificationTemplates() {
  const row = await db.prepare('SELECT notification_templates FROM gateway_settings WHERE id = 1').get();
  try {
    const parsed = JSON.parse((row && row.notification_templates) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

async function saveNotificationTemplates(templates) {
  await db.prepare('UPDATE gateway_settings SET notification_templates = ? WHERE id = 1').run(JSON.stringify(templates));
}

// Exported separately from getNotificationTemplates/applyTemplate so the admin page's own live
// preview (client-side) and this real send path substitute the exact same placeholders the exact
// same way — one JS implementation, not a second one re-typed into the view for the preview box.
function substituteTemplate(text, context) {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(context, key) ? String(context[key]) : whole
  ));
}

// Sample event data per trigger type, used ONLY for the admin page's own template preview (never
// actually sent anywhere) — mirrors exactly what each check*/fireRule call site below builds for a
// REAL event, so the preview's available {{placeholders}} always match what a real notification
// would actually have to substitute.
const TEMPLATE_PREVIEW_SAMPLES = {
  monitor_threshold: {
    title: 'Living room temp: threshold breached',
    message: 'Living room temp is now > 25 (current: 26.4).',
    severity: 'warning',
    fields: [{ label: 'Monitor', value: 'Living room temp' }, { label: 'Current value', value: 26.4 }, { label: 'Threshold', value: '> 25' }],
  },
  miniserver_status: {
    title: 'Miniserver Villa: offline',
    message: 'Miniserver "Miniserver Villa" (192.168.1.10) is now offline.',
    severity: 'critical',
    fields: [{ label: 'Miniserver', value: 'Miniserver Villa' }, { label: 'Host', value: '192.168.1.10' }, { label: 'Status', value: 'offline' }],
  },
  firmware_changed: {
    title: 'Miniserver Villa: firmware changed',
    message: 'Miniserver "Miniserver Villa" firmware changed from 15.2.3.1 to 15.3.1.2.',
    severity: 'info',
    fields: [{ label: 'Miniserver', value: 'Miniserver Villa' }, { label: 'Previous version', value: '15.2.3.1' }, { label: 'New version', value: '15.3.1.2' }],
  },
  gateway_client_firmware_mismatch: {
    title: 'Gateway/Client: firmware mismatch',
    message: 'Gateway "Miniserver Villa" is running 15.3.1.2, Client "Pool House" is running 15.2.3.1 — both are online and running, but their firmware doesn\'t match.',
    severity: 'warning',
    fields: [{ label: 'Gateway', value: 'Miniserver Villa (15.3.1.2)' }, { label: 'Client', value: 'Pool House (15.2.3.1)' }],
  },
  loxsuite_update_available: {
    title: 'LoxSuite v0.11.0 available',
    message: 'A newer LoxSuite release (v0.11.0) is available on GitHub — currently running v0.10.1-alpha.1.',
    severity: 'info',
    fields: [{ label: 'Running version', value: 'v0.10.1-alpha.1' }, { label: 'Latest version', value: 'v0.11.0' }],
  },
  mqtt_client_status: {
    title: 'shelly-plug-1: disconnected',
    message: 'MQTT client "shelly-plug-1" is now disconnected.',
    severity: 'warning',
    fields: [{ label: 'Client', value: 'shelly-plug-1' }, { label: 'Status', value: 'disconnected' }],
  },
  backup_failed: {
    title: 'Backup failed',
    message: 'rclone exited with code 1: connection refused.',
    severity: 'critical',
    fields: [{ label: 'Step', value: 'offsite copy' }],
  },
  battery_weak: {
    title: 'Hallway motion sensor: battery weak',
    message: '"Hallway motion sensor" on "Miniserver Villa" reports a weak battery (18%).',
    severity: 'warning',
    fields: [
      { label: 'Device', value: 'Hallway motion sensor' }, { label: 'Miniserver', value: 'Miniserver Villa' },
      { label: 'Battery', value: '18%' }, { label: 'Too weak to update', value: 'No' },
    ],
  },
  device_firmware_changed: {
    title: 'Kitchen Shelly: firmware changed',
    message: '"Kitchen Shelly" on "Miniserver Villa" firmware changed from 1.2.0 to 1.3.0.',
    severity: 'info',
    fields: [
      { label: 'Device', value: 'Kitchen Shelly' }, { label: 'Miniserver', value: 'Miniserver Villa' },
      { label: 'Previous version', value: '1.2.0' }, { label: 'New version', value: '1.3.0' },
    ],
  },
  device_offline: {
    title: 'Garden sensor: offline',
    message: '"Garden sensor" on "Miniserver Villa" is now offline.',
    severity: 'warning',
    fields: [{ label: 'Device', value: 'Garden sensor' }, { label: 'Miniserver', value: 'Miniserver Villa' }, { label: 'Status', value: 'offline' }],
  },
};

async function applyTemplate(event, triggerType) {
  const tpl = (await getNotificationTemplates())[triggerType];
  if (!tpl || (!tpl.title && !tpl.body)) return event;
  const context = { title: event.title, message: event.message, severity: event.severity };
  (event.fields || []).forEach((f) => { context[f.label] = f.value; });
  return {
    ...event,
    title: tpl.title ? substituteTemplate(tpl.title, context) : event.title,
    // A custom body fully replaces the auto-appended field list below it (renderBody) — the
    // template itself is expected to reference whichever fields it cares about by name instead.
    message: tpl.body ? substituteTemplate(tpl.body, context) : event.message,
    fields: tpl.body ? [] : event.fields,
  };
}

const TELEGRAM_SEVERITY_EMOJI = { critical: '\u{1F534}', warning: '\u{1F7E0}', info: 'ℹ️' };

function isTelegramUrl(url) {
  return /^tgram:\/\//i.test(url || '');
}

// Apprise's Telegram plugin renders the message as Markdown once the URL says so (see
// ensureTelegramMarkdown below) — legacy Markdown (mdv=v1), not the v2 default, since v1 only
// treats `_*\`[` as special, so real content (a monitor label, a raw value) needs far less
// escaping to stay safe than v2's much longer reserved-character list would require.
function escapeTelegramMarkdown(text) {
  return String(text).replace(/([_*`[])/g, '\\$1');
}

function renderTelegramTitle(event) {
  const emoji = TELEGRAM_SEVERITY_EMOJI[event.severity] || TELEGRAM_SEVERITY_EMOJI.info;
  return `${emoji} *${escapeTelegramMarkdown(event.title)}*`;
}

function renderTelegramBody(event) {
  const message = escapeTelegramMarkdown(event.message);
  if (!event.fields || event.fields.length === 0) return message;
  const fieldLines = event.fields.map((f) => `_${escapeTelegramMarkdown(f.label)}:_ ${escapeTelegramMarkdown(f.value)}`).join('\n');
  return `${message}\n\n${fieldLines}`;
}

// Applied at send time (not just when a channel is first saved) so an already-configured Telegram
// channel gets the nicer formatting immediately too, without needing to re-save it — appends
// rather than replaces so a URL someone already hand-edited with its own format= keeps that choice.
function ensureTelegramMarkdown(url) {
  if (/[?&]format=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'format=markdown&mdv=v1';
}

async function sendToChannel(channel, event) {
  if (!channel.url) throw new Error('This channel has no Apprise URL configured.');
  const telegram = isTelegramUrl(channel.url);
  const url = telegram ? ensureTelegramMarkdown(channel.url) : channel.url;
  const title = telegram ? renderTelegramTitle(event) : event.title;
  const body = telegram ? renderTelegramBody(event) : renderBody(event);
  await runApprise(url, title, body, apLevel(event.severity));
}

// Exercised directly by the Notifications admin page's own "Send test" button per channel — same
// send path a real rule uses, just with a canned event, so a successful test is a genuine
// end-to-end proof the URL actually works rather than just "it looks like a URL".
async function sendTestMessage(channel) {
  await sendToChannel(channel, {
    title: 'Test notification',
    message: 'This is a test message from LoxSuite — if you can read this, the channel is configured correctly.',
    severity: 'info',
    fields: [{ label: 'Channel', value: channel.name }, { label: 'Sent at', value: formatDateTime(new Date().toISOString()) }],
    timestamp: new Date().toISOString(),
  });
}

// Exercised by the Message templates card's own per-template "Send test" — builds a canned event
// from this trigger type's own TEMPLATE_PREVIEW_SAMPLES entry (the exact same sample data the
// admin page's own live preview renders against), then runs it through the SAVED template
// (applyTemplate) so a real send actually reflects the current title/body override, not just the
// trigger's stock wording — same "genuine end-to-end proof" reasoning as sendTestMessage's own
// per-channel test just above.
async function sendTemplateTestMessage(channel, triggerType) {
  const sample = TEMPLATE_PREVIEW_SAMPLES[triggerType];
  if (!sample) throw new Error('Unknown trigger type.');
  const event = await applyTemplate({
    title: sample.title,
    message: sample.message,
    severity: sample.severity,
    fields: sample.fields,
    timestamp: new Date().toISOString(),
  }, triggerType);
  await sendToChannel(channel, event);
}

// ---- Rule dispatch ----

async function getChannelsForRule(ruleId) {
  return db.prepare(`
    SELECT nc.* FROM notification_channels nc
    JOIN notification_rule_channels nrc ON nrc.channel_id = nc.id
    WHERE nrc.rule_id = ? AND nc.enabled = 1
  `).all(ruleId);
}

// Every user who personally opted into this rule from their own Profile page (see
// notification_rule_subscribers, set by routes/profile.js), and actually has a channel URL of
// their own configured — a subscription with no URL yet has nowhere to send to, so it's silently
// skipped here rather than surfaced as a failure (there's nothing to retry or fix on this end;
// the user just hasn't filled in their channel yet).
async function getSubscriberChannelsForRule(ruleId) {
  return db.prepare(`
    SELECT users.id, users.username, users.notify_url AS url FROM notification_rule_subscribers nrs
    JOIN users ON users.id = nrs.user_id
    WHERE nrs.rule_id = ? AND users.notify_url IS NOT NULL AND users.notify_url != ''
  `).all(ruleId);
}

// One row per logical event (not per channel/subscriber delivery below — a rule with 3 channels
// is still one alert, not three) — the Notification Center's own persisted history, independent of
// whether any channel is even configured or a send succeeds. See db.js's notification_events
// comment for why rule_id carries no REFERENCES/cascade.
async function recordNotificationEvent(event, opts) {
  await db.prepare(
    'INSERT INTO notification_events (event_type, severity, title, message, source_id, source_label, rule_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    opts.eventType,
    event.severity || 'info',
    event.title,
    event.message,
    event.sourceId != null ? event.sourceId : null,
    event.sourceLabel || null,
    opts.ruleId != null ? opts.ruleId : null,
    event.timestamp || new Date().toISOString()
  );
}

async function fireRule(rule, rawEvent) {
  const event = await applyTemplate(rawEvent, rule.trigger_type);
  await recordNotificationEvent(event, { eventType: rule.trigger_type, ruleId: rule.id });

  const channels = await getChannelsForRule(rule.id);
  for (const channel of channels) {
    try {
      await sendToChannel(channel, event);
      await logSystemEvent(`Notification "${rule.name}" sent via "${channel.name}".`);
    } catch (err) {
      await logSystemEvent(`Notification "${rule.name}" via "${channel.name}" failed: ${err.message}`);
    }
  }

  const subscribers = await getSubscriberChannelsForRule(rule.id);
  for (const subscriber of subscribers) {
    try {
      await sendToChannel({ name: `${subscriber.username}'s notifications`, url: subscriber.url }, event);
      await logSystemEvent(`Notification "${rule.name}" sent to "${subscriber.username}".`);
    } catch (err) {
      await logSystemEvent(`Notification "${rule.name}" to "${subscriber.username}" failed: ${err.message}`);
    }
  }
}

async function getRulesByTrigger(triggerType) {
  return db.prepare('SELECT * FROM notification_rules WHERE trigger_type = ? AND enabled = 1').all(triggerType);
}

async function updateRuleState(ruleId, state) {
  await db.prepare('UPDATE notification_rules SET last_state = ? WHERE id = ?').run(JSON.stringify(state), ruleId);
}

function compareThreshold(value, operator, threshold) {
  switch (operator) {
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'eq': return value === threshold;
    default: return false;
  }
}

function operatorLabel(operator) {
  return { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' }[operator] || operator;
}

// Called by monitorCollector.js after every newly-recorded *numeric* reading (by id, not the full
// row — insertHistory() is a hot path shared by every MQTT message and Loxone poll, so the monitor
// itself is only fetched below once a rule actually matches, rather than on every single reading
// regardless of whether any rule cares about it). last_state tracks whether this specific rule was
// already breached so only the ok->breached (and, opt-in, breached->ok) *transition* fires —
// without it, a monitor sitting above its threshold for hours would re-notify on every single
// reading instead of once when it first crossed the line.
async function checkMonitorThreshold(monitorId, numericValue) {
  const allRules = await getRulesByTrigger('monitor_threshold');
  const rules = allRules.filter((rule) => Number(JSON.parse(rule.config || '{}').monitor_id) === monitorId);
  if (rules.length === 0) return;
  const monitor = await db.prepare('SELECT id, label FROM monitors WHERE id = ?').get(monitorId);
  if (!monitor) return;

  for (const rule of rules) {
    const cfg = JSON.parse(rule.config || '{}');
    const state = JSON.parse(rule.last_state || '{}');
    const breached = compareThreshold(numericValue, cfg.operator, Number(cfg.value));
    if (breached === !!state.breached) continue;
    await updateRuleState(rule.id, { breached });

    if (breached) {
      await fireRule(rule, {
        title: `${monitor.label}: threshold breached`,
        message: `${monitor.label} is now ${operatorLabel(cfg.operator)} ${cfg.value} (current: ${numericValue}).`,
        severity: 'warning',
        fields: [
          { label: 'Monitor', value: monitor.label },
          { label: 'Current value', value: numericValue },
          { label: 'Threshold', value: `${operatorLabel(cfg.operator)} ${cfg.value}` },
        ],
        sourceId: monitor.id,
        sourceLabel: monitor.label,
        timestamp: new Date().toISOString(),
      });
    } else if (cfg.notify_on_recover) {
      await fireRule(rule, {
        title: `${monitor.label}: back to normal`,
        message: `${monitor.label} is no longer ${operatorLabel(cfg.operator)} ${cfg.value} (current: ${numericValue}).`,
        severity: 'info',
        fields: [{ label: 'Monitor', value: monitor.label }, { label: 'Current value', value: numericValue }],
        sourceId: monitor.id,
        sourceLabel: monitor.label,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

// A monitor's OWN threshold ladder (monitors.config.thresholds, the Monitor detail page's own
// chart — see thresholdLadder.js) firing a notification when a reading enters a rung marked
// notify:true, entirely separate from the monitor_threshold rule above: no rule to create, no
// channel to pick — the user just checks a box on the threshold row itself, and it lands straight
// in the Notification Center (rule_id NULL below — see db.js's notification_events comment for
// why). Deliberately NOT evaluated against a dashboard panel's own ladder — a monitor can sit on
// several panels each with a different ladder, so there's no single unambiguous one to check
// there; only this page's own ladder is unambiguous.
//
// lastMatchedRung is in-memory only (keyed by monitor id -> last matched rung's numeric *value*,
// not array index — an index would misfire if the ladder itself is reordered/edited) — same
// simplicity/tradeoff as the existing lastAutoReconnectAt Map in monitorCollector.js: resets on a
// process restart, which can cost at most one possibly-redundant or (rarely) missed notification
// right after a restart, not an ongoing correctness issue.
const lastMatchedRung = new Map();
async function checkThresholdLadderNotify(monitorId, numericValue) {
  const monitor = await db.prepare('SELECT id, label, config FROM monitors WHERE id = ?').get(monitorId);
  if (!monitor) return;

  let config;
  try { config = JSON.parse(monitor.config || '{}'); } catch (err) { return; }
  const ladder = config.thresholds;
  if (!ladder || ladder.length === 0) return;

  const rung = matchedRung(numericValue, ladder);
  const rungKey = rung ? rung.value : null;
  const hadPrevious = lastMatchedRung.has(monitorId);
  const previousKey = lastMatchedRung.get(monitorId);
  lastMatchedRung.set(monitorId, rungKey);
  // No baseline to compare against yet (nothing to "transition" from), so the first reading ever
  // seen for a monitor never fires — same reasoning as checkFirmwareChanged's own !miniserver.
  // firmware_version guard just below: without it, `null === undefined` is false, so a monitor
  // that starts out below every rung (rungKey null) would wrongly look like a transition on read 1.
  if (!hadPrevious) return;
  if (rungKey === previousKey) return; // still in the same rung (or still below every rung)
  if (!rung || !rung.notify) return;

  await recordNotificationEvent({
    title: `${monitor.label}: ${rung.value}`,
    message: `${monitor.label} reached ${rung.value} (current: ${numericValue}).`,
    severity: 'warning',
    sourceId: monitor.id,
    sourceLabel: monitor.label,
    timestamp: new Date().toISOString(),
  }, { eventType: 'threshold_ladder', ruleId: null });
}

// Called by healthcheck.js's checkMiniserver whenever a poll's outcome differs from the status
// already on record. A rule left scoped to "any Miniserver" (cfg.miniserver_id unset) still tracks
// each one's last-known status independently — keyed by id in last_state — rather than one shared
// flag that would otherwise misfire ("already notified") the moment a second, unrelated Miniserver
// changes state first.
async function checkMiniserverStatus(miniserver, newStatus) {
  for (const rule of await getRulesByTrigger('miniserver_status')) {
    const cfg = JSON.parse(rule.config || '{}');
    if (cfg.miniserver_id && Number(cfg.miniserver_id) !== miniserver.id) continue;

    const state = JSON.parse(rule.last_state || '{}');
    const key = String(miniserver.id);
    if (state[key] === newStatus) continue;
    await updateRuleState(rule.id, { ...state, [key]: newStatus });

    await fireRule(rule, {
      title: `${miniserver.name}: ${newStatus}`,
      message: `Miniserver "${miniserver.name}" (${miniserver.host}) is now ${newStatus}.`,
      severity: newStatus === 'offline' ? 'critical' : 'info',
      fields: [{ label: 'Miniserver', value: miniserver.name }, { label: 'Host', value: miniserver.host }, { label: 'Status', value: newStatus }],
      sourceId: miniserver.id,
      sourceLabel: miniserver.name,
      timestamp: new Date().toISOString(),
    });
  }
}

// Called by healthcheck.js's checkMiniserver on the SUCCESS path only, right after
// checkMiniserverStatus — comparing the freshly-fetched version string against whatever was
// already on record before this tick's UPDATE overwrites it. Loxone doesn't expose a plain
// update-available flag over HTTP (see the Miniservers page's own "Check for update" button and
// its tooltip explaining exactly this), so this deliberately only detects that the version
// CHANGED, not that a newer one is available — an honest, checkable signal instead of a guess at
// an external release feed this app doesn't talk to. No last_state needed: the version-string
// comparison itself already IS the transition check, no separate persisted flag required.
async function checkFirmwareChanged(miniserver, newVersion) {
  // The !miniserver.firmware_version guard matters — without it, a brand-new Miniserver's very
  // first successful read (previous version genuinely unknown, not "unchanged") would look like a
  // change from nothing and fire a spurious alert.
  if (!newVersion || !miniserver.firmware_version || newVersion === miniserver.firmware_version) return;

  for (const rule of await getRulesByTrigger('firmware_changed')) {
    const cfg = JSON.parse(rule.config || '{}');
    if (cfg.miniserver_id && Number(cfg.miniserver_id) !== miniserver.id) continue;

    await fireRule(rule, {
      title: `${miniserver.name}: firmware changed`,
      message: `Miniserver "${miniserver.name}" firmware changed from ${miniserver.firmware_version} to ${newVersion}.`,
      severity: 'info',
      fields: [
        { label: 'Miniserver', value: miniserver.name },
        { label: 'Previous version', value: miniserver.firmware_version },
        { label: 'New version', value: newVersion },
      ],
      sourceId: miniserver.id,
      sourceLabel: miniserver.name,
      timestamp: new Date().toISOString(),
    });
  }
}

// Called once per healthcheck sweep (see healthcheck.js's checkAllMiniservers), after every
// Miniserver's own row has already been updated with this cycle's fresh status/firmware_version/
// plc_state. A Gateway and its Client Miniservers (see the "Gateway Client setup" section on the
// Miniserver edit page) share one merged Loxone Config project and are expected to run identical
// firmware — a mismatch usually means one side didn't get updated when the other did. Scoped to
// pairs where BOTH sides are confirmed PLC state 5 ("Running", see PLC_STATE_LABELS in
// miniservers.ejs) rather than just "online": a Miniserver mid-boot/mid-update can briefly report
// a stale or blank firmware_version, which would otherwise misfire this the moment either side
// restarts — exactly the situation an update is already in progress for, not a real mismatch to
// alert on. State is tracked per rule (last_state, keyed by Client id) the same way
// checkMiniserverStatus tracks per-Miniserver status above, so a rule scoped to "any Gateway"
// still tracks each Gateway/Client pair's own mismatched/not-mismatched flag independently, and a
// resolved mismatch clears cleanly so a later, genuinely new one can fire again.
async function checkGatewayClientFirmwareMismatch() {
  const rules = await getRulesByTrigger('gateway_client_firmware_mismatch');
  if (rules.length === 0) return;

  const clients = await db.prepare('SELECT * FROM miniservers WHERE gateway_client_of IS NOT NULL').all();
  const selectMiniserver = db.prepare('SELECT * FROM miniservers WHERE id = ?');
  const pairs = (await Promise.all(clients.map(async (client) => ({ client, gateway: await selectMiniserver.get(client.gateway_client_of) }))))
    .filter((pair) => pair.gateway);
  if (pairs.length === 0) return;

  for (const rule of rules) {
    const cfg = JSON.parse(rule.config || '{}');
    const state = JSON.parse(rule.last_state || '{}');
    let stateChanged = false;

    for (const { client, gateway } of pairs) {
      if (cfg.miniserver_id && Number(cfg.miniserver_id) !== gateway.id) continue;

      const bothRunning = gateway.plc_state === '5' && client.plc_state === '5';
      const mismatched = !!(bothRunning && gateway.firmware_version && client.firmware_version
        && gateway.firmware_version !== client.firmware_version);

      const key = String(client.id);
      if (!!state[key] === mismatched) continue; // no transition for this pair
      state[key] = mismatched;
      stateChanged = true;
      if (!mismatched) continue; // silently cleared — no "back in sync" notification

      await fireRule(rule, {
        title: `${gateway.name}/${client.name}: firmware mismatch`,
        message: `Gateway "${gateway.name}" is running ${gateway.firmware_version}, Client "${client.name}" is running ${client.firmware_version} — both are online and running, but their firmware doesn't match.`,
        severity: cfg.severity || 'warning',
        fields: [
          { label: 'Gateway', value: `${gateway.name} (${gateway.firmware_version})` },
          { label: 'Client', value: `${client.name} (${client.firmware_version})` },
        ],
        sourceId: client.id,
        sourceLabel: client.name,
        timestamp: new Date().toISOString(),
      });
    }

    if (stateChanged) await updateRuleState(rule.id, state);
  }
}

// Called by versionCheck.js whenever its own daily GitHub tags check finds a latest tag that
// differs from the version currently running (see that file for why this is a plain string
// inequality, not real semver ranking). No per-instance scoping needed — there's only ever one
// LoxSuite install to be "this rule" about, so unlike the trigger types above, a rule here has
// nothing in its own config to match against. last_state just remembers the last version already
// notified about, so this doesn't refire on every one of versionCheck's daily re-checks — only
// once a genuinely different tag shows up.
async function checkLoxSuiteUpdate(currentVersion, latestVersion) {
  for (const rule of await getRulesByTrigger('loxsuite_update_available')) {
    const state = JSON.parse(rule.last_state || '{}');
    if (state.notifiedVersion === latestVersion) continue;
    await updateRuleState(rule.id, { notifiedVersion: latestVersion });

    await fireRule(rule, {
      title: `LoxSuite v${latestVersion} available`,
      message: `A newer LoxSuite release (v${latestVersion}) is available on GitHub — currently running v${currentVersion}.`,
      severity: 'info',
      fields: [
        { label: 'Running version', value: `v${currentVersion}` },
        { label: 'Latest version', value: `v${latestVersion}` },
      ],
      sourceLabel: 'LoxSuite',
      timestamp: new Date().toISOString(),
    });
  }
}

// Called by loxoneHardware.js's poller the moment a device's own BattWeak/BatTooWeakForUpdate flag
// — as reported by the Miniserver itself, not a threshold this app invented — flips from not-weak
// to weak. No last_state/transition bookkeeping needed here the way the other check* functions
// need it: the loxone_hardware_devices table itself already IS the "last known state" the poller
// diffs against before calling this, so this only ever fires once per genuine transition.
// cfg.severity is user-configurable per rule (see admin-notifications.ejs's "Severity" field for
// this trigger type) — defaults to 'warning' rather than forcing one on every install, since how
// urgent a weak battery is depends entirely on the device (a hallway motion sensor vs. a smoke
// detector aren't the same emergency).
async function checkBatteryWeak(miniserver, item) {
  for (const rule of await getRulesByTrigger('battery_weak')) {
    const cfg = JSON.parse(rule.config || '{}');
    if (cfg.miniserver_id && Number(cfg.miniserver_id) !== miniserver.id) continue;

    const label = item.name || item.type || item.deviceKey;
    await fireRule(rule, {
      title: `${label}: battery weak`,
      message: `"${label}" on "${miniserver.name}" reports a weak battery${item.battery != null ? ` (${item.battery}%)` : ''}.`,
      severity: cfg.severity || 'warning',
      fields: [
        { label: 'Device', value: label },
        { label: 'Miniserver', value: miniserver.name },
        { label: 'Battery', value: item.battery != null ? `${item.battery}%` : 'unknown' },
        { label: 'Too weak to update', value: item.batTooWeakForUpdate ? 'Yes' : 'No' },
      ],
      sourceId: miniserver.id,
      sourceLabel: label,
      timestamp: new Date().toISOString(),
    });
  }
}

// Called by loxoneHardware.js's poller whenever a device's own reported firmware Version differs
// from what was stored for it on the previous poll — the per-device equivalent of
// checkFirmwareChanged above (which only ever compares the Miniserver's OWN firmware string), same
// "detects CHANGED, not that a newer one is available" honesty. cfg.severity defaults to 'info' —
// a firmware bump is usually just informational, but configurable since not every install agrees.
async function checkDeviceFirmwareChanged(miniserver, item, previousVersion) {
  for (const rule of await getRulesByTrigger('device_firmware_changed')) {
    const cfg = JSON.parse(rule.config || '{}');
    if (cfg.miniserver_id && Number(cfg.miniserver_id) !== miniserver.id) continue;

    const label = item.name || item.type || item.deviceKey;
    await fireRule(rule, {
      title: `${label}: firmware changed`,
      message: `"${label}" on "${miniserver.name}" firmware changed from ${previousVersion} to ${item.version}.`,
      severity: cfg.severity || 'info',
      fields: [
        { label: 'Device', value: label },
        { label: 'Miniserver', value: miniserver.name },
        { label: 'Previous version', value: previousVersion },
        { label: 'New version', value: item.version },
      ],
      sourceId: miniserver.id,
      sourceLabel: label,
      timestamp: new Date().toISOString(),
    });
  }
}

// Called by loxoneHardware.js's poller whenever a device's own Online flag flips, either
// direction — the per-device equivalent of checkMiniserverStatus above, for the hardware attached
// TO a Miniserver rather than the Miniserver itself. cfg.severity configures the OFFLINE
// direction's severity only (defaults to 'warning'); coming back online is always reported as
// 'info' regardless — an unconfigurable second severity for the recovery half would be one control
// nobody's asked for, mirroring monitor_threshold's own asymmetric treatment of breach vs. recover.
async function checkDeviceOffline(miniserver, item, isOnline) {
  for (const rule of await getRulesByTrigger('device_offline')) {
    const cfg = JSON.parse(rule.config || '{}');
    if (cfg.miniserver_id && Number(cfg.miniserver_id) !== miniserver.id) continue;

    const label = item.name || item.type || item.deviceKey;
    await fireRule(rule, {
      title: `${label}: ${isOnline ? 'online' : 'offline'}`,
      message: `"${label}" on "${miniserver.name}" is now ${isOnline ? 'online' : 'offline'}.`,
      severity: isOnline ? 'info' : (cfg.severity || 'warning'),
      fields: [
        { label: 'Device', value: label },
        { label: 'Miniserver', value: miniserver.name },
        { label: 'Status', value: isOnline ? 'online' : 'offline' },
      ],
      sourceId: miniserver.id,
      sourceLabel: label,
      timestamp: new Date().toISOString(),
    });
  }
}

// Subscribed to mosquittoLog.js's client-status events (see server.js wiring it up at boot).
// Anonymous connections (no username — shouldn't normally happen, the broker requires auth, but a
// malformed/edge-case log line could still parse one out) aren't meaningful to alert on by
// username and are skipped outright.
async function checkMqttClientStatus(username, status) {
  if (!username) return;
  for (const rule of await getRulesByTrigger('mqtt_client_status')) {
    const cfg = JSON.parse(rule.config || '{}');
    if (cfg.username && cfg.username !== username) continue;

    const state = JSON.parse(rule.last_state || '{}');
    if (state[username] === status) continue;
    await updateRuleState(rule.id, { ...state, [username]: status });

    await fireRule(rule, {
      title: `${username}: ${status}`,
      message: `MQTT client "${username}" is now ${status}.`,
      severity: status === 'disconnected' ? 'warning' : 'info',
      fields: [{ label: 'Client', value: username }, { label: 'Status', value: status }],
      sourceLabel: username,
      timestamp: new Date().toISOString(),
    });
  }
}

// Called from backup.js's own error handling (scheduled run, manual "Backup now", and the rclone
// offsite-copy step) — every failure is independently worth its own notification, unlike the
// status triggers above, so there's no last_state/transition logic here at all.
async function notifyBackupFailed(errorMessage, context) {
  for (const rule of await getRulesByTrigger('backup_failed')) {
    await fireRule(rule, {
      title: 'Backup failed',
      message: errorMessage,
      severity: 'critical',
      fields: [{ label: 'Step', value: context || 'backup' }],
      sourceLabel: context || 'backup',
      timestamp: new Date().toISOString(),
    });
  }
}

module.exports = {
  TRIGGER_TYPES,
  sendTestMessage,
  sendTemplateTestMessage,
  checkMonitorThreshold,
  checkThresholdLadderNotify,
  checkMiniserverStatus,
  checkFirmwareChanged,
  checkGatewayClientFirmwareMismatch,
  checkLoxSuiteUpdate,
  checkMqttClientStatus,
  checkBatteryWeak,
  checkDeviceFirmwareChanged,
  checkDeviceOffline,
  notifyBackupFailed,
  // Pure helpers, exported mainly so test/notifications.test.js can exercise them directly rather
  // than only indirectly through the DB-driven check*/fireRule functions above.
  compareThreshold,
  operatorLabel,
  extractAppriseError,
  getNotificationTemplates,
  saveNotificationTemplates,
  substituteTemplate,
  TEMPLATE_PREVIEW_SAMPLES,
};
