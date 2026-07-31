const { execFile } = require('child_process');
const db = require('./db');
const { logSystemEvent } = require('./auditLog');

// The four trigger types selectable when creating a rule — kept here since routes/notifications.js
// and this file are the only two places that need the list.
const TRIGGER_TYPES = [
  { key: 'monitor_threshold', label: 'Monitor threshold breached' },
  { key: 'miniserver_status', label: 'Miniserver online/offline' },
  { key: 'mqtt_client_status', label: 'MQTT client online/offline' },
  { key: 'backup_failed', label: 'Backup failed' },
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

async function fireRule(rule, event) {
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
        timestamp: new Date().toISOString(),
      });
    } else if (cfg.notify_on_recover) {
      fireRule(rule, {
        title: `${monitor.label}: back to normal`,
        message: `${monitor.label} is no longer ${operatorLabel(cfg.operator)} ${cfg.value} (current: ${numericValue}).`,
        severity: 'info',
        fields: [{ label: 'Monitor', value: monitor.label }, { label: 'Current value', value: numericValue }],
        timestamp: new Date().toISOString(),
      });
    }
  }
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
      timestamp: new Date().toISOString(),
    });
  }
}

module.exports = {
  TRIGGER_TYPES,
  sendTestMessage,
  checkMonitorThreshold,
  checkMiniserverStatus,
  checkMqttClientStatus,
  notifyBackupFailed,
  // Pure helpers, exported mainly so test/notifications.test.js can exercise them directly rather
  // than only indirectly through the DB-driven check*/fireRule functions above.
  compareThreshold,
  operatorLabel,
  extractAppriseError,
};
