const db = require('./db');

// Only chart/value panels have a per-monitor `series` map in their config (see buildConfig() in
// routes/dashboards.js) — gauge/stat_delta/threshold/table are a single/aggregate value with no
// per-monitor breakdown to remap, so their whole config can be saved/restored as-is.
const SERIES_KEYED_TYPES = ['chart', 'value'];

// A saved "house style" is keyed by panel_type alone everywhere EXCEPT chart panels, which fold
// their own chartType into the key ('chart:line', 'chart:polar_area', ...) — a Line house style
// and a Polar Area one are different enough (different config shape, different meaningful fields)
// that conflating them under one 'chart' key would mean saving one silently overwrites the other.
// panel_type_defaults.panel_type has no CHECK constraint (plain TEXT, see db.js) — a compound
// string needs no migration, just this one place computing it consistently both ways.
function defaultsKey(panelType, config) {
  return panelType === 'chart' ? `chart:${config.chartType || 'line'}` : panelType;
}

async function getPanelMonitorIdsInOrder(panelId) {
  const rows = await db.prepare('SELECT monitor_id FROM dashboard_panel_monitors WHERE panel_id = ? ORDER BY position').all(panelId);
  return rows.map((r) => r.monitor_id);
}

// A panel's own `series` is keyed by monitor id, which a reusable template can't know in advance
// — converted here into a position-ordered array instead ("line 1" = whichever monitor is first
// in THIS panel right now), using the panel's own current monitor order at the moment "Save as
// default" is clicked.
function toPositional(config, monitorIds) {
  if (!config.series) return config;
  const seriesByPosition = monitorIds.map((id) => config.series[String(id)] || null);
  const { series, ...rest } = config;
  return { ...rest, seriesByPosition };
}

// Reverse of toPositional() — rebuilds an id-keyed series object for a target panel (which may
// have entirely different monitors than whichever panel the template was saved from), mapping the
// template's position-ordered entries onto THAT panel's own current monitor order. Fewer monitors
// than the template just uses fewer entries; more monitors than the template leaves the extras
// unset, same as a monitor added after a panel's own series config was last touched.
function fromPositional(config, monitorIds) {
  if (!config.seriesByPosition) return config;
  const series = {};
  monitorIds.forEach((id, i) => {
    if (config.seriesByPosition[i]) series[id] = config.seriesByPosition[i];
  });
  const { seriesByPosition, ...rest } = config;
  return { ...rest, series };
}

// Saves panelId's CURRENT config as the house style for its panel_type, scoped to whichever
// dashboard panelId lives on — a chart's "look" on the home Dashboard doesn't have to match one on
// someone's personal board. One row per (dashboard, panel_type), overwriting whatever was saved
// before for that same pair.
async function saveAsDefault(panelId) {
  const panel = await db.prepare('SELECT dashboard_id, panel_type, config FROM dashboard_panels WHERE id = ?').get(panelId);
  if (!panel) return false;
  const config = JSON.parse(panel.config || '{}');
  const template = SERIES_KEYED_TYPES.includes(panel.panel_type)
    ? toPositional(config, await getPanelMonitorIdsInOrder(panelId))
    : config;
  await db.prepare(
    `INSERT INTO panel_type_defaults (dashboard_id, panel_type, config, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(dashboard_id, panel_type) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`
  ).run(panel.dashboard_id, defaultsKey(panel.panel_type, config), JSON.stringify(template), new Date().toISOString());
  return true;
}

// Applies the saved house style for panelId's (dashboard, panel_type) pair back onto panelId —
// false (no-op) if nothing's ever been saved for that pair yet. Only touches `config`;
// title/range/monitor selection are panel-instance identity, not style, and are left alone.
async function resetToDefault(panelId) {
  const panel = await db.prepare('SELECT dashboard_id, panel_type, config FROM dashboard_panels WHERE id = ?').get(panelId);
  if (!panel) return false;
  const currentConfig = JSON.parse(panel.config || '{}');
  const row = await db.prepare('SELECT config FROM panel_type_defaults WHERE dashboard_id = ? AND panel_type = ?')
    .get(panel.dashboard_id, defaultsKey(panel.panel_type, currentConfig));
  if (!row) return false;

  const template = JSON.parse(row.config);
  const config = SERIES_KEYED_TYPES.includes(panel.panel_type)
    ? fromPositional(template, await getPanelMonitorIdsInOrder(panelId))
    : template;
  await db.prepare('UPDATE dashboard_panels SET config = ? WHERE id = ?').run(JSON.stringify(config), panelId);
  return true;
}

// panel_type -> true, for every type that currently has a saved default ON THIS dashboard —
// panel-grid.ejs uses this to decide whether a given panel's "Reset to default" button is worth
// showing at all (nothing to reset to otherwise).
async function listDefaultTypes(dashboardId) {
  const rows = await db.prepare('SELECT panel_type FROM panel_type_defaults WHERE dashboard_id = ?').all(dashboardId);
  return Object.fromEntries(rows.map((r) => [r.panel_type, true]));
}

module.exports = { saveAsDefault, resetToDefault, listDefaultTypes };
