const express = require('express');
const dgram = require('dgram');
const db = require('../db');
const { requirePermission } = require('../middleware/requirePermission');
const { classifyLogLevel } = require('../logLevel');
const { resolveRange, rangeToWindow } = require('./monitor');
const mqttClient = require('../mqttClient');
const { TRIGGER_TYPES } = require('../notifications');
const asyncHandler = require('../middleware/asyncHandler');

// notification_events.event_type covers every rule-engine trigger type (see TRIGGER_TYPES) PLUS
// 'threshold_ladder' — the one path that writes here directly, with no rule behind it at all (a
// ladder rung's own "Notify" checkbox, see thresholdLadder.js/notifications.js's
// checkThresholdLadderNotify), so it isn't in TRIGGER_TYPES and needs its own label here.
const NOTIFICATION_CATEGORIES = [...TRIGGER_TYPES, { key: 'threshold_ladder', label: 'Threshold ladder crossed' }];
function categoryLabel(eventType) {
  return (NOTIFICATION_CATEGORIES.find((c) => c.key === eventType) || {}).label || eventType;
}

const router = express.Router();

const MAX_ROWS = 1000;
// When a level or text filter is active, more raw rows have to be read than will end up
// displayed (level isn't stored in the DB, so it can only be checked after fetching a line) —
// this is the candidate pool size that gets classified/filtered down to MAX_ROWS.
const FILTER_CANDIDATE_ROWS = 5000;

// Shared range vocabulary (presets/custom duration/absolute From-To — see rangeField() in
// chartFieldHelpers.js and resolveRange/rangeToWindow in routes/monitor.js), same as Monitor
// detail/Home/the dashboard panel Range field — replaces this page's own previous from/to
// datetime-local pair, which had no quick presets and (via a plain `new Date(value)`) parsed
// against the SERVER's own timezone instead of the configured display one.
//
// Unlike Monitor detail, an absent/blank range here defaults to 'all', not resolveRange()'s own
// generic '24h' fallback — this page's own long-standing default (nothing typed in From/To) was
// "show everything, newest first, capped at MAX_ROWS", and silently narrowing every fresh visit
// down to the last 24h would be a real behavior change, not just an added convenience.
function parseFilters(query) {
  const range = query.range ? resolveRange(query.range) : 'all';
  const { since, until } = rangeToWindow(range);
  return {
    range,
    from: since,
    to: until,
    level: ['error', 'warning', 'info'].includes(query.level) ? query.level : '',
    q: (query.q || '').trim(),
  };
}

// Builds the WHERE/params shared by every log query, then fetches and classifies rows. Filtering
// by level happens after classification, so when it's active a larger candidate pool is pulled
// (see FILTER_CANDIDATE_ROWS) to avoid the level filter thinning out an already-limited result.
async function queryLogs({ source, sourceId, filters }) {
  const conditions = ['source = ?'];
  const params = [source];
  if (sourceId) {
    conditions.push('source_id = ?');
    params.push(sourceId);
  }
  if (filters.from) {
    conditions.push('recorded_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('recorded_at <= ?');
    params.push(filters.to);
  }
  if (filters.q) {
    // command_topic/value_from/value_to are only ever populated for the 'loxone_commands' source
    // (see db.js's migrateLogEntriesCommandColumns) — NULL on every other source, so OR'ing them in
    // here is a no-op for the other three Logs tabs and just widens what "Contains" matches on this one.
    // LOWER(...) on both sides (not bare LIKE) — SQLite's own LIKE is case-insensitive for ASCII by
    // default, but Postgres's isn't (it needs ILIKE, a different operator entirely) — wrapping both
    // sides in LOWER() matches case-insensitively on every backend identically, so this "Contains"
    // filter doesn't quietly start being case-sensitive once a search runs against Postgres.
    conditions.push('(LOWER(line) LIKE LOWER(?) OR LOWER(command_topic) LIKE LOWER(?) OR LOWER(value_from) LIKE LOWER(?) OR LOWER(value_to) LIKE LOWER(?))');
    params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }

  const limit = filters.level ? FILTER_CANDIDATE_ROWS : MAX_ROWS;
  const rawRows = await db.prepare(
    `SELECT line, source_label AS sourceLabel, recorded_at AS recordedAt,
            command_topic AS commandTopic, value_from AS valueFrom, value_to AS valueTo,
            source_id AS sourceMiniserverId, transport
     FROM log_entries
     WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`
  ).all(...params, limit);
  const rows = rawRows.map((r) => ({ ...r, level: classifyLogLevel(r.line) }));

  const filtered = filters.level ? rows.filter((r) => r.level === filters.level) : rows;
  return filtered.slice(0, MAX_ROWS);
}

// Each of the five tabs is now its own permission area (see permissionAreas.js's LOG_AREAS) — a
// role viewable on, say, only the System log would otherwise get bounced to a 403 by this
// redirect always pointing at MQTT. Send it to the first tab (in the same order they're tabbed
// in the UI) this user can actually see instead.
const LOG_TAB_AREAS = ['logs_mqtt', 'logs_loxone', 'logs_loxone_commands', 'logs_system', 'logs_notifications'];
const LOG_TAB_PATHS = { logs_mqtt: '/logs/mqtt', logs_loxone: '/logs/loxone', logs_loxone_commands: '/logs/loxone-commands', logs_system: '/logs/system', logs_notifications: '/logs/notifications' };

// Own parser, not a reuse of parseFilters() above — notification_events.severity uses a different
// vocabulary (info/warning/critical, set directly by notifications.js) than classifyLogLevel's
// (error/warning/info, guessed from free text), so "level" there isn't the same thing as
// "severity" here. Same 'all'-by-default reasoning as parseFilters() above, though.
function parseNotificationFilters(query) {
  const range = query.range ? resolveRange(query.range) : 'all';
  const { since, until } = rangeToWindow(range);
  return {
    range,
    from: since,
    to: until,
    severity: ['info', 'warning', 'critical'].includes(query.severity) ? query.severity : '',
    category: NOTIFICATION_CATEGORIES.some((c) => c.key === query.category) ? query.category : '',
    q: (query.q || '').trim(),
  };
}

// notification_events has a real, already-structured severity column (see db.js/notifications.js)
// — unlike the other four tabs, which only ever have a free-text `line` and need classifyLogLevel's
// regex guesswork, this can filter directly with WHERE severity = ?, and title/message are its own
// columns rather than one opaque string to search inside.
async function queryNotificationEvents(filters) {
  const conditions = ['1=1'];
  const params = [];
  if (filters.from) { conditions.push('created_at >= ?'); params.push(filters.from); }
  if (filters.to) { conditions.push('created_at <= ?'); params.push(filters.to); }
  if (filters.q) {
    // See queryLogs()'s own comment above on why LOWER(...) wraps both sides instead of a bare LIKE.
    conditions.push('(LOWER(title) LIKE LOWER(?) OR LOWER(message) LIKE LOWER(?))');
    params.push(`%${filters.q}%`, `%${filters.q}%`);
  }
  if (filters.severity) { conditions.push('severity = ?'); params.push(filters.severity); }
  if (filters.category) { conditions.push('event_type = ?'); params.push(filters.category); }

  return db.prepare(
    `SELECT id, event_type AS eventType, severity, title, message, source_label AS sourceLabel,
            source_id AS sourceId, created_at AS createdAt
     FROM notification_events WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`
  ).all(...params, MAX_ROWS);
}

router.get('/', (req, res) => {
  const area = LOG_TAB_AREAS.find((a) => req.user?.isAdmin || req.user?.permissions[a]?.view);
  res.redirect(area ? LOG_TAB_PATHS[area] : '/logs/mqtt');
});

router.get('/mqtt', requirePermission('logs_mqtt', 'view'), asyncHandler(async (req, res) => {
  const filters = parseFilters(req.query);
  const rows = await queryLogs({ source: 'mqtt', filters });
  const settings = await db.prepare('SELECT log_retention_days FROM gateway_settings WHERE id = 1').get();
  // Same blur+notice treatment as /logs/loxone's own permission gate, different underlying cause:
  // there's no separate poller error to check here since mosquittoLog.js reads the broker's OWN
  // log file locally (not over MQTT), which keeps working fine even while the broker itself is
  // down — mqttClient.state.connected is the actual signal that matters, since a disconnected
  // broker means nothing NEW is arriving to eventually show up here either way.
  const brokerOffline = !mqttClient.state.connected;
  res.render('logs-mqtt', { rows, query: req.query, range: filters.range, retentionDays: settings.log_retention_days, brokerOffline });
}));

router.get('/mqtt/export.txt', requirePermission('logs_mqtt', 'edit'), asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT recorded_at AS recordedAt, line FROM log_entries WHERE source = ? ORDER BY id ASC').all('mqtt');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="mqtt.log"');
  res.send(rows.map((r) => r.line).join('\n'));
}));

// def.log lines each carry their own "YYYY-MM-DD HH:MM:SS.mmm;" prefix from the Miniserver — the
// gateway's own recorded_at is only when it happened to be *fetched*, which can be much later for
// backfilled history (e.g. hundreds of lines pulled in one poll after a restart all share one
// recorded_at). Showing the line's own timestamp instead is what avoids a page full of distinct
// events that all appear to have happened in the same instant.
const LOXONE_LINE_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3});/;

router.get('/loxone', requirePermission('logs_loxone', 'view'), asyncHandler(async (req, res) => {
  const miniservers = await db.prepare('SELECT id, name, logbook_error FROM miniservers ORDER BY sort_order, id').all();
  const miniserverId = req.query.miniserver_id ? Number(req.query.miniserver_id) : null;
  const filters = parseFilters(req.query);

  const rows = (await queryLogs({ source: 'loxone', sourceId: miniserverId, filters }))
    .map((r) => {
      const match = r.line.match(LOXONE_LINE_TIMESTAMP_RE);
      return { ...r, miniserverName: r.sourceLabel, displayTime: match ? match[1] : null };
    });

  // Full blur+notice when one specific Miniserver is picked, OR when "all Miniservers" is picked
  // but EVERY one of them is broken — in that second case there's no working Miniserver's rows
  // mixed in to make the table still worth looking at, same as the single-Miniserver case. Only
  // genuinely MIXED results (some working, some not) get the lighter, non-blurring warning banner
  // instead — blurring the whole table there would wrongly hide rows from whichever Miniserver(s)
  // are actually fine.
  const selectedMiniserver = miniserverId ? miniservers.find((m) => m.id === miniserverId) : null;
  const allBroken = !miniserverId && miniservers.length > 0 && miniservers.every((m) => m.logbook_error);
  const brokenMiniservers = (!miniserverId && !allBroken) ? miniservers.filter((m) => m.logbook_error) : [];
  const logbookError = selectedMiniserver
    ? selectedMiniserver.logbook_error
    : allBroken
      ? (miniservers.length === 1
        ? miniservers[0].logbook_error
        : `Every configured Miniserver is failing to fetch its Logbook. Most recent error (${miniservers[0].name}): ${miniservers[0].logbook_error}`)
      : null;

  const settings = await db.prepare('SELECT log_retention_days FROM gateway_settings WHERE id = 1').get();
  res.render('logs-loxone', {
    rows,
    miniservers,
    miniserverId,
    logbookError,
    brokenMiniservers,
    query: req.query,
    range: filters.range,
    retentionDays: settings.log_retention_days,
  });
}));

router.get('/loxone/export.txt', requirePermission('logs_loxone', 'edit'), asyncHandler(async (req, res) => {
  const miniserverId = req.query.miniserver_id ? Number(req.query.miniserver_id) : null;
  const rows = miniserverId
    ? await db.prepare('SELECT line FROM log_entries WHERE source = ? AND source_id = ? ORDER BY id ASC').all('loxone', miniserverId)
    : await db.prepare('SELECT line FROM log_entries WHERE source = ? ORDER BY id ASC').all('loxone');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="loxone.log"');
  res.send(rows.map((r) => r.line).join('\n'));
}));

router.get('/loxone-commands', requirePermission('logs_loxone_commands', 'view'), asyncHandler(async (req, res) => {
  const filters = parseFilters(req.query);
  const rows = await queryLogs({ source: 'loxone_commands', filters });
  const settings = await db.prepare('SELECT log_retention_days FROM gateway_settings WHERE id = 1').get();
  // A rejected "no matching mapping" row is a snapshot of what happened AT THE TIME — adding the
  // missing mapping afterwards doesn't rewrite history, so the row would otherwise sit there
  // looking permanently Rejected even once it's actually fixed, with no hint that Loxone just
  // hasn't sent that exact command again yet (it doesn't retry on its own). Mirrors
  // findOrAutoCreateLoxoneMapping's own two ways a mapping can match a raw token (loxone.js).
  const rejectedTopics = [...new Set(rows.filter((r) => r.level === 'error' && r.commandTopic).map((r) => r.commandTopic))];
  const pendingTopics = new Set();
  if (rejectedTopics.length) {
    const placeholders = rejectedTopics.map(() => '?').join(',');
    const matches = await db.prepare(
      `SELECT token, mqtt_topic FROM mappings_loxone_to_mqtt
       WHERE enabled = 1 AND (token IN (${placeholders}) OR mqtt_topic IN (${placeholders}))`
    ).all(...rejectedTopics, ...rejectedTopics);
    matches.forEach((m) => { pendingTopics.add(m.token); pendingTopics.add(m.mqtt_topic); });
  }
  res.render('logs-loxone-commands', {
    rows, query: req.query, range: filters.range, retentionDays: settings.log_retention_days, pendingTopics,
    testError: req.query.testError || null,
  });
}));

// Fires the exact same UDP packet a real Loxone Virtual UDP Output would ("<token>=<value>" at
// 127.0.0.1:LOXONE_UDP_PORT — see loxoneUdpServer.js's own handleMessage()), for a token typed in
// here rather than one tied to an already-saved mapping (mappings.js's own /loxone-to-mqtt/:id/test
// only ever proves an EXISTING mapping works). Lets someone see the whole Rejected → add a mapping
// → Pending → send again → Accepted arc play out on demand, without waiting for a real Miniserver
// to happen to send an unmapped command.
router.post('/loxone-commands/test-send', requirePermission('logs_loxone_commands', 'edit'), asyncHandler(async (req, res) => {
  const token = (req.body.token || '').trim();
  const value = (req.body.value || '').trim();
  if (!token || !value) {
    return res.redirect(`/logs/loxone-commands?testError=${encodeURIComponent('Enter both a token and a value.')}`);
  }

  const port = Number(process.env.LOXONE_UDP_PORT) || 11885;
  const message = `${token}=${value}`;
  await new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.send(Buffer.from(message), port, '127.0.0.1', () => {
      socket.close();
      resolve(); // fire-and-forget on the wire, same as the real thing — the log row is the real proof
    });
  });
  // The UDP round trip (loopback, but still async through the socket + the listener's own DB
  // write) needs a beat to land before the redirect reloads the page, or the new row might not
  // show up until the next 5s auto-refresh tick.
  await new Promise((resolve) => setTimeout(resolve, 300));
  res.redirect('/logs/loxone-commands');
}));

router.get('/loxone-commands/export.txt', requirePermission('logs_loxone_commands', 'edit'), asyncHandler(async (req, res) => {
  const rows = await db.prepare(
    `SELECT recorded_at AS recordedAt, source_label AS sourceLabel, line,
            command_topic AS commandTopic, value_from AS valueFrom, value_to AS valueTo
     FROM log_entries WHERE source = 'loxone_commands' ORDER BY id ASC`
  ).all();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="loxone-commands.log"');
  res.send(rows.map((r) => `${r.recordedAt}\t${r.sourceLabel || ''}\t${r.commandTopic || ''}\t${r.valueFrom ?? ''}\t${r.valueTo ?? ''}\t${r.line}`).join('\n'));
}));

router.get('/system', requirePermission('logs_system', 'view'), asyncHandler(async (req, res) => {
  const filters = parseFilters(req.query);
  const rows = await queryLogs({ source: 'system', filters });
  const settings = await db.prepare('SELECT log_retention_days FROM gateway_settings WHERE id = 1').get();
  res.render('logs-system', { rows, query: req.query, range: filters.range, retentionDays: settings.log_retention_days });
}));

router.get('/system/export.txt', requirePermission('logs_system', 'edit'), asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT line FROM log_entries WHERE source = ? ORDER BY id ASC').all('system');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="system.log"');
  res.send(rows.map((r) => r.line).join('\n'));
}));

router.get('/notifications', requirePermission('logs_notifications', 'view'), asyncHandler(async (req, res) => {
  const filters = parseNotificationFilters(req.query);
  const rows = await queryNotificationEvents(filters);
  const settings = await db.prepare('SELECT notification_retention_days FROM gateway_settings WHERE id = 1').get();
  res.render('logs-notifications', {
    rows, query: req.query, range: filters.range, retentionDays: settings.notification_retention_days,
    categories: NOTIFICATION_CATEGORIES, categoryLabel,
  });
}));

router.get('/notifications/export.txt', requirePermission('logs_notifications', 'edit'), asyncHandler(async (req, res) => {
  const rows = await db.prepare(
    'SELECT created_at AS createdAt, event_type AS eventType, severity, title, message, source_label AS sourceLabel FROM notification_events ORDER BY id ASC'
  ).all();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="notifications.log"');
  res.send(rows.map((r) => `${r.createdAt}\t${categoryLabel(r.eventType)}\t${r.severity}\t${r.title}\t${r.message}\t${r.sourceLabel || ''}`).join('\n'));
}));

module.exports = router;
