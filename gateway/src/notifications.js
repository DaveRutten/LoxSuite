const { execFile } = require('child_process');
const db = require('./db');
const { logSystemEvent } = require('./auditLog');
const { matchedRung } = require('./thresholdLadder');

// The five trigger types selectable when creating a rule — kept here since routes/notifications.js
// and this file are the only two places that need the list.
const TRIGGER_TYPES = [
  { key: 'monitor_threshold', label: 'Monitor threshold breached' },
  { key: 'miniserver_status', label: 'Miniserver online/offline' },
  { key: 'mqtt_client_status', label: 'MQTT client online/offline' },
  { key: 'backup_failed', label: 'Backup failed' },
  { key: 'firmware_changed', label: 'Miniserver firmware changed' },
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

async function sendToChannel(channel, event) {
  if (!channel.url) throw new Error('This channel has no Apprise URL configured.');
  await runApprise(channel.url, event.title, renderBody(event), apLevel(event.severity));
}

// Exercised directly by the Notifications admin page's own "Send test" button per channel — same
// send path a real rule uses, just with a canned event, so a successful test is a genuine
// end-to-end proof the URL actually works rather than just "it looks like a URL".
async function sendTestMessage(channel) {
  await sendToChannel(channel, {
    title: 'Test notification',
    message: 'This is a test message from LoxSuite — if you can read this, the channel is configured correctly.',
    severity: 'info',
    fields: [{ label: 'Channel', value: channel.name }, { label: 'Sent at', value: new Date().toLocaleString() }],
    timestamp: new Date().toISOString(),
  });
}

// ---- Rule dispatch ----

function getChannelsForRule(ruleId) {
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
function getSubscriberChannelsForRule(ruleId) {
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
function recordNotificationEvent(event, opts) {
  db.prepare(
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

async function fireRule(rule, event) {
  recordNotificationEvent(event, { eventType: rule.trigger_type, ruleId: rule.id });

  const channels = getChannelsForRule(rule.id);
  for (const channel of channels) {
    try {
      await sendToChannel(channel, event);
      logSystemEvent(`Notification "${rule.name}" sent via "${channel.name}".`);
    } catch (err) {
      logSystemEvent(`Notification "${rule.name}" via "${channel.name}" failed: ${err.message}`);
    }
  }

  const subscribers = getSubscriberChannelsForRule(rule.id);
  for (const subscriber of subscribers) {
    try {
      await sendToChannel({ name: `${subscriber.username}'s notifications`, url: subscriber.url }, event);
      logSystemEvent(`Notification "${rule.name}" sent to "${subscriber.username}".`);
    } catch (err) {
      logSystemEvent(`Notification "${rule.name}" to "${subscriber.username}" failed: ${err.message}`);
    }
  }
}

function getRulesByTrigger(triggerType) {
  return db.prepare('SELECT * FROM notification_rules WHERE trigger_type = ? AND enabled = 1').all(triggerType);
}

function updateRuleState(ruleId, state) {
  db.prepare('UPDATE notification_rules SET last_state = ? WHERE id = ?').run(JSON.stringify(state), ruleId);
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
function checkMonitorThreshold(monitorId, numericValue) {
  const rules = getRulesByTrigger('monitor_threshold').filter((rule) => Number(JSON.parse(rule.config || '{}').monitor_id) === monitorId);
  if (rules.length === 0) return;
  const monitor = db.prepare('SELECT id, label FROM monitors WHERE id = ?').get(monitorId);
  if (!monitor) return;

  for (const rule of rules) {
    const cfg = JSON.parse(rule.config || '{}');
    const state = JSON.parse(rule.last_state || '{}');
    const breached = compareThreshold(numericValue, cfg.operator, Number(cfg.value));
    if (breached === !!state.breached) continue;
    updateRuleState(rule.id, { breached });

    if (breached) {
      fireRule(rule, {
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
      fireRule(rule, {
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
function checkThresholdLadderNotify(monitorId, numericValue) {
  const monitor = db.prepare('SELECT id, label, config FROM monitors WHERE id = ?').get(monitorId);
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

  recordNotificationEvent({
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
function checkMiniserverStatus(miniserver, newStatus) {
  for (const rule of getRulesByTrigger('miniserver_status')) {
    const cfg = JSON.parse(rule.config || '{}');
    if (cfg.miniserver_id && Number(cfg.miniserver_id) !== miniserver.id) continue;

    const state = JSON.parse(rule.last_state || '{}');
    const key = String(miniserver.id);
    if (state[key] === newStatus) continue;
    updateRuleState(rule.id, { ...state, [key]: newStatus });

    fireRule(rule, {
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
function checkFirmwareChanged(miniserver, newVersion) {
  // The !miniserver.firmware_version guard matters — without it, a brand-new Miniserver's very
  // first successful read (previous version genuinely unknown, not "unchanged") would look like a
  // change from nothing and fire a spurious alert.
  if (!newVersion || !miniserver.firmware_version || newVersion === miniserver.firmware_version) return;

  for (const rule of getRulesByTrigger('firmware_changed')) {
    const cfg = JSON.parse(rule.config || '{}');
    if (cfg.miniserver_id && Number(cfg.miniserver_id) !== miniserver.id) continue;

    fireRule(rule, {
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

// Called by versionCheck.js whenever its own daily GitHub tags check finds a latest tag that
// differs from the version currently running (see that file for why this is a plain string
// inequality, not real semver ranking). No per-instance scoping needed — there's only ever one
// LoxSuite install to be "this rule" about, so unlike the trigger types above, a rule here has
// nothing in its own config to match against. last_state just remembers the last version already
// notified about, so this doesn't refire on every one of versionCheck's daily re-checks — only
// once a genuinely different tag shows up.
function checkLoxSuiteUpdate(currentVersion, latestVersion) {
  for (const rule of getRulesByTrigger('loxsuite_update_available')) {
    const state = JSON.parse(rule.last_state || '{}');
    if (state.notifiedVersion === latestVersion) continue;
    updateRuleState(rule.id, { notifiedVersion: latestVersion });

    fireRule(rule, {
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
function checkBatteryWeak(miniserver, item) {
  for (const rule of getRulesByTrigger('battery_weak')) {
    const cfg = JSON.parse(rule.config || '{}');
    if (cfg.miniserver_id && Number(cfg.miniserver_id) !== miniserver.id) continue;

    const label = item.name || item.type || item.deviceKey;
    fireRule(rule, {
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
function checkDeviceFirmwareChanged(miniserver, item, previousVersion) {
  for (const rule of getRulesByTrigger('device_firmware_changed')) {
    const cfg = JSON.parse(rule.config || '{}');
    if (cfg.miniserver_id && Number(cfg.miniserver_id) !== miniserver.id) continue;

    const label = item.name || item.type || item.deviceKey;
    fireRule(rule, {
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
function checkDeviceOffline(miniserver, item, isOnline) {
  for (const rule of getRulesByTrigger('device_offline')) {
    const cfg = JSON.parse(rule.config || '{}');
    if (cfg.miniserver_id && Number(cfg.miniserver_id) !== miniserver.id) continue;

    const label = item.name || item.type || item.deviceKey;
    fireRule(rule, {
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
function checkMqttClientStatus(username, status) {
  if (!username) return;
  for (const rule of getRulesByTrigger('mqtt_client_status')) {
    const cfg = JSON.parse(rule.config || '{}');
    if (cfg.username && cfg.username !== username) continue;

    const state = JSON.parse(rule.last_state || '{}');
    if (state[username] === status) continue;
    updateRuleState(rule.id, { ...state, [username]: status });

    fireRule(rule, {
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
function notifyBackupFailed(errorMessage, context) {
  for (const rule of getRulesByTrigger('backup_failed')) {
    fireRule(rule, {
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
  checkMonitorThreshold,
  checkThresholdLadderNotify,
  checkMiniserverStatus,
  checkFirmwareChanged,
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
};
