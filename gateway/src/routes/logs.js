const express = require('express');
const db = require('../db');
const { requirePermission } = require('../middleware/requirePermission');
const { classifyLogLevel } = require('../logLevel');

const router = express.Router();

const MAX_ROWS = 1000;
// When a level or text filter is active, more raw rows have to be read than will end up
// displayed (level isn't stored in the DB, so it can only be checked after fetching a line) —
// this is the candidate pool size that gets classified/filtered down to MAX_ROWS.
const FILTER_CANDIDATE_ROWS = 5000;

// datetime-local inputs ("2026-07-28T10:30") have no timezone, so Date() parses them as local
// time — converting to the same ISO form recorded_at is stored in keeps the string comparison
// in the SQL WHERE clause correct.
function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseFilters(query) {
  return {
    from: toIso(query.from),
    to: toIso(query.to),
    level: ['error', 'warning', 'info'].includes(query.level) ? query.level : '',
    q: (query.q || '').trim(),
  };
}

// Builds the WHERE/params shared by every log query, then fetches and classifies rows. Filtering
// by level happens after classification, so when it's active a larger candidate pool is pulled
// (see FILTER_CANDIDATE_ROWS) to avoid the level filter thinning out an already-limited result.
function queryLogs({ source, sourceId, filters }) {
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
    conditions.push('(line LIKE ? OR command_topic LIKE ? OR value_from LIKE ? OR value_to LIKE ?)');
    params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }

  const limit = filters.level ? FILTER_CANDIDATE_ROWS : MAX_ROWS;
  const rows = db.prepare(
    `SELECT line, source_label AS sourceLabel, recorded_at AS recordedAt,
            command_topic AS commandTopic, value_from AS valueFrom, value_to AS valueTo
     FROM log_entries
     WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`
  ).all(...params, limit).map((r) => ({ ...r, level: classifyLogLevel(r.line) }));

  const filtered = filters.level ? rows.filter((r) => r.level === filters.level) : rows;
  return filtered.slice(0, MAX_ROWS);
}

// Each of the four tabs is now its own permission area (see permissionAreas.js's LOG_AREAS) — a
// role viewable on, say, only the System log would otherwise get bounced to a 403 by this
// redirect always pointing at MQTT. Send it to the first tab (in the same order they're tabbed
// in the UI) this user can actually see instead.
const LOG_TAB_AREAS = ['logs_mqtt', 'logs_loxone', 'logs_loxone_commands', 'logs_system'];
const LOG_TAB_PATHS = { logs_mqtt: '/logs/mqtt', logs_loxone: '/logs/loxone', logs_loxone_commands: '/logs/loxone-commands', logs_system: '/logs/system' };

router.get('/', (req, res) => {
  const area = LOG_TAB_AREAS.find((a) => req.user?.isAdmin || req.user?.permissions[a]?.view);
  res.redirect(area ? LOG_TAB_PATHS[area] : '/logs/mqtt');
});

router.get('/mqtt', requirePermission('logs_mqtt', 'view'), (req, res) => {
  const filters = parseFilters(req.query);
  const rows = queryLogs({ source: 'mqtt', filters });
  const settings = db.prepare('SELECT log_retention_days FROM gateway_settings WHERE id = 1').get();
  res.render('logs-mqtt', { rows, query: req.query, retentionDays: settings.log_retention_days });
});

router.get('/mqtt/export.txt', requirePermission('logs_mqtt', 'edit'), (req, res) => {
  const rows = db.prepare('SELECT recorded_at AS recordedAt, line FROM log_entries WHERE source = ? ORDER BY id ASC').all('mqtt');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="mqtt.log"');
  res.send(rows.map((r) => r.line).join('\n'));
});

// def.log lines each carry their own "YYYY-MM-DD HH:MM:SS.mmm;" prefix from the Miniserver — the
// gateway's own recorded_at is only when it happened to be *fetched*, which can be much later for
// backfilled history (e.g. hundreds of lines pulled in one poll after a restart all share one
// recorded_at). Showing the line's own timestamp instead is what avoids a page full of distinct
// events that all appear to have happened in the same instant.
const LOXONE_LINE_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3});/;

router.get('/loxone', requirePermission('logs_loxone', 'view'), (req, res) => {
  const miniservers = db.prepare('SELECT id, name FROM miniservers ORDER BY name').all();
  const miniserverId = req.query.miniserver_id ? Number(req.query.miniserver_id) : null;
  const filters = parseFilters(req.query);

  const rows = queryLogs({ source: 'loxone', sourceId: miniserverId, filters })
    .map((r) => {
      const match = r.line.match(LOXONE_LINE_TIMESTAMP_RE);
      return { ...r, miniserverName: r.sourceLabel, displayTime: match ? match[1] : null };
    });

  const settings = db.prepare('SELECT log_retention_days FROM gateway_settings WHERE id = 1').get();
  res.render('logs-loxone', { rows, miniservers, miniserverId, query: req.query, retentionDays: settings.log_retention_days });
});

router.get('/loxone/export.txt', requirePermission('logs_loxone', 'edit'), (req, res) => {
  const miniserverId = req.query.miniserver_id ? Number(req.query.miniserver_id) : null;
  const rows = miniserverId
    ? db.prepare('SELECT line FROM log_entries WHERE source = ? AND source_id = ? ORDER BY id ASC').all('loxone', miniserverId)
    : db.prepare('SELECT line FROM log_entries WHERE source = ? ORDER BY id ASC').all('loxone');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="loxone.log"');
  res.send(rows.map((r) => r.line).join('\n'));
});

router.get('/loxone-commands', requirePermission('logs_loxone_commands', 'view'), (req, res) => {
  const filters = parseFilters(req.query);
  const rows = queryLogs({ source: 'loxone_commands', filters });
  const settings = db.prepare('SELECT log_retention_days FROM gateway_settings WHERE id = 1').get();
  res.render('logs-loxone-commands', { rows, query: req.query, retentionDays: settings.log_retention_days });
});

router.get('/loxone-commands/export.txt', requirePermission('logs_loxone_commands', 'edit'), (req, res) => {
  const rows = db.prepare(
    `SELECT recorded_at AS recordedAt, source_label AS sourceLabel, line,
            command_topic AS commandTopic, value_from AS valueFrom, value_to AS valueTo
     FROM log_entries WHERE source = 'loxone_commands' ORDER BY id ASC`
  ).all();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="loxone-commands.log"');
  res.send(rows.map((r) => `${r.recordedAt}\t${r.sourceLabel || ''}\t${r.commandTopic || ''}\t${r.valueFrom ?? ''}\t${r.valueTo ?? ''}\t${r.line}`).join('\n'));
});

router.get('/system', requirePermission('logs_system', 'view'), (req, res) => {
  const filters = parseFilters(req.query);
  const rows = queryLogs({ source: 'system', filters });
  const settings = db.prepare('SELECT log_retention_days FROM gateway_settings WHERE id = 1').get();
  res.render('logs-system', { rows, query: req.query, retentionDays: settings.log_retention_days });
});

router.get('/system/export.txt', requirePermission('logs_system', 'edit'), (req, res) => {
  const rows = db.prepare('SELECT line FROM log_entries WHERE source = ? ORDER BY id ASC').all('system');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="system.log"');
  res.send(rows.map((r) => r.line).join('\n'));
});

module.exports = router;
