const express = require('express');
const db = require('../db');
const { getCurrentValue, reloadMqttMonitors } = require('../monitorCollector');
const { humanizeTopic } = require('../topicName');
const { resolveRange, rangeToSince, MAX_ROWS } = require('./monitor');

const router = express.Router();

const PANEL_TYPES = ['chart', 'table', 'value', 'gauge', 'stat_delta', 'threshold'];
const SINGLE_MONITOR_TYPES = ['table', 'gauge', 'stat_delta', 'threshold'];
const THRESHOLD_OPERATORS = ['gt', 'gte', 'lt', 'lte'];
const LEGEND_POSITIONS = ['auto', 'top', 'left', 'right', 'off'];
const MIN_COL_SPAN = 2;
const MAX_COL_SPAN = 12;
const MIN_ROW_SPAN = 2;
const MAX_ROW_SPAN = 8;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Type-specific settings live in one JSON `config` column rather than a pile of nullable columns
// (see the migrateDashboardPanelConfig comment in db.js) — this is the only place that reads or
// writes its shape.
//
// Each panel type gets its own uniquely-named "unit" field (unit_chart, unit_gauge, ...) rather
// than sharing one `name="unit"` — the settings form renders every type's fields at once and just
// CSS-hides the ones that don't apply, so a shared name would submit as an array (one value per
// still-present field) and crash the `.trim()` call below. fieldStr defends the same way against
// any future field that accidentally ends up duplicated: take the first value instead of throwing.
function fieldStr(value) {
  return ((Array.isArray(value) ? value[0] : value) || '').toString().trim();
}

function clampDecimals(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 2;
  return Math.min(6, Math.max(0, Math.round(n)));
}

function buildConfig(panelType, body) {
  if (panelType === 'chart') {
    return {
      legendPosition: LEGEND_POSITIONS.includes(body.legend_position) ? body.legend_position : 'auto',
      unit: fieldStr(body.unit_chart),
      decimals: clampDecimals(body.decimals),
    };
  }
  if (panelType === 'value') {
    return { layout: body.value_layout === 'row' ? 'row' : 'stacked' };
  }
  if (panelType === 'gauge') {
    const min = Number(body.gauge_min);
    const max = Number(body.gauge_max);
    return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 100, unit: fieldStr(body.unit_gauge) };
  }
  if (panelType === 'stat_delta') {
    const direction = ['up_good', 'down_good'].includes(body.direction) ? body.direction : 'neutral';
    return { unit: fieldStr(body.unit_stat_delta), direction };
  }
  if (panelType === 'threshold') {
    const value = Number(body.threshold_value);
    return {
      operator: THRESHOLD_OPERATORS.includes(body.threshold_operator) ? body.threshold_operator : 'gt',
      value: Number.isFinite(value) ? value : 0,
      unit: fieldStr(body.unit_threshold),
      labelOk: fieldStr(body.label_ok) || 'Normal',
      labelAlert: fieldStr(body.label_alert) || 'Alert',
    };
  }
  return {};
}

function evaluateThreshold(numeric, config) {
  if (numeric === null || !Number.isFinite(numeric)) return false;
  switch (config.operator) {
    case 'gte': return numeric >= config.value;
    case 'lt': return numeric < config.value;
    case 'lte': return numeric <= config.value;
    default: return numeric > config.value; // 'gt'
  }
}

// Dashboards are mostly per-user (My Dashboards), but exactly one is shared: the home Dashboard,
// a custom_dashboards row with user_id = NULL, editable by anyone with the `dashboard` Access Role
// area (see permissionAreas.js) rather than by ownership. Every handler below loads through
// loadAccessibleDashboard (never trusts the :id alone) and, for anything that mutates, additionally
// checks canMutate — personal dashboards need no Access Role check at all (ownership is enough), only
// the shared one does.
function loadAccessibleDashboard(id, req) {
  const dashboard = db.prepare('SELECT * FROM custom_dashboards WHERE id = ?').get(id);
  if (!dashboard) return null;
  if (dashboard.user_id === req.session.userId || dashboard.user_id === null) return dashboard;
  return null; // someone else's personal dashboard
}

function isShared(dashboard) {
  return dashboard.user_id === null;
}

function canMutate(dashboard, req) {
  if (dashboard.user_id === req.session.userId) return true;
  return isShared(dashboard) && !!req.user && (req.user.isAdmin || !!req.user.permissions.dashboard?.edit);
}

function canViewShared(dashboard, req) {
  if (!isShared(dashboard)) return true;
  return !!req.user && (req.user.isAdmin || !!req.user.permissions.dashboard?.view);
}

function forbidden(res) {
  return res.status(403).render('forbidden', { area: 'dashboard' });
}

function dashboardUrl(dashboard) {
  return isShared(dashboard) ? '/' : `/dashboards/${dashboard.id}`;
}

// The "Widget" quick-add button on Live Traffic (see incoming-messages.ejs) posts a raw topic
// here — it needs a monitor to point a panel at, so it finds-or-creates one for that exact topic
// (same shape the Monitor page's own "add" form and the old widget→panel migration in db.js both
// use) before pinning a value panel for it on the shared home Dashboard.
router.post('/quick-add-topic', (req, res) => {
  if (!(req.user && (req.user.isAdmin || req.user.permissions.dashboard?.edit))) return forbidden(res);

  const topic = (req.body.topic || '').trim();
  const sharedDashboard = db.prepare('SELECT * FROM custom_dashboards WHERE user_id IS NULL LIMIT 1').get();
  if (!topic || !sharedDashboard) return res.redirect('/incoming/messages');

  let monitor = db.prepare("SELECT id FROM monitors WHERE source_type = 'mqtt' AND mqtt_topic = ?").get(topic);
  let monitorId = monitor?.id;
  if (!monitorId) {
    monitorId = db.prepare("INSERT INTO monitors (source_type, label, mqtt_topic, enabled, created_at) VALUES ('mqtt', ?, ?, 1, ?)")
      .run(humanizeTopic(topic), topic, new Date().toISOString()).lastInsertRowid;
    reloadMqttMonitors(); // start recording this topic's history immediately, not just from the next gateway restart
  }

  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM dashboard_panels WHERE dashboard_id = ?').get(sharedDashboard.id).m;
  const panelId = db.prepare(
    `INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, position) VALUES (?, 'value', ?, '24h', '{"layout":"stacked"}', ?)`
  ).run(sharedDashboard.id, humanizeTopic(topic), maxPos + 1).lastInsertRowid;
  db.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, 0)').run(panelId, monitorId);

  res.redirect('/');
});

function loadPanelsWithMonitors(dashboardId) {
  const panels = db.prepare('SELECT * FROM dashboard_panels WHERE dashboard_id = ? ORDER BY position').all(dashboardId);
  const monitorsStmt = db.prepare(
    `SELECT monitors.* FROM dashboard_panel_monitors dpm
     JOIN monitors ON monitors.id = dpm.monitor_id
     WHERE dpm.panel_id = ? ORDER BY dpm.position`
  );

  return panels.map((panel) => {
    const monitors = monitorsStmt.all(panel.id);
    const config = JSON.parse(panel.config || '{}');
    const base = { ...panel, config, monitors };

    if (panel.panel_type === 'value') {
      return { ...base, monitors: monitors.map((m) => ({ ...m, current: getCurrentValue(m.id) })) };
    }

    if (panel.panel_type === 'table') {
      const monitor = monitors[0] || null;
      const since = rangeToSince(panel.range);
      const rows = monitor
        ? (since
            ? db.prepare('SELECT recorded_at AS recordedAt, value FROM monitor_history WHERE monitor_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?').all(monitor.id, since, MAX_ROWS)
            : db.prepare('SELECT recorded_at AS recordedAt, value FROM monitor_history WHERE monitor_id = ? ORDER BY recorded_at DESC LIMIT ?').all(monitor.id, MAX_ROWS))
        : [];
      return { ...base, rows };
    }

    if (panel.panel_type === 'gauge' || panel.panel_type === 'threshold') {
      const monitor = monitors[0] || null;
      const current = monitor ? getCurrentValue(monitor.id) : null;
      const numeric = current ? Number(current.value) : null;
      const hasNumeric = Number.isFinite(numeric);

      if (panel.panel_type === 'gauge') {
        const { min, max } = config;
        const percent = hasNumeric && max > min ? Math.min(100, Math.max(0, ((numeric - min) / (max - min)) * 100)) : null;
        return { ...base, monitor, current, percent };
      }
      return { ...base, monitor, current, isAlert: evaluateThreshold(hasNumeric ? numeric : null, config) };
    }

    if (panel.panel_type === 'stat_delta') {
      const monitor = monitors[0] || null;
      const current = monitor ? getCurrentValue(monitor.id) : null;
      let comparison = null;
      if (monitor) {
        const since = rangeToSince(panel.range);
        comparison = since
          ? db.prepare('SELECT numeric_value AS numericValue FROM monitor_history WHERE monitor_id = ? AND recorded_at >= ? ORDER BY recorded_at ASC LIMIT 1').get(monitor.id, since)
          : db.prepare('SELECT numeric_value AS numericValue FROM monitor_history WHERE monitor_id = ? ORDER BY recorded_at ASC LIMIT 1').get(monitor.id);
      }
      const currentNumeric = current ? Number(current.value) : null;
      const comparisonNumeric = comparison ? comparison.numericValue : null;
      const delta = Number.isFinite(currentNumeric) && Number.isFinite(comparisonNumeric) ? currentNumeric - comparisonNumeric : null;
      return { ...base, monitor, current, delta };
    }

    return base; // chart: rendered client-side via /monitor/series.json
  });
}

router.get('/', (req, res) => {
  const dashboards = db
    .prepare(
      `SELECT custom_dashboards.*, COUNT(dashboard_panels.id) AS panelCount
       FROM custom_dashboards LEFT JOIN dashboard_panels ON dashboard_panels.dashboard_id = custom_dashboards.id
       WHERE custom_dashboards.user_id = ?
       GROUP BY custom_dashboards.id ORDER BY custom_dashboards.position, custom_dashboards.id`
    )
    .all(req.session.userId);

  res.render('dashboards', { dashboards, error: null });
});

router.post('/', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    const dashboards = db
      .prepare(
        `SELECT custom_dashboards.*, COUNT(dashboard_panels.id) AS panelCount
         FROM custom_dashboards LEFT JOIN dashboard_panels ON dashboard_panels.dashboard_id = custom_dashboards.id
         WHERE custom_dashboards.user_id = ?
         GROUP BY custom_dashboards.id ORDER BY custom_dashboards.position, custom_dashboards.id`
      )
      .all(req.session.userId);
    return res.render('dashboards', { dashboards, error: 'Name is required.' });
  }

  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM custom_dashboards WHERE user_id = ?').get(req.session.userId).m;
  const result = db
    .prepare('INSERT INTO custom_dashboards (user_id, name, position, created_at) VALUES (?, ?, ?, ?)')
    .run(req.session.userId, name, maxPos + 1, new Date().toISOString());

  res.redirect(`/dashboards/${result.lastInsertRowid}`);
});

router.post('/:id/rename', (req, res) => {
  const dashboard = loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canMutate(dashboard, req)) return forbidden(res);

  const name = (req.body.name || '').trim();
  if (name) db.prepare('UPDATE custom_dashboards SET name = ? WHERE id = ?').run(name, dashboard.id);
  res.redirect(isShared(dashboard) ? '/' : '/dashboards');
});

router.post('/:id/delete', (req, res) => {
  const dashboard = loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (isShared(dashboard)) return forbidden(res); // the shared home Dashboard can't be deleted, only its panels
  if (!canMutate(dashboard, req)) return forbidden(res);

  db.prepare('DELETE FROM custom_dashboards WHERE id = ?').run(dashboard.id);
  res.redirect('/dashboards');
});

router.get('/:id', (req, res) => {
  const dashboard = loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canViewShared(dashboard, req)) return forbidden(res);

  const monitors = db.prepare('SELECT id, label, source_type FROM monitors ORDER BY label').all();
  const panels = loadPanelsWithMonitors(dashboard.id);

  res.render('dashboard-detail', { dashboard, panels, monitors, error: null, canEditPanels: canMutate(dashboard, req) });
});

router.post('/:id/panels', (req, res) => {
  const dashboard = loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canMutate(dashboard, req)) return forbidden(res);

  const panelType = PANEL_TYPES.includes(req.body.panel_type) ? req.body.panel_type : null;
  const range = resolveRange(req.body.range);
  let monitorIds = Array.isArray(req.body.monitor_ids) ? req.body.monitor_ids : (req.body.monitor_ids ? [req.body.monitor_ids] : []);
  monitorIds = monitorIds.map(Number).filter(Number.isInteger);
  if (SINGLE_MONITOR_TYPES.includes(panelType)) monitorIds = monitorIds.slice(0, 1); // one number in, one number out

  if (!panelType || monitorIds.length === 0) {
    // Shared (home) and personal dashboards render through different pages (dashboard.ejs needs a
    // lot of home-page-only context this route doesn't have), so a validation failure here just
    // redirects back rather than trying to re-render the right one inline with an error message.
    return res.redirect(dashboardUrl(dashboard));
  }

  const config = JSON.stringify(buildConfig(panelType, req.body));
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM dashboard_panels WHERE dashboard_id = ?').get(dashboard.id).m;

  const insertPanel = db.transaction(() => {
    const result = db
      .prepare('INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, position) VALUES (?, ?, ?, ?, ?, ?)')
      .run(dashboard.id, panelType, req.body.title || null, range, config, maxPos + 1);
    const panelId = result.lastInsertRowid;
    const insertMonitor = db.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, ?)');
    monitorIds.forEach((monitorId, index) => insertMonitor.run(panelId, monitorId, index));
  });
  insertPanel();

  res.redirect(dashboardUrl(dashboard));
});

router.post('/:id/panels/:panelId/settings', (req, res) => {
  const dashboard = loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canMutate(dashboard, req)) return forbidden(res);

  const panel = db.prepare('SELECT panel_type FROM dashboard_panels WHERE id = ? AND dashboard_id = ?').get(req.params.panelId, dashboard.id);
  if (!panel) return res.status(404).send('Panel not found');

  // Switching type is optional here (the field defaults to the panel's own current type when absent).
  const panelType = PANEL_TYPES.includes(req.body.panel_type) ? req.body.panel_type : panel.panel_type;
  const range = resolveRange(req.body.range);
  const config = JSON.stringify(buildConfig(panelType, req.body));

  let monitorIds = Array.isArray(req.body.monitor_ids) ? req.body.monitor_ids : (req.body.monitor_ids ? [req.body.monitor_ids] : []);
  monitorIds = monitorIds.map(Number).filter(Number.isInteger);
  if (SINGLE_MONITOR_TYPES.includes(panelType)) monitorIds = monitorIds.slice(0, 1);

  const updatePanel = db.transaction(() => {
    db.prepare('UPDATE dashboard_panels SET panel_type = ?, title = ?, range = ?, config = ? WHERE id = ? AND dashboard_id = ?')
      .run(panelType, req.body.title || null, range, config, req.params.panelId, dashboard.id);
    db.prepare('DELETE FROM dashboard_panel_monitors WHERE panel_id = ?').run(req.params.panelId);
    const insertMonitor = db.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, ?)');
    monitorIds.forEach((monitorId, index) => insertMonitor.run(req.params.panelId, monitorId, index));
  });
  updatePanel();

  res.redirect(dashboardUrl(dashboard));
});

router.post('/:id/panels/:panelId/duplicate', (req, res) => {
  const dashboard = loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canMutate(dashboard, req)) return forbidden(res);

  const panel = db.prepare('SELECT * FROM dashboard_panels WHERE id = ? AND dashboard_id = ?').get(req.params.panelId, dashboard.id);
  if (!panel) return res.status(404).send('Panel not found');
  const monitorIds = db.prepare('SELECT monitor_id FROM dashboard_panel_monitors WHERE panel_id = ? ORDER BY position').all(panel.id).map((r) => r.monitor_id);

  const duplicatePanel = db.transaction(() => {
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM dashboard_panels WHERE dashboard_id = ?').get(dashboard.id).m;
    const result = db
      .prepare('INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, position, col_span, row_span) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(dashboard.id, panel.panel_type, panel.title ? `${panel.title} (copy)` : null, panel.range, panel.config, maxPos + 1, panel.col_span, panel.row_span);
    const newPanelId = result.lastInsertRowid;
    const insertMonitor = db.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, ?)');
    monitorIds.forEach((monitorId, index) => insertMonitor.run(newPanelId, monitorId, index));
  });
  duplicatePanel();

  res.redirect(dashboardUrl(dashboard));
});

// Fired on resize-drag mouseup (see dashboard-detail.ejs) — sizing is otherwise entirely
// drag-driven, no form for it.
router.post('/:id/panels/:panelId/resize', (req, res) => {
  const dashboard = loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).json({ error: 'Dashboard not found' });
  if (!canMutate(dashboard, req)) return res.status(403).json({ error: 'Not authorized' });

  const colSpan = clamp(req.body.colSpan, MIN_COL_SPAN, MAX_COL_SPAN, 4);
  const rowSpan = clamp(req.body.rowSpan, MIN_ROW_SPAN, MAX_ROW_SPAN, 3);

  db.prepare('UPDATE dashboard_panels SET col_span = ?, row_span = ? WHERE id = ? AND dashboard_id = ?')
    .run(colSpan, rowSpan, req.params.panelId, dashboard.id);

  res.json({ ok: true, colSpan, rowSpan });
});

router.post('/:id/panels/:panelId/delete', (req, res) => {
  const dashboard = loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canMutate(dashboard, req)) return forbidden(res);

  db.prepare('DELETE FROM dashboard_panels WHERE id = ? AND dashboard_id = ?').run(req.params.panelId, dashboard.id);
  res.redirect(dashboardUrl(dashboard));
});

router.post('/:id/panels/reorder', (req, res) => {
  const dashboard = loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).json({ error: 'Dashboard not found' });
  if (!canMutate(dashboard, req)) return res.status(403).json({ error: 'Not authorized' });

  const order = Array.isArray(req.body.order) ? req.body.order : [];
  const stmt = db.prepare('UPDATE dashboard_panels SET position = ? WHERE id = ? AND dashboard_id = ?');
  const applyOrder = db.transaction((ids) => {
    ids.forEach((id, index) => stmt.run(index, id, dashboard.id));
  });
  applyOrder(order);
  res.json({ ok: true });
});

module.exports = router;
module.exports.loadPanelsWithMonitors = loadPanelsWithMonitors;
