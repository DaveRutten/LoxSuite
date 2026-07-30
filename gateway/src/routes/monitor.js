const express = require('express');
const db = require('../db');
const { humanizeTopic } = require('../topicName');
const { getTopicOverview } = require('../mqttClient');
const { getMonitorableStates } = require('../loxoneStructure');
const { reloadMqttMonitors, getCurrentValue, clearCurrentValue } = require('../monitorCollector');
const { requirePermission } = require('../middleware/requirePermission');

const router = express.Router();

const RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};
const MAX_ROWS = 2000;

const UNIT_MS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60 * 1000, min: 60 * 1000, mins: 60 * 1000, minute: 60 * 1000, minutes: 60 * 1000,
  h: 60 * 60 * 1000, hr: 60 * 60 * 1000, hrs: 60 * 60 * 1000, hour: 60 * 60 * 1000, hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000, day: 24 * 60 * 60 * 1000, days: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000, weeks: 7 * 24 * 60 * 60 * 1000,
};
const CUSTOM_RANGE_RE = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i;
// A Grafana-style absolute range (fixed start+end, not "N units ago through now") — epoch
// milliseconds rather than ISO strings so the whole thing round-trips through a single URL query
// param / dashboard_panels.range TEXT column without needing to escape colons or a separator.
const ABS_RANGE_RE = /^abs_(\d+)_(\d+)$/;

// Free-typed durations like "3h", "10 sec", "2.5 days" — anything RANGE_MS doesn't already
// cover as a named preset. Returns null (not a custom range) if it doesn't parse.
function customRangeMs(value) {
  const match = typeof value === 'string' ? value.trim().match(CUSTOM_RANGE_RE) : null;
  if (!match) return null;
  const unitMs = UNIT_MS[match[2].toLowerCase()];
  return unitMs ? Number(match[1]) * unitMs : null;
}

function buildAbsoluteRange(startMs, endMs) {
  return `abs_${Math.round(startMs)}_${Math.round(endMs)}`;
}

// Every relative range (presets and custom durations alike) only ever needs a lower bound —
// "now" is always the implicit upper bound, so history queries just never had an upper bound at
// all before absolute ranges existed. An absolute range fixes BOTH ends, so this now returns a
// {since, until} window instead of a single cutoff; until stays null for every relative range,
// exactly preserving the old "no upper bound" behavior for every caller that already existed.
function rangeToWindow(range) {
  const absMatch = typeof range === 'string' ? range.match(ABS_RANGE_RE) : null;
  if (absMatch) {
    return { since: new Date(Number(absMatch[1])).toISOString(), until: new Date(Number(absMatch[2])).toISOString() };
  }
  const ms = RANGE_MS[range] || customRangeMs(range);
  return { since: ms ? new Date(Date.now() - ms).toISOString() : null, until: null };
}

// Kept alongside rangeToWindow (not replaced by it) since most callers only ever cared about the
// lower bound — this way a caller that doesn't yet need the upper bound doesn't have to destructure.
function rangeToSince(range) {
  return rangeToWindow(range).since;
}

// Missing/unrecognized -> '24h'; 'all' is a valid range in its own right (rangeToSince('all')
// correctly falls through to null, i.e. no lower bound) and must not be coerced away. A
// custom duration string (e.g. "3h") that parses cleanly is passed through as-is.
function resolveRange(value) {
  if (RANGE_MS[value] || value === 'all') return value;
  const absMatch = typeof value === 'string' ? value.match(ABS_RANGE_RE) : null;
  if (absMatch) return Number(absMatch[1]) < Number(absMatch[2]) ? value : '24h'; // reject inverted/zero-width
  return customRangeMs(value) ? value : '24h';
}

// "AND recorded_at >= ? [AND recorded_at <= ?]" plus its matching params, spread into whichever
// query is building — the one place that turns a resolved range into actual SQL, so every history
// query (chart series, table rows, CSV export, raw values, stat_delta's comparison baseline)
// handles a since-only relative range and a since+until absolute range identically instead of
// each hand-rolling its own since-ternary (which is exactly what silently never supported an
// upper bound before).
function historyWindowClause(range) {
  const { since, until } = rangeToWindow(range);
  const clauses = [];
  const params = [];
  if (since) { clauses.push('recorded_at >= ?'); params.push(since); }
  if (until) { clauses.push('recorded_at <= ?'); params.push(until); }
  return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
}

function csvField(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function loadMonitor(id) {
  return db
    .prepare(
      `SELECT monitors.*, miniservers.name AS miniserver_name
       FROM monitors LEFT JOIN miniservers ON miniservers.id = monitors.miniserver_id
       WHERE monitors.id = ?`
    )
    .get(id);
}

router.get('/', (req, res) => {
  const monitors = db
    .prepare(
      `SELECT monitors.*, miniservers.name AS miniserver_name,
              COUNT(DISTINCT dashboard_panel_monitors.panel_id) AS panelCount,
              GROUP_CONCAT(DISTINCT custom_dashboards.name) AS dashboardNames
       FROM monitors
       LEFT JOIN miniservers ON miniservers.id = monitors.miniserver_id
       LEFT JOIN dashboard_panel_monitors ON dashboard_panel_monitors.monitor_id = monitors.id
       LEFT JOIN dashboard_panels ON dashboard_panels.id = dashboard_panel_monitors.panel_id
       LEFT JOIN custom_dashboards ON custom_dashboards.id = dashboard_panels.dashboard_id
       GROUP BY monitors.id
       ORDER BY monitors.label`
    )
    .all()
    .map((m) => ({ ...m, current: getCurrentValue(m.id) }));

  const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY name').all();
  const retention = db.prepare('SELECT monitor_retention_days FROM gateway_settings WHERE id = 1').get();
  const unusedCount = monitors.filter((m) => m.panelCount === 0).length;

  res.render('monitor', {
    monitors,
    miniservers,
    knownTopics: getTopicOverview().map((t) => t.topic),
    retentionDays: retention.monitor_retention_days,
    unusedCount,
    error: null,
  });
});

router.post('/', requirePermission('monitor', 'edit'), async (req, res) => {
  const { source_type, label, topic, miniserver_id, loxone_uuid, poll_interval_ms } = req.body;

  try {
    if (source_type === 'mqtt') {
      if (!topic) throw new Error('MQTT topic is required.');
      db.prepare(
        `INSERT INTO monitors (source_type, label, mqtt_topic, enabled, created_at)
         VALUES ('mqtt', ?, ?, 1, ?)`
      ).run(label || humanizeTopic(topic), topic, new Date().toISOString());
      reloadMqttMonitors();
    } else if (source_type === 'loxone') {
      if (!miniserver_id || !loxone_uuid) throw new Error('Miniserver and state are required.');
      const miniserver = db.prepare('SELECT * FROM miniservers WHERE id = ?').get(miniserver_id);
      if (!miniserver) throw new Error('Miniserver not found.');

      let resolvedLabel = label;
      if (!resolvedLabel) {
        const states = await getMonitorableStates(miniserver);
        resolvedLabel = states.find((s) => s.uuid === loxone_uuid)?.label || loxone_uuid;
      }

      db.prepare(
        `INSERT INTO monitors (source_type, label, miniserver_id, loxone_uuid, poll_interval_ms, enabled, created_at)
         VALUES ('loxone', ?, ?, ?, ?, 1, ?)`
      ).run(resolvedLabel, miniserver_id, loxone_uuid, Number(poll_interval_ms) || 10000, new Date().toISOString());
    } else {
      throw new Error('Unknown source type.');
    }
    res.redirect('/monitor');
  } catch (err) {
    const monitors = db
      .prepare(
        `SELECT monitors.*, miniservers.name AS miniserver_name
         FROM monitors LEFT JOIN miniservers ON miniservers.id = monitors.miniserver_id
         ORDER BY monitors.label`
      )
      .all()
      .map((m) => ({ ...m, current: getCurrentValue(m.id) }));
    const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY name').all();
    const retention = db.prepare('SELECT monitor_retention_days FROM gateway_settings WHERE id = 1').get();
    res.render('monitor', {
      monitors,
      miniservers,
      knownTopics: getTopicOverview().map((t) => t.topic),
      retentionDays: retention.monitor_retention_days,
      error: err.message,
    });
  }
});

router.post('/settings', requirePermission('monitor', 'edit'), (req, res) => {
  const days = Number(req.body.monitor_retention_days);
  if (Number.isFinite(days) && days > 0) {
    db.prepare('UPDATE gateway_settings SET monitor_retention_days = ? WHERE id = 1').run(Math.round(days));
  }
  // Referer-based (not a fixed '/monitor') since this form now lives on the Settings page —
  // same pattern already used by /logs/settings.
  res.redirect(req.get('referer') || '/monitor');
});

router.post('/:id/toggle', requirePermission('monitor', 'edit'), (req, res) => {
  db.prepare('UPDATE monitors SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  reloadMqttMonitors();
  res.redirect('/monitor');
});

router.post('/:id/update', requirePermission('monitor', 'edit'), (req, res) => {
  const { label, poll_interval_ms } = req.body;
  const monitor = db.prepare('SELECT * FROM monitors WHERE id = ?').get(req.params.id);
  if (!monitor) return res.redirect('/monitor');

  if (monitor.source_type === 'loxone') {
    db.prepare('UPDATE monitors SET label = ?, poll_interval_ms = ? WHERE id = ?')
      .run(label || monitor.label, Number(poll_interval_ms) || monitor.poll_interval_ms, monitor.id);
  } else {
    db.prepare('UPDATE monitors SET label = ? WHERE id = ?').run(label || monitor.label, monitor.id);
    reloadMqttMonitors(); // label changes what monitorCollector logs errors under, not the topic itself
  }
  res.redirect('/monitor');
});

// Wipes one monitor's recorded readings without deleting the monitor itself or touching any
// dashboard panel it's on — those just go back to showing "-" until the next reading comes in,
// same as a brand new monitor. For resetting a monitor's history (e.g. after moving a sensor),
// as opposed to /:id/delete which removes the monitor definition entirely.
router.post('/:id/clear-history', requirePermission('monitor', 'edit'), (req, res) => {
  db.prepare('DELETE FROM monitor_history WHERE monitor_id = ?').run(req.params.id);
  clearCurrentValue(Number(req.params.id));
  res.redirect(req.get('referer') || '/monitor');
});

router.post('/:id/delete', requirePermission('monitor', 'edit'), (req, res) => {
  db.prepare('DELETE FROM monitors WHERE id = ?').run(req.params.id);
  reloadMqttMonitors();
  res.redirect('/monitor');
});

// Bulk cleanup for monitors nothing actually references any more — e.g. ones a dashboard
// suggestion created that later had its panel removed, or a one-off "+ Monitor" click that was
// never turned into a widget. A monitor is "unused" here if no dashboard_panel_monitors row points
// at it; its own history rows go with it (monitor_history has no separate cleanup path otherwise).
router.post('/enable-all', requirePermission('monitor', 'edit'), (req, res) => {
  db.prepare('UPDATE monitors SET enabled = 1').run();
  reloadMqttMonitors();
  res.redirect('/monitor');
});

router.post('/disable-all', requirePermission('monitor', 'edit'), (req, res) => {
  db.prepare('UPDATE monitors SET enabled = 0').run();
  reloadMqttMonitors();
  res.redirect('/monitor');
});

router.post('/clear-unused', requirePermission('monitor', 'edit'), (req, res) => {
  db.prepare(
    `DELETE FROM monitors WHERE id NOT IN (SELECT DISTINCT monitor_id FROM dashboard_panel_monitors)`
  ).run();
  reloadMqttMonitors();
  res.redirect('/monitor');
});

// Full reset — unlike /clear-unused, this also removes monitors still referenced by a dashboard
// panel (the panel itself survives, just with nothing left to show, same as deleting one monitor
// at a time would do). A blunter tool, for starting over rather than routine cleanup.
router.post('/clear-all', requirePermission('monitor', 'edit'), (req, res) => {
  db.prepare('DELETE FROM monitors').run();
  reloadMqttMonitors();
  res.redirect('/monitor');
});

router.get('/loxone-structure/:miniserverId', async (req, res) => {
  const miniserver = db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.miniserverId);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  try {
    const states = await getMonitorableStates(miniserver, { forceRefresh: req.query.refresh === '1' });
    res.json({ states });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Multi-monitor time series for chart panels on a custom dashboard (see routes/dashboards.js) —
// registered before /:id so "series.json" isn't swallowed as a monitor id.
router.get('/series.json', (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
  if (ids.length === 0) return res.json({ series: [] });

  const range = resolveRange(req.query.range);
  const { sql: rangeSql, params: rangeParams } = historyWindowClause(range);
  const stmt = db.prepare(`SELECT recorded_at AS t, value, numeric_value AS numeric FROM monitor_history WHERE monitor_id = ?${rangeSql} ORDER BY recorded_at DESC LIMIT ?`);

  const series = ids.map((id) => {
    const monitor = db.prepare('SELECT id, label FROM monitors WHERE id = ?').get(id);
    if (!monitor) return null;
    const rows = stmt.all(id, ...rangeParams, MAX_ROWS);
    return { monitorId: id, label: monitor.label, rows };
  }).filter(Boolean);

  res.json({ series });
});

router.get('/:id', (req, res) => {
  const monitor = loadMonitor(req.params.id);
  if (!monitor) return res.status(404).send('Monitor not found');

  const range = resolveRange(req.query.range);
  const { sql: rangeSql, params: rangeParams } = historyWindowClause(range);

  const rows = db.prepare(`SELECT recorded_at AS recordedAt, value, numeric_value AS numericValue FROM monitor_history WHERE monitor_id = ?${rangeSql} ORDER BY recorded_at DESC LIMIT ?`).all(monitor.id, ...rangeParams, MAX_ROWS);

  const hasNumeric = rows.some((r) => r.numericValue !== null);

  res.render('monitor-detail', {
    monitor,
    range,
    rows,
    hasNumeric,
    truncated: rows.length >= MAX_ROWS,
  });
});

router.get('/:id/data.json', (req, res) => {
  const monitor = loadMonitor(req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Monitor not found' });

  const range = resolveRange(req.query.range);
  const { sql: rangeSql, params: rangeParams } = historyWindowClause(range);

  const rows = db.prepare(`SELECT recorded_at AS t, value, numeric_value AS numeric FROM monitor_history WHERE monitor_id = ?${rangeSql} ORDER BY recorded_at DESC LIMIT ?`).all(monitor.id, ...rangeParams, MAX_ROWS);

  res.json({ rows, truncated: rows.length >= MAX_ROWS });
});

router.get('/:id/export.csv', (req, res) => {
  const monitor = loadMonitor(req.params.id);
  if (!monitor) return res.status(404).send('Monitor not found');

  const range = resolveRange(req.query.range);
  const { sql: rangeSql, params: rangeParams } = historyWindowClause(range);

  const rows = db.prepare(`SELECT recorded_at AS recordedAt, value FROM monitor_history WHERE monitor_id = ?${rangeSql} ORDER BY recorded_at ASC`).all(monitor.id, ...rangeParams);

  const filename = `${monitor.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const lines = ['timestamp,value'];
  for (const row of rows) lines.push(`${csvField(row.recordedAt)},${csvField(row.value)}`);
  res.send(lines.join('\n'));
});

module.exports = router;
module.exports.RANGE_MS = RANGE_MS;
module.exports.rangeToSince = rangeToSince;
module.exports.rangeToWindow = rangeToWindow;
module.exports.historyWindowClause = historyWindowClause;
module.exports.resolveRange = resolveRange;
module.exports.buildAbsoluteRange = buildAbsoluteRange;
module.exports.MAX_ROWS = MAX_ROWS;
