const express = require('express');
const db = require('../db');
const { humanizeTopic } = require('../topicName');
const { getTopicOverview } = require('../mqttClient');
const { getMonitorableStates } = require('../loxoneStructure');
const { reloadMqttMonitors, getCurrentValue } = require('../monitorCollector');
const { requirePermission } = require('../middleware/requirePermission');

const router = express.Router();

const RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};
const MAX_ROWS = 2000;

function rangeToSince(range) {
  const ms = RANGE_MS[range];
  return ms ? new Date(Date.now() - ms).toISOString() : null;
}

// Missing/unrecognized -> '24h'; 'all' is a valid range in its own right (rangeToSince('all')
// correctly falls through to null, i.e. no lower bound) and must not be coerced away.
function resolveRange(value) {
  return RANGE_MS[value] || value === 'all' ? value : '24h';
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
  res.redirect('/monitor');
});

router.post('/:id/toggle', requirePermission('monitor', 'edit'), (req, res) => {
  db.prepare('UPDATE monitors SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  reloadMqttMonitors();
  res.redirect('/monitor');
});

router.post('/:id/delete', requirePermission('monitor', 'edit'), (req, res) => {
  db.prepare('DELETE FROM monitors WHERE id = ?').run(req.params.id);
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
  const since = rangeToSince(range);

  const stmt = since
    ? db.prepare('SELECT recorded_at AS t, value, numeric_value AS numeric FROM monitor_history WHERE monitor_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?')
    : db.prepare('SELECT recorded_at AS t, value, numeric_value AS numeric FROM monitor_history WHERE monitor_id = ? ORDER BY recorded_at DESC LIMIT ?');

  const series = ids.map((id) => {
    const monitor = db.prepare('SELECT id, label FROM monitors WHERE id = ?').get(id);
    if (!monitor) return null;
    const rows = since ? stmt.all(id, since, MAX_ROWS) : stmt.all(id, MAX_ROWS);
    return { monitorId: id, label: monitor.label, rows };
  }).filter(Boolean);

  res.json({ series });
});

router.get('/:id', (req, res) => {
  const monitor = loadMonitor(req.params.id);
  if (!monitor) return res.status(404).send('Monitor not found');

  const range = resolveRange(req.query.range);
  const since = rangeToSince(range);

  const rows = since
    ? db.prepare('SELECT recorded_at AS recordedAt, value, numeric_value AS numericValue FROM monitor_history WHERE monitor_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?').all(monitor.id, since, MAX_ROWS)
    : db.prepare('SELECT recorded_at AS recordedAt, value, numeric_value AS numericValue FROM monitor_history WHERE monitor_id = ? ORDER BY recorded_at DESC LIMIT ?').all(monitor.id, MAX_ROWS);

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
  const since = rangeToSince(range);

  const rows = since
    ? db.prepare('SELECT recorded_at AS t, value, numeric_value AS numeric FROM monitor_history WHERE monitor_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?').all(monitor.id, since, MAX_ROWS)
    : db.prepare('SELECT recorded_at AS t, value, numeric_value AS numeric FROM monitor_history WHERE monitor_id = ? ORDER BY recorded_at DESC LIMIT ?').all(monitor.id, MAX_ROWS);

  res.json({ rows, truncated: rows.length >= MAX_ROWS });
});

router.get('/:id/export.csv', (req, res) => {
  const monitor = loadMonitor(req.params.id);
  if (!monitor) return res.status(404).send('Monitor not found');

  const range = RANGE_MS[req.query.range] ? req.query.range : null;
  const since = range ? rangeToSince(range) : null;

  const rows = since
    ? db.prepare('SELECT recorded_at AS recordedAt, value FROM monitor_history WHERE monitor_id = ? AND recorded_at >= ? ORDER BY recorded_at ASC').all(monitor.id, since)
    : db.prepare('SELECT recorded_at AS recordedAt, value FROM monitor_history WHERE monitor_id = ? ORDER BY recorded_at ASC').all(monitor.id);

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
module.exports.resolveRange = resolveRange;
module.exports.MAX_ROWS = MAX_ROWS;
