const express = require('express');
const db = require('../db');
const { humanizeTopic } = require('../topicName');
const { getTopicOverview } = require('../mqttClient');
const { getMonitorableStates } = require('../loxoneStructure');
const {
  reloadMqttMonitors,
  getCurrentValue,
  clearCurrentValue,
  findOrCreateDiagMonitor,
  DIAG_FIELD_LABELS,
} = require('../monitorCollector');
const { requirePermission } = require('../middleware/requirePermission');
const { getDisplayTimezone, parseInTimezone } = require('../dateFormat');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// Bundle used by the Miniservers page's own "Add to Monitor" button (quick-add-diag below) — same
// three fields its "Add to Dashboard" sibling in routes/dashboards.js pins, just without also
// creating a dashboard panel. heap_total_kb is deliberately left out of both bundles: it's still
// reachable one-at-a-time via the manual Add-monitor form above, but as a near-constant value
// (Loxone doesn't document it changing) it's not worth a click on every quick-add.
const QUICK_ADD_DIAG_FIELDS = ['cpu_load', 'heap_value_kb', 'num_tasks'];

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

// A typed absolute date/time, D-M-YYYY (matching how this app's user actually writes dates) or
// plain ISO YYYY-MM-DD, either alone optionally followed by a time as "H:MM" — distinguished from
// the D-M-YYYY form by the first segment being 4 digits, so "1-8-2026" and "2026-08-01" are never
// ambiguous with each other regardless of which one a user happens to type.
const DMY_RE = /^(\d{1,2})-(\d{1,2})-(\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/;
const YMD_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/;

// One endpoint of a typed custom range — "now", or an absolute date/time interpreted in the
// gateway's configured display timezone (see dateFormat.js's parseInTimezone for why: a bare
// `new Date(...)` would silently read it as the server's own timezone, always UTC in Docker).
function parseRangeEndpoint(text, tz) {
  const s = text.trim();
  if (/^now$/i.test(s)) return Date.now();
  const dmy = s.match(DMY_RE);
  if (dmy) return parseInTimezone(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]), Number(dmy[4] || 0), Number(dmy[5] || 0), 0, tz);
  const ymd = s.match(YMD_RE);
  if (ymd) return parseInTimezone(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]), Number(ymd[4] || 0), Number(ymd[5] || 0), 0, tz);
  return null;
}

// Grafana-style typed absolute range for the Monitor detail page's own custom-range field: a
// single date ("1-8-2026" — that date until now) or two endpoints separated by "/" or "to"
// ("1-8-2026 / now", "1-8-2026 to 2-8-2026 14:30"). Returns the same abs_<start>_<end> format
// buildAbsoluteRange() already produces for the dashboard panel's own From/To picker, so nothing
// downstream (rangeToWindow, historyWindowClause, chooseGroupMode, ...) needs to know this exists.
function customAbsoluteRange(value, tz) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.split(/\s*(?:\/|\bto\b)\s*/i);
  if (parts.length > 2) return null;
  const startMs = parseRangeEndpoint(parts[0], tz);
  if (startMs == null) return null;
  const endMs = parts.length === 2 ? parseRangeEndpoint(parts[1], tz) : Date.now();
  if (endMs == null || endMs <= startMs) return null;
  return buildAbsoluteRange(startMs, endMs);
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
// custom duration string (e.g. "3h") that parses cleanly is passed through as-is. A typed
// absolute date ("1-8-2026", "1-8-2026 / now", ...) resolves to the same abs_<start>_<end> form
// an explicit From/To pick would have produced.
function resolveRange(value) {
  if (RANGE_MS[value] || value === 'all') return value;
  const absMatch = typeof value === 'string' ? value.match(ABS_RANGE_RE) : null;
  if (absMatch) return Number(absMatch[1]) < Number(absMatch[2]) ? value : '24h'; // reject inverted/zero-width
  if (customRangeMs(value)) return value;
  return customAbsoluteRange(value, getDisplayTimezone()) || '24h';
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

// Hour groups for a short/dense range (readings every few seconds over 1h/24h would otherwise be
// one endless flat list), day groups for anything longer (hour groups over 30d would just be
// hundreds of mostly-empty buckets instead of a useful overview).
function chooseGroupMode(range) {
  if (range === '1h' || range === '24h') return 'hour';
  // An absolute range's own span (e.g. the "1.5 days" a typed "1-8-2026 / now" resolves to)
  // wasn't considered here before absolute ranges could come from a typed date at all — every one
  // fell through to 'day' regardless of how short it actually was, same gap the dashboard panel's
  // own From/To picker already had. A short absolute span deserves hour groups exactly like an
  // equally-short relative one already gets, not just presets/custom-durations.
  const absMatch = typeof range === 'string' ? range.match(ABS_RANGE_RE) : null;
  const ms = absMatch ? Number(absMatch[2]) - Number(absMatch[1]) : (RANGE_MS[range] || customRangeMs(range));
  if (ms && ms <= 48 * 60 * 60 * 1000) return 'hour';
  return 'day';
}

// Buckets already-DESC-sorted history rows into calendar day/hour groups (in the configured
// display timezone, not server-local) — same shape the client-side live-refresh in
// monitor-chart.js rebuilds independently, so a group's key format must stay in sync with that.
function groupHistoryRows(rows, mode, tz, dateField) {
  const groups = [];
  let current = null;
  for (const row of rows) {
    const date = new Date(row[dateField]);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    // Node's ICU renders midnight as hour "24" (not "00") under hour12:false — normalize so
    // grouping/labels don't split midnight readings into their own inconsistent bucket.
    const hour = parts.hour === '24' ? '00' : parts.hour;
    const key = mode === 'hour' ? `${parts.year}-${parts.month}-${parts.day}-${hour}` : `${parts.year}-${parts.month}-${parts.day}`;
    if (!current || current.key !== key) {
      const label = mode === 'hour'
        ? `${parts.day}/${parts.month}/${parts.year}, ${hour}:00–${String((Number(hour) + 1) % 24).padStart(2, '0')}:00`
        : `${parts.day}/${parts.month}/${parts.year}`;
      current = { key, label, rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}

function csvField(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function loadMonitor(id) {
  return db
    .prepare(
      `SELECT monitors.*, miniservers.name AS miniserver_name
       FROM monitors LEFT JOIN miniservers ON miniservers.id = monitors.miniserver_id
       WHERE monitors.id = ?`
    )
    .get(id);
}

// SQLite/MySQL call this GROUP_CONCAT(...); Postgres has no such function at all — its own
// equivalent is STRING_AGG(expr, separator), with the separator a required explicit argument
// rather than an implicit default. A genuine function-NAME difference (not just punctuation), so
// unlike every other dialect fix in this app it can't be papered over with one shared SQL string —
// this is the one call site in the whole app that needs it.
function dashboardPairsExpr() {
  return db.getBackend() === 'postgres'
    ? "STRING_AGG(DISTINCT custom_dashboards.id || ':' || custom_dashboards.name, ',')"
    : "GROUP_CONCAT(DISTINCT custom_dashboards.id || ':' || custom_dashboards.name)";
}

router.get('/', asyncHandler(async (req, res) => {
  const { listAccessibleDashboardIds } = require('./dashboards');
  const accessibleDashboardIds = await listAccessibleDashboardIds(req.session.userId, req.user && req.user.roleId);
  const rawMonitors = await db
    .prepare(
      `SELECT monitors.*, miniservers.name AS miniserver_name,
              COUNT(DISTINCT dashboard_panel_monitors.panel_id) AS panelCount,
              ${dashboardPairsExpr()} AS dashboardPairs
       FROM monitors
       LEFT JOIN miniservers ON miniservers.id = monitors.miniserver_id
       LEFT JOIN dashboard_panel_monitors ON dashboard_panel_monitors.monitor_id = monitors.id
       LEFT JOIN dashboard_panels ON dashboard_panels.id = dashboard_panel_monitors.panel_id
       LEFT JOIN custom_dashboards ON custom_dashboards.id = dashboard_panels.dashboard_id
       GROUP BY monitors.id, miniservers.name
       ORDER BY monitors.label`
    )
    .all();
  const monitors = await Promise.all(rawMonitors.map(async (m) => {
    // Whether THIS monitor's own threshold ladder (its chart-settings config, edited from this
    // page — see notifications.js's checkThresholdLadderNotify) has at least one rung flagged
    // Notify — surfaced as its own column so this doesn't stay hidden until you happen to open
    // a monitor's own chart settings to look.
    let hasNotifyThreshold = false;
    try {
      const thresholds = JSON.parse(m.config || '{}').thresholds;
      hasNotifyThreshold = Array.isArray(thresholds) && thresholds.some((t) => t.notify);
    } catch { /* malformed config — treat as no notify threshold rather than erroring the whole list */ }
    // The query above has no ownership filter of its own (a monitor can be used on ANY
    // dashboard, not just this viewer's) — dropped here rather than in SQL so "My Dashboards"
    // and this page's own "Dashboard" column always agree on what's actually reachable, instead
    // of this page pointing at a dashboard the viewer would just get a 403 clicking through to.
    if (m.dashboardPairs) {
      m.dashboardPairs = m.dashboardPairs
        .split(',')
        .filter((pair) => accessibleDashboardIds.has(Number(pair.slice(0, pair.indexOf(':')))))
        .join(',') || null;
    }
    return { ...m, current: await getCurrentValue(m.id), hasNotifyThreshold };
  }));

  const miniservers = await db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
  const retention = await db.prepare('SELECT monitor_retention_days FROM gateway_settings WHERE id = 1').get();
  const unusedCount = monitors.filter((m) => m.panelCount === 0).length;
  const { getDefaultPanelDecimals } = require('./dashboards');

  res.render('monitor', {
    monitors,
    miniservers,
    knownTopics: getTopicOverview().map((t) => t.topic),
    retentionDays: retention.monitor_retention_days,
    unusedCount,
    prefillTopic: req.query.topic || '',
    DIAG_FIELD_LABELS,
    defaultPanelDecimals: await getDefaultPanelDecimals(),
    error: null,
  });
}));

router.post('/', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  const { source_type, label, topic, loxone_uuid, diag_field, poll_interval_ms } = req.body;
  // The Add form has two separate miniserver_id fields (one per source-type section, since only
  // one section is ever relevant at a time) — normally kept out of the submit by disabling
  // whichever one isn't active (monitor.ejs), but a request that somehow still carries both
  // (JS-disabled browser, hand-crafted request, ...) would otherwise reach the INSERT below as an
  // array and fail there with a much less clear "Too many parameter values were provided". Picking
  // the first non-empty value here means the form's own field-disabling is a UX nicety, not the
  // only thing standing between a slightly-unusual request and a confusing SQL error.
  const miniserver_id = Array.isArray(req.body.miniserver_id)
    ? req.body.miniserver_id.find((v) => v)
    : req.body.miniserver_id;

  try {
    if (source_type === 'mqtt') {
      if (!topic) throw new Error('MQTT topic is required.');
      await db.prepare(
        `INSERT INTO monitors (source_type, label, mqtt_topic, enabled, created_at)
         VALUES ('mqtt', ?, ?, 1, ?)`
      ).run(label || humanizeTopic(topic), topic, new Date().toISOString());
      await reloadMqttMonitors();
    } else if (source_type === 'loxone') {
      if (!miniserver_id || !loxone_uuid) throw new Error('Miniserver and state are required.');
      const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(miniserver_id);
      if (!miniserver) throw new Error('Miniserver not found.');

      let resolvedLabel = label;
      if (!resolvedLabel) {
        const states = await getMonitorableStates(miniserver);
        resolvedLabel = states.find((s) => s.uuid === loxone_uuid)?.label || loxone_uuid;
      }

      await db.prepare(
        `INSERT INTO monitors (source_type, label, miniserver_id, loxone_uuid, poll_interval_ms, enabled, created_at)
         VALUES ('loxone', ?, ?, ?, ?, 1, ?)`
      ).run(resolvedLabel, miniserver_id, loxone_uuid, Number(poll_interval_ms) || 10000, new Date().toISOString());
    } else if (source_type === 'miniserver_diag') {
      if (!miniserver_id || !diag_field) throw new Error('Miniserver and diagnostic field are required.');
      if (!DIAG_FIELD_LABELS[diag_field]) throw new Error('Unknown diagnostic field.');
      const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(miniserver_id);
      if (!miniserver) throw new Error('Miniserver not found.');

      await findOrCreateDiagMonitor(miniserver, diag_field, label);
    } else {
      throw new Error('Unknown source type.');
    }
    res.redirect('/monitor');
  } catch (err) {
    const rawMonitors = await db
      .prepare(
        `SELECT monitors.*, miniservers.name AS miniserver_name
         FROM monitors LEFT JOIN miniservers ON miniservers.id = monitors.miniserver_id
         ORDER BY monitors.label`
      )
      .all();
    const monitors = await Promise.all(rawMonitors.map(async (m) => ({ ...m, current: await getCurrentValue(m.id) })));
    const miniservers = await db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
    const retention = await db.prepare('SELECT monitor_retention_days FROM gateway_settings WHERE id = 1').get();
    const unusedCount = monitors.filter((m) => m.panelCount === 0).length;
    const { getDefaultPanelDecimals } = require('./dashboards');
    res.render('monitor', {
      monitors,
      miniservers,
      knownTopics: getTopicOverview().map((t) => t.topic),
      retentionDays: retention.monitor_retention_days,
      unusedCount,
      prefillTopic: '',
      DIAG_FIELD_LABELS,
      defaultPanelDecimals: await getDefaultPanelDecimals(),
      error: err.message,
    });
  }
}));

// Powers the Miniservers page's "Add to Monitor" button — same three diagnostic fields as that
// page's "Add to Dashboard" button (routes/dashboards.js), just without also pinning a panel: for
// when a value is worth tracking/charting but doesn't need to live on the Dashboard itself.
router.post('/quick-add-diag', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  const miniserverId = Number(req.body.miniserver_id);
  if (!miniserverId) return res.redirect('/miniservers');

  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(miniserverId);
  if (!miniserver) return res.redirect('/miniservers');

  for (const diagField of QUICK_ADD_DIAG_FIELDS) await findOrCreateDiagMonitor(miniserver, diagField);

  res.redirect('/monitor');
}));

router.post('/settings', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  const days = Number(req.body.monitor_retention_days);
  if (Number.isFinite(days) && days > 0) {
    await db.prepare('UPDATE gateway_settings SET monitor_retention_days = ? WHERE id = 1').run(Math.round(days));
  }
  // Referer-based (not a fixed '/monitor') since this form now lives on the Settings page —
  // same pattern already used by /logs/settings.
  res.redirect(req.get('referer') || '/monitor');
}));

router.post('/:id/toggle', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('UPDATE monitors SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  await reloadMqttMonitors();
  res.redirect('/monitor');
}));

router.post('/:id/update', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  const { label, poll_interval_ms } = req.body;
  const monitor = await db.prepare('SELECT * FROM monitors WHERE id = ?').get(req.params.id);
  if (!monitor) return res.redirect('/monitor');

  if (monitor.source_type === 'loxone') {
    await db.prepare('UPDATE monitors SET label = ?, poll_interval_ms = ? WHERE id = ?')
      .run(label || monitor.label, Number(poll_interval_ms) || monitor.poll_interval_ms, monitor.id);
  } else {
    await db.prepare('UPDATE monitors SET label = ? WHERE id = ?').run(label || monitor.label, monitor.id);
    await reloadMqttMonitors(); // label changes what monitorCollector logs errors under, not the topic itself
  }
  res.redirect('/monitor');
}));

// Wipes one monitor's recorded readings without deleting the monitor itself or touching any
// dashboard panel it's on — those just go back to showing "-" until the next reading comes in,
// same as a brand new monitor. For resetting a monitor's history (e.g. after moving a sensor),
// as opposed to /:id/delete which removes the monitor definition entirely.
router.post('/:id/clear-history', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM monitor_history WHERE monitor_id = ?').run(req.params.id);
  clearCurrentValue(Number(req.params.id));
  res.redirect(req.get('referer') || '/monitor');
}));

router.post('/:id/delete', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM monitors WHERE id = ?').run(req.params.id);
  await reloadMqttMonitors();
  res.redirect('/monitor');
}));

// Bulk cleanup for monitors nothing actually references any more — e.g. ones a dashboard
// suggestion created that later had its panel removed, or a one-off "+ Monitor" click that was
// never turned into a widget. A monitor is "unused" here if no dashboard_panel_monitors row points
// at it; its own history rows go with it (monitor_history has no separate cleanup path otherwise).
router.post('/enable-all', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('UPDATE monitors SET enabled = 1').run();
  await reloadMqttMonitors();
  res.redirect('/monitor');
}));

router.post('/disable-all', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('UPDATE monitors SET enabled = 0').run();
  await reloadMqttMonitors();
  res.redirect('/monitor');
}));

router.post('/clear-unused', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare(
    `DELETE FROM monitors WHERE id NOT IN (SELECT DISTINCT monitor_id FROM dashboard_panel_monitors)`
  ).run();
  await reloadMqttMonitors();
  res.redirect('/monitor');
}));

// Full reset — unlike /clear-unused, this also removes monitors still referenced by a dashboard
// panel (the panel itself survives, just with nothing left to show, same as deleting one monitor
// at a time would do). A blunter tool, for starting over rather than routine cleanup.
router.post('/clear-all', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM monitors').run();
  await reloadMqttMonitors();
  res.redirect('/monitor');
}));

router.get('/loxone-structure/:miniserverId', asyncHandler(async (req, res) => {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(req.params.miniserverId);
  if (!miniserver) return res.status(404).json({ error: 'Miniserver not found' });

  try {
    const states = await getMonitorableStates(miniserver, { forceRefresh: req.query.refresh === '1' });
    res.json({ states });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// Multi-monitor time series for chart panels on a custom dashboard (see routes/dashboards.js) —
// registered before /:id so "series.json" isn't swallowed as a monitor id.
router.get('/series.json', asyncHandler(async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
  if (ids.length === 0) return res.json({ series: [] });

  const range = resolveRange(req.query.range);
  const { sql: rangeSql, params: rangeParams } = historyWindowClause(range);
  const stmt = db.prepare(`SELECT recorded_at AS t, value, numeric_value AS numeric FROM monitor_history WHERE monitor_id = ?${rangeSql} ORDER BY recorded_at DESC LIMIT ?`);

  const series = (await Promise.all(ids.map(async (id) => {
    const monitor = await db.prepare('SELECT id, label FROM monitors WHERE id = ?').get(id);
    if (!monitor) return null;
    const rows = await stmt.all(id, ...rangeParams, MAX_ROWS);
    return { monitorId: id, label: monitor.label, rows };
  }))).filter(Boolean);

  res.json({ series });
}));

// Feeds the snapshot chart types (Polar Area/Doughnut/Pie/Radar/Bar-compare, see monitor-chart.js's
// renderSnapshot) — each of those shows one CURRENT value per monitor, not a history, so this
// skips the MAX_ROWS-bounded monitor_history scan series.json above does entirely and just reads
// whatever's already cached (getCurrentValue, the same cache/fallback insertHistory keeps warm for
// every monitor — see monitorCollector.js). registered before /:id for the same reason series.json
// is, just above.
router.get('/current.json', asyncHandler(async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
  if (ids.length === 0) return res.json({ values: [] });

  const values = (await Promise.all(ids.map(async (id) => {
    const monitor = await db.prepare('SELECT id, label FROM monitors WHERE id = ?').get(id);
    if (!monitor) return null;
    const current = await getCurrentValue(id);
    return { monitorId: id, label: monitor.label, value: current ? current.value : null, recordedAt: current ? current.recordedAt : null };
  }))).filter(Boolean);

  res.json({ values });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const monitor = await loadMonitor(req.params.id);
  if (!monitor) return res.status(404).send('Monitor not found');

  const range = resolveRange(req.query.range);
  const { sql: rangeSql, params: rangeParams } = historyWindowClause(range);
  // Only the range's fixed END is passed to the view (see rangeUntilMs in monitor-chart.js) — the
  // chart's own left edge auto-scales to the earliest surviving data point instead of this range's
  // nominal start, so a monitor that hasn't been running the full range (or has more history than
  // monitor_history's MAX_ROWS cap keeps) doesn't leave a big blank gap eating most of the chart.
  const { until } = rangeToWindow(range);

  const rows = await db.prepare(`SELECT recorded_at AS recordedAt, value, numeric_value AS numericValue FROM monitor_history WHERE monitor_id = ?${rangeSql} ORDER BY recorded_at DESC LIMIT ?`).all(monitor.id, ...rangeParams, MAX_ROWS);

  const hasNumeric = rows.some((r) => r.numericValue !== null);
  const groupMode = chooseGroupMode(range);
  const groups = groupHistoryRows(rows, groupMode, res.locals.displayTimezone, 'recordedAt');

  // Lazily required (not at module top) — routes/dashboards.js itself requires this module for
  // resolveRange/historyWindowClause/etc., so a top-level require here would be circular and could
  // hand dashboards.js this module's exports before they're all assigned. By the time any request
  // is actually being handled the whole app has already finished its startup require() pass, so
  // this always resolves to the real, fully-loaded module — see server.js for the load order this
  // depends on.
  const { getDefaultPanelDecimals } = require('./dashboards');
  let config;
  try { config = JSON.parse(monitor.config || '{}'); } catch (e) { config = {}; }
  const chartDefaultRow = await db.prepare('SELECT monitor_chart_default_config FROM gateway_settings WHERE id = 1').get();
  const chartDefaultExists = !!chartDefaultRow && chartDefaultRow.monitor_chart_default_config !== '{}';

  res.render('monitor-detail', {
    monitor,
    config,
    current: await getCurrentValue(monitor.id),
    chartDefaultExists,
    defaultPanelDecimals: await getDefaultPanelDecimals(),
    range,
    rows,
    groups,
    groupMode,
    hasNumeric,
    truncated: rows.length >= MAX_ROWS,
    rangeUntilMs: until ? new Date(until).getTime() : null,
    DIAG_FIELD_LABELS,
  });
}));

// Saves the Monitor detail page's own chart display settings (legend, fill/stepped/curve, y-axis,
// zoom, thresholds, annotations) — same buildConfig('chart', ...) shape/parsing a dashboard chart
// panel's Edit form already submits (see panel-grid.ejs's chart-fields block), just persisted on
// the monitor itself instead of a dashboard_panels row since this page has no panel of its own.
// chart_type/chart_series are never submitted from this page's own form, so buildConfig defaults
// them to 'line'/{} — this page is always a single-monitor line chart, by design (see the chart
// capabilities plan: snapshot types are N-monitor comparisons and don't fit a single-monitor page).
router.post('/:id/chart-settings', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  const monitor = await db.prepare('SELECT id FROM monitors WHERE id = ?').get(req.params.id);
  if (!monitor) return res.redirect('/monitor');

  // This page has no per-series builder of its own (see monitor-detail.ejs) — its Y-axis unit,
  // Value scale, and Decimals fields synthesize the one chart_series entry buildConfig('chart', ...)
  // already knows how to parse (see parseSeriesConfig in routes/dashboards.js), keyed by this
  // monitor's own id, rather than reintroducing a parallel panel-wide concept dashboards.js removed
  // in favor of per-series for scale/decimals. Unit joins them here too (unlike legendPosition/fill/
  // stepped/etc, which stay genuinely panel-wide) — a Monitor's own reading is a specific physical
  // quantity, so unlike a shared line style, one unit is never meaningfully "the same for every
  // monitor" the way "Save as default" below assumes for the rest of this config. body.unit_chart
  // is cleared after reading it so buildConfig's own panel-wide config.unit stays null for this
  // page — the per-series entry is the only place it's stored going forward. Deliberately NOT done
  // in save-as-default below: that config is shared across every monitor, and a chart_series entry
  // keyed by THIS monitor's id would silently never match any other monitor's id once applied via
  // "Reset to default" there.
  const { buildConfig, parseValueMappings } = require('./dashboards');
  const scale = Number(req.body.monitor_scale);
  const decimals = Number(req.body.monitor_decimals);
  const unit = typeof req.body.unit_chart === 'string' ? req.body.unit_chart.trim() : '';
  const valueLabels = parseValueMappings(req.body.monitor_value_labels);
  const seriesEntry = {};
  if (unit) seriesEntry.unit = unit;
  if (Number.isFinite(scale) && scale !== 0 && scale !== 1) seriesEntry.scale = scale;
  if (req.body.monitor_decimals !== '' && Number.isFinite(decimals)) seriesEntry.decimals = decimals;
  if (valueLabels.length) seriesEntry.valueLabels = valueLabels;
  req.body.chart_series = Object.keys(seriesEntry).length ? JSON.stringify({ [monitor.id]: seriesEntry }) : '{}';
  req.body.unit_chart = '';
  const config = buildConfig('chart', req.body);
  await db.prepare('UPDATE monitors SET config = ? WHERE id = ?').run(JSON.stringify(config), monitor.id);
  res.redirect(req.get('referer') || `/monitor/${monitor.id}`);
}));

// Saves whatever this monitor's chart-settings form currently has entered (its live values —
// submitted the same way the main Save button's form does, via formaction, regardless of whether
// Save itself was clicked first) as the ONE shared chart style every monitor's own "Reset to
// default" applies. Global rather than per-monitor: this page has no dashboard to scope a default
// by the way panel_type_defaults does, and the user explicitly wants one style for every monitor.
router.post('/:id/chart-settings/save-as-default', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  const { buildConfig } = require('./dashboards');
  const config = buildConfig('chart', req.body);
  await db.prepare('UPDATE gateway_settings SET monitor_chart_default_config = ? WHERE id = 1').run(JSON.stringify(config));
  res.redirect(req.get('referer') || `/monitor/${req.params.id}`);
}));

router.post('/:id/chart-settings/reset-to-default', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  const monitor = await db.prepare('SELECT id FROM monitors WHERE id = ?').get(req.params.id);
  if (!monitor) return res.redirect('/monitor');

  const row = await db.prepare('SELECT monitor_chart_default_config FROM gateway_settings WHERE id = 1').get();
  if (row && row.monitor_chart_default_config !== '{}') {
    await db.prepare('UPDATE monitors SET config = ? WHERE id = ?').run(row.monitor_chart_default_config, monitor.id);
  }
  res.redirect(req.get('referer') || `/monitor/${monitor.id}`);
}));

router.get('/:id/data.json', asyncHandler(async (req, res) => {
  const monitor = await loadMonitor(req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Monitor not found' });

  const range = resolveRange(req.query.range);
  const { sql: rangeSql, params: rangeParams } = historyWindowClause(range);

  const rows = await db.prepare(`SELECT recorded_at AS t, value, numeric_value AS numeric FROM monitor_history WHERE monitor_id = ?${rangeSql} ORDER BY recorded_at DESC LIMIT ?`).all(monitor.id, ...rangeParams, MAX_ROWS);

  res.json({ rows, truncated: rows.length >= MAX_ROWS });
}));

router.get('/:id/export.csv', asyncHandler(async (req, res) => {
  const monitor = await loadMonitor(req.params.id);
  if (!monitor) return res.status(404).send('Monitor not found');

  const range = resolveRange(req.query.range);
  const { sql: rangeSql, params: rangeParams } = historyWindowClause(range);

  const rows = await db.prepare(`SELECT recorded_at AS recordedAt, value FROM monitor_history WHERE monitor_id = ?${rangeSql} ORDER BY recorded_at ASC`).all(monitor.id, ...rangeParams);

  const filename = `${monitor.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const lines = ['timestamp,value'];
  for (const row of rows) lines.push(`${csvField(row.recordedAt)},${csvField(row.value)}`);
  res.send(lines.join('\n'));
}));

module.exports = router;
module.exports.RANGE_MS = RANGE_MS;
module.exports.rangeToSince = rangeToSince;
module.exports.rangeToWindow = rangeToWindow;
module.exports.historyWindowClause = historyWindowClause;
module.exports.resolveRange = resolveRange;
module.exports.buildAbsoluteRange = buildAbsoluteRange;
module.exports.MAX_ROWS = MAX_ROWS;
