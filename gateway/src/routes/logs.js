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
    conditions.push('line LIKE ?');
    params.push(`%${filters.q}%`);
  }

  const limit = filters.level ? FILTER_CANDIDATE_ROWS : MAX_ROWS;
  const rows = db.prepare(
    `SELECT line, source_label AS sourceLabel, recorded_at AS recordedAt FROM log_entries
     WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`
  ).all(...params, limit).map((r) => ({ ...r, level: classifyLogLevel(r.line) }));

  const filtered = filters.level ? rows.filter((r) => r.level === filters.level) : rows;
  return filtered.slice(0, MAX_ROWS);
}

router.get('/', (req, res) => res.redirect('/logs/mqtt'));

router.get('/mqtt', (req, res) => {
  const filters = parseFilters(req.query);
  const rows = queryLogs({ source: 'mqtt', filters });
  const settings = db.prepare('SELECT log_retention_days FROM gateway_settings WHERE id = 1').get();
  res.render('logs-mqtt', { rows, query: req.query, retentionDays: settings.log_retention_days });
});

router.get('/mqtt/export.txt', (req, res) => {
  const rows = db.prepare('SELECT recorded_at AS recordedAt, line FROM log_entries WHERE source = ? ORDER BY id ASC').all('mqtt');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="mqtt.log"');
  res.send(rows.map((r) => r.line).join('\n'));
});

router.get('/loxone', (req, res) => {
  const miniservers = db.prepare('SELECT id, name FROM miniservers ORDER BY name').all();
  const miniserverId = req.query.miniserver_id ? Number(req.query.miniserver_id) : null;
  const filters = parseFilters(req.query);

  const rows = queryLogs({ source: 'loxone', sourceId: miniserverId, filters })
    .map((r) => ({ ...r, miniserverName: r.sourceLabel }));

  const settings = db.prepare('SELECT log_retention_days FROM gateway_settings WHERE id = 1').get();
  res.render('logs-loxone', { rows, miniservers, miniserverId, query: req.query, retentionDays: settings.log_retention_days });
});

router.get('/loxone/export.txt', (req, res) => {
  const miniserverId = req.query.miniserver_id ? Number(req.query.miniserver_id) : null;
  const rows = miniserverId
    ? db.prepare('SELECT line FROM log_entries WHERE source = ? AND source_id = ? ORDER BY id ASC').all('loxone', miniserverId)
    : db.prepare('SELECT line FROM log_entries WHERE source = ? ORDER BY id ASC').all('loxone');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="loxone.log"');
  res.send(rows.map((r) => r.line).join('\n'));
});

router.post('/settings', requirePermission('logs', 'edit'), (req, res) => {
  const days = Number(req.body.log_retention_days);
  if (Number.isFinite(days) && days > 0) {
    db.prepare('UPDATE gateway_settings SET log_retention_days = ? WHERE id = 1').run(Math.round(days));
  }
  res.redirect(req.get('referer') || '/logs/mqtt');
});

module.exports = router;
