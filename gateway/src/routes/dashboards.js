const express = require('express');
const db = require('../db');
const { getCurrentValue, reloadMqttMonitors, findOrCreateDiagMonitor, DIAG_FIELD_LABELS } = require('../monitorCollector');
const { humanizeTopic } = require('../topicName');
const { resolveRange, historyWindowClause, rangeToWindow, MAX_ROWS } = require('./monitor');
const panelTypeDefaults = require('../panelTypeDefaults');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// group_header is a monitor-less, full-width divider panel (see panel-grid.ejs's own rendering) —
// deliberately NOT in SINGLE_MONITOR_TYPES below (that list means "exactly one", not "zero").
const PANEL_TYPES = ['chart', 'table', 'value', 'gauge', 'stat_delta', 'threshold', 'state_bar', 'group_header'];
// gauge is deliberately NOT here (any more) — a gauge panel can hold several monitors, each drawn
// as its own gauge side by side (see loadPanelsWithMonitors/panel-grid.ejs), sharing the panel's
// one min/max/unit/thresholds/style rather than each getting its own independent range.
const SINGLE_MONITOR_TYPES = ['table', 'stat_delta', 'threshold'];
const THRESHOLD_OPERATORS = ['gt', 'gte', 'lt', 'lte'];
const LEGEND_POSITIONS = ['auto', 'top', 'bottom', 'left', 'right', 'off'];
const LEGEND_ALIGNS = ['start', 'center', 'end'];
const CURVE_TENSIONS = [0, 0.15, 0.4];
const STEPPED_VALUES = ['before', 'after', 'middle'];
const POINT_STYLES = ['circle', 'cross', 'rect', 'rectRot', 'star', 'triangle'];
// 'line' is the only time-series type — the rest are snapshots (one CURRENT value per monitor,
// not a history), fed by a completely different client-side data path (see monitor-chart.js's
// renderSnapshot). 'bar_compare' (not just 'bar') names that distinction explicitly: a real
// time-bucketed bar chart is a materially different, larger feature (needs server-side
// aggregation of irregularly-spaced readings) that's deliberately out of scope here — see the
// CHANGELOG/plan for why. Kept in the same 'chart' panel_type rather than becoming new panel
// types of their own: see panelTypeDefaults.js's defaultsKey() for the reasoning.
const CHART_TYPES = ['line', 'bar_compare', 'doughnut', 'pie', 'polar_area', 'radar'];
const MIN_COL_SPAN = 2;
const MAX_COL_SPAN = 12; // the grid itself is 12 columns wide — this is a real ceiling, not an arbitrary one
const MIN_ROW_SPAN = 2;
// Height has no equivalent structural ceiling (unlike width, which can't exceed the grid's own
// column count) — 200 is just a sanity bound against a broken/malicious client value, not a
// design limit on how tall a panel is allowed to get.
const MAX_ROW_SPAN = 200;

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

// A plain multiplier applied to every raw reading before it's displayed/compared/charted — e.g.
// a Loxone value reported in Wh needs *0.001 to show as kWh, or a raw 0-1 fraction needs *100 to
// read as a percentage. Blank/invalid/zero all fall back to 1 (a no-op) rather than silently
// zeroing out every value a panel shows, which a bare `Number(value) || 1` would otherwise do for
// a genuinely-entered 0.
function clampScale(value) {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : 1;
}

// 'dashboard' (rangeField()'s own "Dashboard default" option) is meaningless outside a dashboard
// panel's own range — monitor.js's shared resolveRange() has no notion of it and would otherwise
// just coerce it away to '24h' like any other unrecognized value, silently losing the choice the
// very next time this panel is saved. Passed through as-is here instead; loadPanelsWithMonitors is
// the one place that actually turns it into a concrete range at render time.
function resolvePanelRange(value) {
  return value === 'dashboard' ? 'dashboard' : resolveRange(value);
}

// null (blank field) means "use the Settings-page global default" (see getDefaultPanelDecimals) —
// distinct from 0, a real, validly-entered "round to whole numbers" — same convention already used
// by the 'value'/'chart' panel types' own per-monitor decimals override.
function clampDecimals(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(6, Math.max(0, Math.round(n))) : null;
}

// Applied once, right after a raw reading leaves the database — everything downstream (rounding
// for display, threshold-ladder coloring, gauge percent, stat_delta's comparison) then works
// entirely in the already-scaled unit, rather than each needing its own scale-aware branch.
// Rounded to 6 decimal places purely to avoid floating point noise (e.g. 0.1 * 3 = 0.30000000000000004)
// showing up in a panel that itself displays plenty of decimals.
// parseFloat, not Number: some Loxone states (e.g. weather-server readings) report their value
// pre-formatted with the unit already appended ("33 %", "28.6 °C") rather than a bare number.
// Number() rejects the whole string over that trailing unit and returns NaN — parseFloat reads
// the leading number and ignores the rest, same fix as monitorCollector.js's own toNumeric.
function applyScale(rawValue, scale) {
  const numeric = parseFloat(rawValue);
  if (!Number.isFinite(numeric)) return null;
  if (scale === 1) return numeric;
  return Math.round(numeric * scale * 1e6) / 1e6;
}

// The other half of that same Loxone quirk: a raw reading of "33 %" carries a unit worth
// showing, not just a number worth parsing. A panel with its own Unit field set (override.unit
// or config.unit) always wins — the user's explicit choice (e.g. relabeling a 0-1 fraction as
// "W") overrules whatever Loxone happened to send — but when no unit is configured at all, this
// recovers the one Loxone already provided instead of silently dropping it. Only ever consulted
// as that last-resort fallback (see effectiveUnit below), never combined with a configured unit,
// so there's no risk of the double-unit bug this exists to fix ("33 % %").
function extractLoxoneUnit(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  const str = String(rawValue).trim();
  // Matched WITHOUT a $ anchor deliberately — anchoring the whole pattern to end-of-string makes
  // the optional decimal group backtrack away for a plain "33.5" (no unit at all) so the trailing
  // ".5" satisfies the tail instead, misreporting ".5" as the unit. Consuming the number greedily
  // first and treating whatever's left over as the unit avoids that.
  const match = /^-?\d+(?:[.,]\d+)?/.exec(str);
  if (!match) return null;
  return str.slice(match[0].length).trim() || null;
}

async function getDefaultPanelDecimals() {
  const row = await db.prepare('SELECT default_panel_decimals FROM gateway_settings WHERE id = 1').get();
  return row && Number.isFinite(row.default_panel_decimals) ? row.default_panel_decimals : 2;
}

// Only numeric-looking values get rounded — a Loxone text state ("on"/"off"), a JSON blob, or
// anything else non-numeric is shown exactly as reported, same as before this setting existed.
function formatPanelValue(rawValue, decimals) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return rawValue;
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) return rawValue;
  return numeric.toFixed(decimals);
}

// One "<key>=<value>" pair per line (mirrors the "<token>=\v" convention used elsewhere in this
// app) rather than a full add-row/delete-row UI backed by its own DB table — reused for a value
// panel's value labels, its threshold-color ladder, and its per-monitor name overrides alike:
// each is a handful of rows at most, so a textarea a user edits directly is simpler for both of
// us than reproducing loxone_mapping_translations' whole table+form machinery three more times.
function parseKeyValueLines(text) {
  const map = {};
  (text || '').split('\n').forEach((line) => {
    const idx = line.indexOf('=');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) map[key] = value;
  });
  return map;
}

function serializeKeyValueLines(map) {
  return Object.entries(map || {}).map(([key, value]) => `${key}=${value}`).join('\n');
}

// parseThresholdLadder/serializeThresholdLadder/colorForThresholdLadder/sanitizeColor moved to
// thresholdLadder.js once notifications.js became a second consumer (see that file's own header
// comment for why a plain top-level require of this file from there would be circular).
const { sanitizeColor, parseThresholdLadder, serializeThresholdLadder, colorForThresholdLadder } = require('../thresholdLadder');

// Exact-value mapping (not a threshold ladder's >= comparison) — each line is
// "<value>=<label>[=<color>]", the color segment optional since not every mapped value needs its
// own color. A richer version of the plain parseKeyValueLines map above: this needs to carry an
// optional third field, so it's a list of {value, label, color} instead of a plain object.
function parseValueMappings(text) {
  const list = [];
  (text || '').split('\n').forEach((line) => {
    const parts = line.split('=');
    if (parts.length < 2) return;
    const value = parts[0].trim();
    const label = parts[1].trim();
    // A label itself might validly contain "=" (e.g. "A=B state") — only the FIRST two "="
    // delimit value/label; everything after the second is the color segment, rejoined in case it
    // also happened to contain one.
    const colorRaw = parts.length > 2 ? parts.slice(2).join('=').trim() : '';
    if (!value || !label) return;
    list.push({ value, label, color: colorRaw ? sanitizeColor(colorRaw) : null });
  });
  return list;
}

function serializeValueMappings(list) {
  return (list || []).map((m) => `${m.value}=${m.label}${m.color ? '=' + m.color : ''}`).join('\n');
}

// Chart-only: a labeled vertical line at a fixed point in time (e.g. "here's when the heating
// came on") — same "<key>=<label>[=<color>]" shape as parseValueMappings above, just keyed by an
// epoch-ms timestamp instead of a reading value. Rendered client-side by makeAnnotationPlugin in
// monitor-chart.js, entirely independent of the threshold ladder (which colors by VALUE, not time).
function parseAnnotations(text) {
  const list = [];
  (text || '').split('\n').forEach((line) => {
    const parts = line.split('=');
    if (parts.length < 2) return;
    const time = Number(parts[0].trim());
    const label = parts[1].trim();
    const colorRaw = parts.length > 2 ? parts.slice(2).join('=').trim() : '';
    if (!Number.isFinite(time) || !label) return;
    list.push({ time, label, color: colorRaw ? sanitizeColor(colorRaw) : null });
  });
  return list.sort((a, b) => a.time - b.time);
}

function serializeAnnotations(list) {
  return (list || []).map((a) => `${a.time}=${a.label}${a.color ? '=' + a.color : ''}`).join('\n');
}

// Per-series chart overrides — keyed by monitor id (not label, unlike the value panel's
// monitorNames/valueLabels above: this is built entirely from a dynamic UI that already knows
// each row's monitor id directly, never hand-typed, so there's no reason to prefer the friendlier
// but less precise label key). {name, unit, scale, decimals, axis, color} per monitor id that has
// ANY override set; a monitor with none of them isn't stored at all, keeping this empty for the
// common case of a chart with no per-series customization. scale/decimals mirror the value panel's
// own per-monitor overrides (parseValueSeriesConfig below) — same shape, same client-side row
// builder (see panel-grid.ejs's shared buildScalePicker), so a property that exists on both panel
// types looks and behaves identically on both rather than each inventing its own version of it.
function parseSeriesConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text || '{}');
  } catch (err) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result = {};
  for (const id of Object.keys(parsed)) {
    const entry = parsed[id] || {};
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const unit = typeof entry.unit === 'string' ? entry.unit.trim() : '';
    const scale = Number(entry.scale);
    const decimals = Number(entry.decimals);
    const hasScale = Number.isFinite(scale) && scale !== 0 && scale !== 1;
    const hasDecimals = Number.isFinite(decimals);
    const axis = entry.axis === 'right' ? 'right' : 'left';
    const color = typeof entry.color === 'string' && entry.color.trim() ? sanitizeColor(entry.color) : null;
    const style = ['solid-thick', 'dashed', 'dotted'].includes(entry.style) ? entry.style : null;
    const pointStyle = POINT_STYLES.includes(entry.pointStyle) ? entry.pointStyle : null;
    // Same "exact value -> label/color" mapping the 'value' panel type already has (see
    // parseValueMappings) — a reading is sometimes a Loxone/MQTT enum (1 = Active, 50 = Resetting),
    // not a continuous quantity a scale/decimals pair can meaningfully round, so this needs to be
    // checked before any numeric formatting is even attempted, same precedence loadPanelsWithMonitors
    // already gives it for a value panel's own mapping. Client-built rows (a dashboard chart panel's
    // own per-series builder) submit this as an already-parsed array; validated fresh here regardless
    // of which caller built it, same as every other field on this entry.
    const valueLabels = Array.isArray(entry.valueLabels)
      ? entry.valueLabels
        .filter((m) => m && typeof m.value !== 'undefined' && typeof m.label === 'string' && m.label.trim())
        .map((m) => ({ value: String(m.value), label: m.label.trim(), color: typeof m.color === 'string' && m.color.trim() ? sanitizeColor(m.color) : null }))
      : [];
    if (name || unit || hasScale || hasDecimals || axis === 'right' || color || style || pointStyle || valueLabels.length) {
      result[id] = {
        name: name || null,
        unit: unit || null,
        scale: hasScale ? scale : null,
        decimals: hasDecimals ? Math.min(6, Math.max(0, Math.round(decimals))) : null,
        axis,
        color,
        style,
        pointStyle,
        valueLabels,
      };
    }
  }
  return result;
}

// Same shape/keying as parseSeriesConfig above, minus the chart-only axis/color fields, plus its
// own scale/decimals (a value panel has no panel-wide equivalent of either — every monitor in it
// can report a completely different kind of reading, so unlike chart's single shared Y-axis there
// was never a meaningful "whole panel" scale/decimals to begin with). Built by the exact same
// checked-monitor-driven row UI (see the shared .chart-series-settings/.value-series-settings
// script in panel-grid.ejs). Replaced the old free-typed "<label>=<name>" monitorNames textarea;
// loadPanelsWithMonitors below still reads any pre-existing monitorNames map as a fallback so
// older panels don't lose their renames the first time this is opened, rather than needing a
// one-off DB migration for it.
function parseValueSeriesConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text || '{}');
  } catch (err) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result = {};
  for (const id of Object.keys(parsed)) {
    const entry = parsed[id] || {};
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const unit = typeof entry.unit === 'string' ? entry.unit.trim() : '';
    const scale = Number(entry.scale);
    const decimals = Number(entry.decimals);
    const hasScale = Number.isFinite(scale) && scale !== 0;
    const hasDecimals = Number.isFinite(decimals);
    if (name || unit || hasScale || hasDecimals) {
      result[id] = {
        name: name || null,
        unit: unit || null,
        scale: hasScale ? scale : null,
        decimals: hasDecimals ? Math.min(6, Math.max(0, Math.round(decimals))) : null,
      };
    }
  }
  return result;
}

// Unit/thresholds/min/max are the things that stop making sense shared once a panel mixes readings
// of genuinely different kinds — e.g. Temperature (°C, 0-40, alert above 28) and Humidity (%,
// 0-100, alert above 70) side by side, sharing one range/ladder tuned for whichever of the two it
// was originally set up for. style/shape/sections/needle/sparkline stay panel-wide (see the
// render-time comment below) — those are properties of how the ring/bar itself is DRAWN, not of
// any one reading, so there's no "per-monitor" version of them that would mean anything. Same
// keyed-by-monitor-id shape as parseValueSeriesConfig above, minus name/scale/decimals (a gauge
// already has its own panel-wide scale/decimals with no per-monitor equivalent requested).
// thresholdsRaw is the builder's own raw "value=color=style" lines (see chartFieldHelpers.js's
// thresholdField/threshold-annotation-builder.js) — reusing parseThresholdLadder here rather than
// inventing a second thresholds wire format for this one per-monitor case.
function parseGaugeSeriesConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text || '{}');
  } catch (err) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result = {};
  for (const id of Object.keys(parsed)) {
    const entry = parsed[id] || {};
    const unit = typeof entry.unit === 'string' ? entry.unit.trim() : '';
    const thresholds = parseThresholdLadder(typeof entry.thresholdsRaw === 'string' ? entry.thresholdsRaw : '');
    // entry.min == null check FIRST, not just Number.isFinite(Number(entry.min)) — Number(null) is
    // 0, not NaN, so skipping this guard would silently turn "no override sent" into an explicit
    // 0 override the very first time this ran (confirmed live: min/max on a monitor that was never
    // touched came back as 0/0 after one save-reload round trip, not the panel's own real min/max).
    const hasMin = entry.min != null && Number.isFinite(Number(entry.min));
    const hasMax = entry.max != null && Number.isFinite(Number(entry.max));
    const min = hasMin ? Number(entry.min) : null;
    const max = hasMax ? Number(entry.max) : null;
    if (unit || thresholds.length || hasMin || hasMax) {
      result[id] = { unit: unit || null, thresholds, min: min, max: max };
    }
  }
  return result;
}

// A state bar stacking several monitors shares ONE valueLabels mapping across every row today
// (buildConfig's own state_bar branch below) — fine as long as every monitor in the panel reports
// the same small set of raw values, but a mixed panel (say, a lock's 0/1 next to a mode control's
// 1/2/3) has no single mapping that means the same thing for both rows. Same per-monitor-override
// shape as parseGaugeSeriesConfig above, minus unit/thresholds (a state bar has neither — it's
// always a discrete label+color per raw value, never a continuous reading). valueLabelsRaw is the
// value-mapping builder's own raw "value=label=color" lines (see chartFieldHelpers.js's
// valueMappingField/foot.ejs's value-mapping-builder script) — reusing parseValueMappings rather
// than inventing a second wire format for this one per-monitor case.
function parseStateBarSeriesConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text || '{}');
  } catch (err) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result = {};
  for (const id of Object.keys(parsed)) {
    const entry = parsed[id] || {};
    const valueLabels = parseValueMappings(typeof entry.valueLabelsRaw === 'string' ? entry.valueLabelsRaw : '');
    if (valueLabels.length) result[id] = { valueLabels };
  }
  return result;
}

function buildConfig(panelType, body) {
  if (panelType === 'chart') {
    // No panel-wide decimals/scale any more — every series sets its own of both now (see
    // parseSeriesConfig), the same simplification already applied to the Current value panel
    // type once its own per-value equivalents existed. The axis-tick decimals still need exactly
    // one shared value (an axis can't format its ticks per-series) — that comes from the
    // Settings-page global default at render time instead (see panel-grid.ejs's canvas).
    const yMin = Number(body.y_min);
    const yMax = Number(body.y_max);
    // stepped_line is now a <select> (Off/Before/After/Middle) whose "Off" option submits '' —
    // anything not one of the three real granularities (including '', or the field being absent)
    // means off. Old saved panels with the pre-upgrade `stepped: true` boolean are normalized to
    // 'before' at the one place that reads them back out for rendering (panel-grid.ejs's canvas
    // data-stepped attr), not here — this only ever sees a fresh submission from the new select.
    const stepped = STEPPED_VALUES.includes(body.stepped_line) ? body.stepped_line : false;
    const curveTension = CURVE_TENSIONS.includes(Number(body.curve_tension)) ? Number(body.curve_tension) : 0.15;
    return {
      chartType: CHART_TYPES.includes(body.chart_type) ? body.chart_type : 'line',
      legendPosition: LEGEND_POSITIONS.includes(body.legend_position) ? body.legend_position : 'auto',
      legendAlign: LEGEND_ALIGNS.includes(body.legend_align) ? body.legend_align : 'start',
      legendShowMin: !!body.legend_show_min,
      legendShowMax: !!body.legend_show_max,
      legendShowAvg: !!body.legend_show_avg,
      legendShowCurrent: !!body.legend_show_current,
      unit: fieldStr(body.unit_chart),
      fill: !!body.fill_area,
      stepped,
      curveTension,
      points: !!body.show_points,
      animation: !!body.enable_animation,
      yScaleType: body.y_scale_type === 'logarithmic' ? 'logarithmic' : 'linear',
      yMin: fieldStr(body.y_min) !== '' && Number.isFinite(yMin) ? yMin : null,
      yMax: fieldStr(body.y_max) !== '' && Number.isFinite(yMax) ? yMax : null,
      zoom: !!body.enable_zoom,
      thresholds: parseThresholdLadder(fieldStr(body.chart_thresholds)),
      annotations: parseAnnotations(fieldStr(body.chart_annotations)),
      series: parseSeriesConfig(body.chart_series),
    };
  }
  if (panelType === 'value') {
    return {
      layout: body.value_layout === 'row' ? 'row' : 'stacked',
      unit: fieldStr(body.unit_value),
      hideLabel: !!body.hide_value_label,
      valueLabels: parseValueMappings(fieldStr(body.value_labels)),
      thresholds: parseThresholdLadder(fieldStr(body.value_thresholds)),
      series: parseValueSeriesConfig(body.value_series),
    };
  }
  if (panelType === 'state_bar') {
    return {
      // Same {value, label, color} shape as the 'value' panel type's own mapping — a state bar's
      // segments ARE that same discrete "raw reading -> name/color" idea, just laid out along a
      // timeline instead of shown as the single current one.
      // NOT body.value_labels — both the Add and Edit forms render every panel type's fields into
      // the same <form> (CSS-hidden, not removed), so a 'value'-type panel's own (always-empty,
      // for a state_bar panel) value_labels field would sit right alongside this one under the
      // identical name. fieldStr() takes array[0] for a repeated field name, and the 'value'
      // block's field comes first in the DOM — so body.value_labels here would always resolve to
      // that other, empty field rather than the one actually filled in below. A distinct name
      // sidesteps the collision entirely.
      valueLabels: parseValueMappings(fieldStr(body.state_bar_value_labels)),
      // Anything that doesn't match one of the rows above still needs a segment color, or an
      // unmapped stretch of the timeline would render invisible rather than "some raw value with
      // no name given to it yet".
      defaultColor: sanitizeColor(fieldStr(body.state_bar_default_color)) || '#8a93a6',
      series: parseStateBarSeriesConfig(body.state_bar_series),
    };
  }
  if (panelType === 'gauge') {
    const min = Number(body.gauge_min);
    const max = Number(body.gauge_max);
    return {
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 100,
      unit: fieldStr(body.unit_gauge),
      scale: clampScale(body.scale_gauge),
      decimals: clampDecimals(body.decimals_gauge),
      style: body.gauge_style === 'radial' ? 'radial' : 'bar',
      // The three below only ever show anything for style:'radial' — bar has no ring to shape
      // into an arc, band into sections, or point a needle around (see panel-grid.ejs).
      shape: body.gauge_shape === 'circle' ? 'circle' : 'arc',
      sections: !!body.gauge_sections,
      sectionsGradient: !!body.gauge_sections_gradient,
      needle: !!body.gauge_needle,
      sparkline: !!body.gauge_sparkline,
      sparklineColor: body.gauge_sparkline_neutral ? 'default' : 'threshold',
      thresholds: parseThresholdLadder(fieldStr(body.gauge_thresholds)),
      series: parseGaugeSeriesConfig(body.gauge_series),
    };
  }
  if (panelType === 'stat_delta') {
    const direction = ['up_good', 'down_good'].includes(body.direction) ? body.direction : 'neutral';
    return {
      unit: fieldStr(body.unit_stat_delta),
      direction,
      scale: clampScale(body.scale_stat_delta),
      decimals: clampDecimals(body.decimals_stat_delta),
      thresholds: parseThresholdLadder(fieldStr(body.stat_delta_thresholds)),
    };
  }
  if (panelType === 'threshold') {
    const value = Number(body.threshold_value);
    return {
      operator: THRESHOLD_OPERATORS.includes(body.threshold_operator) ? body.threshold_operator : 'gt',
      value: Number.isFinite(value) ? value : 0,
      unit: fieldStr(body.unit_threshold),
      decimals: clampDecimals(body.decimals_threshold),
      scale: clampScale(body.scale_threshold),
      labelOk: fieldStr(body.label_ok) || 'Normal',
      labelAlert: fieldStr(body.label_alert) || 'Alert',
    };
  }
  if (panelType === 'group_header') {
    return { description: fieldStr(body.description) };
  }
  if (panelType === 'table') {
    return {
      scale: clampScale(body.scale_table),
      decimals: clampDecimals(body.decimals_table),
      thresholds: parseThresholdLadder(fieldStr(body.table_thresholds)),
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
// area (see permissionAreas.js) rather than by ownership. A personal dashboard can ALSO be shared
// with specific other users (dashboard_shares), each granted view-only or edit access by its
// owner — a second, narrower sharing mechanism layered on top of the same table, kept separate
// from the Access-Role-based one above since it's per-dashboard rather than app-wide. Every
// handler below loads through loadAccessibleDashboard (never trusts the :id alone) and, for
// anything that mutates, additionally checks canMutate or (for owner-only actions) isOwner.
async function loadAccessibleDashboard(id, req) {
  const dashboard = await db.prepare('SELECT * FROM custom_dashboards WHERE id = ?').get(id);
  if (!dashboard) return null;
  if (dashboard.user_id === req.session.userId || dashboard.user_id === null) return dashboard;

  const userShare = await db.prepare('SELECT can_edit FROM dashboard_shares WHERE dashboard_id = ? AND user_id = ?').get(dashboard.id, req.session.userId);
  const roleShare = req.user && req.user.roleId
    ? await db.prepare('SELECT can_edit FROM dashboard_role_shares WHERE dashboard_id = ? AND role_id = ?').get(dashboard.id, req.user.roleId)
    : null;
  if (!userShare && !roleShare) return null; // someone else's personal dashboard, not shared with this user or their role
  // Editable if EITHER grant says so — a user individually shared as viewer but whose role was
  // separately granted editor (or vice versa) gets the more permissive of the two.
  const shareCanEdit = !!(userShare && userShare.can_edit) || !!(roleShare && roleShare.can_edit);
  return { ...dashboard, shareCanEdit };
}

function isShared(dashboard) {
  return dashboard.user_id === null;
}

function isOwner(dashboard, req) {
  return dashboard.user_id === req.session.userId;
}

// Rename / delete — owner-only for a personal dashboard, UNLESS the current user is one of its
// shared editors AND their role carries dashboard_manage_shared (a step beyond just editing
// panels, so opt-in per role rather than implied by edit access alone). For the one shared home
// Dashboard (which has no single owner), gated by the `dashboard` Access Role's edit permission
// instead, same as before per-dashboard sharing existed. Managing WHO a dashboard is shared with
// stays strictly owner-only regardless (see the /share* routes below) — not extended here.
function canManageDashboard(dashboard, req) {
  if (isOwner(dashboard, req)) return true;
  if (isShared(dashboard)) return !!req.user && (req.user.isAdmin || !!req.user.permissions.dashboard?.edit);
  return !!dashboard.shareCanEdit && !!req.user && (req.user.isAdmin || !!req.user.permissions.dashboard_manage_shared?.edit);
}

// Panel-level edit rights (add/edit/delete/reorder/resize panels) — everything canManageDashboard
// already allows, plus a personal dashboard's own shared editors (viewers stay read-only).
function canMutate(dashboard, req) {
  if (canManageDashboard(dashboard, req)) return true;
  return !!dashboard.shareCanEdit;
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
router.post('/quick-add-topic', asyncHandler(async (req, res) => {
  if (!(req.user && (req.user.isAdmin || req.user.permissions.dashboard?.edit))) return forbidden(res);

  const topic = (req.body.topic || '').trim();
  const sharedDashboard = await db.prepare('SELECT * FROM custom_dashboards WHERE user_id IS NULL LIMIT 1').get();
  if (!topic || !sharedDashboard) return res.redirect('/incoming/messages');

  try {
    let monitor = await db.prepare("SELECT id FROM monitors WHERE source_type = 'mqtt' AND mqtt_topic = ?").get(topic);
    let monitorId = monitor?.id;
    // Rejected the same way routes/monitor.js rejects a duplicate monitor — pinning the same topic
    // on the Dashboard a second time would just leave two identical panels sitting side by side.
    if (monitorId && (await db.prepare('SELECT 1 FROM dashboard_panel_monitors WHERE monitor_id = ? LIMIT 1').get(monitorId))) {
      throw new Error(`"${topic}" is already pinned on the Dashboard.`);
    }
    if (!monitorId) {
      monitorId = await db.insertReturningId(
        // config passed explicitly ('{}') — MySQL/MariaDB can't declare a DEFAULT on a TEXT column
        // at all (see 001_baseline.js's own comment), unlike SQLite/Postgres.
        "INSERT INTO monitors (source_type, label, mqtt_topic, enabled, created_at, config) VALUES ('mqtt', ?, ?, 1, ?, '{}')",
        [humanizeTopic(topic), topic, new Date().toISOString()]
      );
      await reloadMqttMonitors(); // start recording this topic's history immediately, not just from the next gateway restart
    }

    const maxPos = (await db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM dashboard_panels WHERE dashboard_id = ?').get(sharedDashboard.id)).m;
    const panelId = await db.insertReturningId(
      `INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, position) VALUES (?, 'value', ?, '24h', '{"layout":"stacked"}', ?)`,
      [sharedDashboard.id, humanizeTopic(topic), maxPos + 1]
    );
    await db.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, 0)').run(panelId, monitorId);

    res.redirect('/');
  } catch (err) {
    if (req.is('json')) {
      return res.status(409).json({ error: err.message, isDuplicate: /already pinned on the dashboard/i.test(err.message) });
    }
    res.redirect('/incoming/messages');
  }
}));

// Loxone equivalent of quick-add-topic above — same shape (find-or-create the Monitor, pin a new
// "Current value" panel for it on the shared Home dashboard), just keyed by miniserver+uuid
// instead of an MQTT topic string. Powers Live Data's "Widget" button (routes/liveData.js).
router.post('/quick-add-loxone', asyncHandler(async (req, res) => {
  if (!(req.user && (req.user.isAdmin || req.user.permissions.dashboard?.edit))) return forbidden(res);

  const miniserverId = Number(req.body.miniserver_id);
  const uuid = (req.body.loxone_uuid || '').trim();
  const label = (req.body.label || '').trim();
  const sharedDashboard = await db.prepare('SELECT * FROM custom_dashboards WHERE user_id IS NULL LIMIT 1').get();
  if (!miniserverId || !uuid || !sharedDashboard) return res.redirect('/live-data');

  try {
    let monitor = await db.prepare("SELECT id FROM monitors WHERE source_type = 'loxone' AND miniserver_id = ? AND loxone_uuid = ?").get(miniserverId, uuid);
    let monitorId = monitor?.id;
    // Same "only once" rejection as quick-add-topic above.
    if (monitorId && (await db.prepare('SELECT 1 FROM dashboard_panel_monitors WHERE monitor_id = ? LIMIT 1').get(monitorId))) {
      throw new Error(`Already pinned on the Dashboard as "${monitor.label || label || uuid}".`);
    }
    if (!monitorId) {
      monitorId = await db.insertReturningId(
        // config passed explicitly ('{}') — see the quick-add-topic route above for why.
        "INSERT INTO monitors (source_type, label, miniserver_id, loxone_uuid, poll_interval_ms, enabled, created_at, config) VALUES ('loxone', ?, ?, ?, 10000, 1, ?, '{}')",
        [label || uuid, miniserverId, uuid, new Date().toISOString()]
      );
    }

    const maxPos = (await db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM dashboard_panels WHERE dashboard_id = ?').get(sharedDashboard.id)).m;
    const panelId = await db.insertReturningId(
      `INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, position) VALUES (?, 'value', ?, '24h', '{"layout":"stacked"}', ?)`,
      [sharedDashboard.id, label || uuid, maxPos + 1]
    );
    await db.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, 0)').run(panelId, monitorId);

    res.redirect('/');
  } catch (err) {
    if (req.is('json')) {
      return res.status(409).json({ error: err.message, isDuplicate: /already pinned on the dashboard/i.test(err.message) });
    }
    res.redirect('/live-data');
  }
}));

// Same shape as quick-add-topic/quick-add-loxone above, for a Miniserver's diagnostic fields (CPU
// load, heap, task count). Powers the "Add to Dashboard" button next to
// Check-for-update/Update-to-latest-release in the Miniservers page's own diagnostics panel — one
// click pins all three at once (per user feedback: three separate per-stat "+" buttons read as
// cluttered). Monitor creation/seeding itself is shared with routes/monitor.js's "Add to Monitor"
// sibling button (same bundle, minus the panel) via monitorCollector's findOrCreateDiagMonitor.
const QUICK_ADD_DIAG_FIELDS = ['cpu_load', 'heap_value_kb', 'num_tasks'];

async function addDiagWidget(sharedDashboardId, miniserver, diagField) {
  const monitorId = await findOrCreateDiagMonitor(miniserver, diagField);
  const label = `${miniserver.name} - ${DIAG_FIELD_LABELS[diagField]}`;

  const maxPos = (await db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM dashboard_panels WHERE dashboard_id = ?').get(sharedDashboardId)).m;
  const panelId = await db.insertReturningId(
    `INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, position) VALUES (?, 'value', ?, '24h', '{"layout":"stacked"}', ?)`,
    [sharedDashboardId, label, maxPos + 1]
  );
  await db.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, 0)').run(panelId, monitorId);
}

router.post('/quick-add-diag', asyncHandler(async (req, res) => {
  if (!(req.user && (req.user.isAdmin || req.user.permissions.dashboard?.edit))) return forbidden(res);

  const miniserverId = Number(req.body.miniserver_id);
  const sharedDashboard = await db.prepare('SELECT * FROM custom_dashboards WHERE user_id IS NULL LIMIT 1').get();
  if (!miniserverId || !sharedDashboard) return res.redirect('/miniservers');

  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(miniserverId);
  if (!miniserver) return res.redirect('/miniservers');

  for (const diagField of QUICK_ADD_DIAG_FIELDS) await addDiagWidget(sharedDashboard.id, miniserver, diagField);

  res.redirect('/');
}));

// rangeOverride (from the dashboard-wide time filter next to the auto-refresh control — see
// partials/foot.ejs) never touches what's actually stored in dashboard_panels.range: the Edit
// form still needs to show and edit each panel's own real saved range regardless of whatever
// filter happens to be active while looking at it, so the override only ever feeds into the
// `range` local computed per panel below (and the `displayRange` field attached to it for
// panel-grid.ejs's chart canvas / stat_delta label), never into `panel.range`/`base.range` itself.
//
// A panel whose own saved range is the literal 'dashboard' sentinel (rangeField()'s own
// "Dashboard default" option, and every new panel's own default going forward) is the ONE case
// that actually follows the dashboard-wide filter above — any panel with a real preset/custom/
// absolute range of its own keeps that regardless of what the dashboard-wide filter says, so one
// specific panel can deliberately stay pinned to its own range while the filter drives everything
// still left on "Dashboard default". Falls back to '24h' for a 'dashboard' panel on a dashboard
// whose own filter is itself at rest ("Default range", no override active at all).
async function loadPanelsWithMonitors(dashboardId, rangeOverride) {
  const effectiveRange = rangeOverride ? resolveRange(rangeOverride) : null;
  const panels = await db.prepare('SELECT * FROM dashboard_panels WHERE dashboard_id = ? ORDER BY position').all(dashboardId);
  // miniserver_name is only meaningful for source_type='loxone' monitors (NULL for MQTT ones,
  // which aren't tied to any one Miniserver) — used to disambiguate when a panel combines
  // monitors from more than one Miniserver, e.g. the same control name/label on two of them.
  const monitorsStmt = db.prepare(
    `SELECT monitors.*, miniservers.name AS miniserver_name FROM dashboard_panel_monitors dpm
     JOIN monitors ON monitors.id = dpm.monitor_id
     LEFT JOIN miniservers ON miniservers.id = monitors.miniserver_id
     WHERE dpm.panel_id = ? ORDER BY dpm.position`
  );

  return Promise.all(panels.map(async (panel) => {
    const monitors = await monitorsStmt.all(panel.id);
    const config = JSON.parse(panel.config || '{}');
    // valueLabels used to be stored as a plain {value: label} map (before value mappings could
    // also carry their own color) — a panel saved under that older shape still has one sitting in
    // the database as-is, since nothing migrates old rows on its own. Normalized back into the
    // current {value, label, color} array shape right here, at read time, so both the render logic
    // below AND the Edit form (which reads p.config.valueLabels straight from this same object —
    // see panel-grid.ejs) always see the current shape, rather than each needing its own check.
    if (config.valueLabels && !Array.isArray(config.valueLabels)) {
      config.valueLabels = Object.entries(config.valueLabels).map(([value, label]) => ({ value, label, color: null }));
    }
    // Only 'value' ignores this entirely — it shows the current live reading, not a history
    // window, so there's nothing for a time filter to apply to.
    const range = panel.range === 'dashboard' ? (effectiveRange || '24h') : panel.range;
    // Only the chart panel type's canvas actually reads this (see monitor-chart.js's
    // rangeUntilMs) — computed here regardless of panel_type anyway since it's cheap and keeps
    // every panel's `range` handling in this one place. Only ever non-null for an absolute (fixed
    // from/to) range — the chart's own left edge always auto-scales to the earliest surviving data
    // point rather than pinning to the range's nominal start, so there's no equivalent "since" to
    // pass through here.
    const { until: rangeUntilIso } = rangeToWindow(range);
    const base = {
      ...panel,
      config,
      monitors,
      displayRange: range,
      chartUntilMs: rangeUntilIso ? new Date(rangeUntilIso).getTime() : null,
    };

    if (panel.panel_type === 'value') {
      const valueMappings = config.valueLabels || [];
      // Per-monitor-id rename/unit/scale/decimals override (see parseValueSeriesConfig), built by
      // the same checked-monitor-driven row UI as a chart panel's own series settings. A panel
      // saved before this existed has its rename data sitting in the older label-keyed
      // config.monitorNames instead — migrated onto `series` right here (in memory only) so the
      // Edit form's builder picks it up pre-filled the first time it's opened, and the next save
      // writes it out under the new shape with no separate DB migration needed.
      const series = { ...(config.series || {}) };
      if (config.monitorNames) {
        monitors.forEach((m) => {
          if (config.monitorNames[m.label] && !series[m.id]) series[m.id] = { name: config.monitorNames[m.label], unit: null };
        });
      }
      const defaultDecimals = await getDefaultPanelDecimals();
      return {
        ...base,
        monitors: await Promise.all(monitors.map(async (m) => {
          const override = series[m.id] || {};
          const displayLabel = override.name || m.label;
          // Every monitor in a value panel can be a completely different kind of reading (unlike
          // chart's single shared Y-axis), so scale/decimals are per-monitor only — no panel-wide
          // default to fall back to besides "unscaled" / the Settings-page global.
          const scale = override.scale != null ? override.scale : 1;
          const decimals = override.decimals != null ? override.decimals : defaultDecimals;
          const current = await getCurrentValue(m.id);
          const effectiveUnit = override.unit || config.unit || (current ? extractLoxoneUnit(current.value) : null);
          if (!current) return { ...m, displayLabel, effectiveUnit, current: null };
          // An exact match against the value-mapping list takes priority over decimal formatting
          // — a translated "1" -> "Actief" is a label, not a rounded number, so it skips toFixed()
          // AND the unit suffix (see panel-grid.ejs) that a real numeric/text value would
          // otherwise get. Matched against the RAW reading, before scaling — the mapping list is
          // meant for the value as Loxone/MQTT actually reports it, not a multiplied-out one. Its
          // OWN color (if it set one) likewise takes priority over the more general threshold
          // ladder, since a mapped value is a more specific rule than a range.
          const mapping = valueMappings.find((vm) => vm.value === String(current.value));
          const isLabel = !!mapping;
          const scaledNumeric = applyScale(current.value, scale);
          // scaledNumeric is null for a non-numeric reading (a Loxone text state, say) — falls
          // back to the raw value so formatPanelValue's own non-numeric passthrough still applies,
          // same as before scaling existed, instead of displaying a blank "null".
          const displayValue = isLabel ? mapping.label : formatPanelValue(scaledNumeric === null ? current.value : scaledNumeric, decimals);
          const thresholdColor = (mapping && mapping.color) || colorForThresholdLadder(scaledNumeric, config.thresholds);
          return { ...m, displayLabel, effectiveUnit, current: { ...current, displayValue, isLabel, thresholdColor } };
        })),
      };
    }

    if (panel.panel_type === 'table') {
      const monitor = monitors[0] || null;
      const scale = config.scale || 1;
      const decimals = config.decimals != null ? config.decimals : await getDefaultPanelDecimals();
      const { sql: rangeSql, params: rangeParams } = historyWindowClause(range);
      const rawRows = monitor
        ? await db.prepare(`SELECT recorded_at AS "recordedAt", value FROM monitor_history WHERE monitor_id = ?${rangeSql} ORDER BY recorded_at DESC LIMIT ?`).all(monitor.id, ...rangeParams, MAX_ROWS)
        : [];
      const rows = rawRows.map((r) => {
        const scaledNumeric = applyScale(r.value, scale);
        return {
          ...r,
          displayValue: scaledNumeric === null ? r.value : formatPanelValue(scaledNumeric, decimals),
          thresholdColor: colorForThresholdLadder(scaledNumeric, config.thresholds),
        };
      });
      return { ...base, rows };
    }

    if (panel.panel_type === 'gauge') {
      // Style/shape/sections/needle/sparkline/scale/decimals stay this ONE panel's own shared
      // settings (see buildConfig) — properties of how the ring/bar itself is drawn, not of any one
      // reading, so there's no meaningful per-monitor version of them. min/max/unit/thresholds DO
      // have one (config.series, same keyed-by-monitor-id shape as the 'value'/'chart' panel
      // types' own series — see parseGaugeSeriesConfig) — added once a panel mixing e.g.
      // Temperature (0-40°C) and Humidity (0-100%) had no way to give each its own range/unit/alert
      // threshold instead of one shared range/ladder tuned for whichever reading it was originally
      // set up for.
      const scale = config.scale || 1;
      const decimals = config.decimals != null ? config.decimals : await getDefaultPanelDecimals();
      const series = config.series || {};
      const gauges = await Promise.all(monitors.map(async (monitor) => {
        const override = series[monitor.id] || {};
        const effectiveThresholds = override.thresholds && override.thresholds.length ? override.thresholds : config.thresholds;
        const effectiveMin = override.min != null ? override.min : config.min;
        const effectiveMax = override.max != null ? override.max : config.max;
        const current = await getCurrentValue(monitor.id);
        const effectiveUnit = override.unit || config.unit || (current ? extractLoxoneUnit(current.value) : null);
        const scaledNumeric = current ? applyScale(current.value, scale) : null;
        const hasNumeric = Number.isFinite(scaledNumeric);
        const displayCurrent = current ? { ...current, displayValue: hasNumeric ? formatPanelValue(scaledNumeric, decimals) : current.value } : null;
        const percent = hasNumeric && effectiveMax > effectiveMin ? Math.min(100, Math.max(0, ((scaledNumeric - effectiveMin) / (effectiveMax - effectiveMin)) * 100)) : null;
        const thresholdColor = hasNumeric ? colorForThresholdLadder(scaledNumeric, effectiveThresholds) : null;
        // A small recent-history trend line under the value (Style: Round only, see
        // panel-grid.ejs) — optional since it costs one extra query per monitor in the panel.
        // Normalized against ITS OWN sampled min/max (not the gauge's configured min/max), same as
        // any sparkline: the point is to show the recent shape of the reading, not restate the
        // gauge's own scale a second time.
        let sparkline = null;
        if (config.sparkline) {
          const { sql: rangeSql, params: rangeParams } = historyWindowClause(range);
          const rows = await db.prepare(`SELECT numeric_value AS "numericValue" FROM monitor_history WHERE monitor_id = ?${rangeSql} ORDER BY recorded_at ASC LIMIT ?`).all(monitor.id, ...rangeParams, MAX_ROWS);
          const values = rows.map((r) => r.numericValue).filter((v) => Number.isFinite(v));
          if (values.length >= 2) {
            const sparkMin = Math.min(...values);
            const sparkMax = Math.max(...values);
            const sparkRange = sparkMax - sparkMin;
            sparkline = values.map((v) => (sparkRange > 0 ? (v - sparkMin) / sparkRange : 0.5));
          }
        }
        return { monitor, current: displayCurrent, percent, thresholdColor, sparkline, effectiveUnit, effectiveMin, effectiveMax, effectiveThresholds };
      }));
      return { ...base, gauges };
    }

    if (panel.panel_type === 'threshold') {
      const monitor = monitors[0] || null;
      const current = monitor ? await getCurrentValue(monitor.id) : null;
      const scale = config.scale || 1;
      const decimals = config.decimals != null ? config.decimals : await getDefaultPanelDecimals();
      const scaledNumeric = current ? applyScale(current.value, scale) : null;
      const hasNumeric = Number.isFinite(scaledNumeric);
      const displayCurrent = current ? { ...current, displayValue: hasNumeric ? formatPanelValue(scaledNumeric, decimals) : current.value } : null;
      const effectiveUnit = config.unit || (current ? extractLoxoneUnit(current.value) : null);
      return { ...base, monitor, current: displayCurrent, effectiveUnit, isAlert: evaluateThreshold(hasNumeric ? scaledNumeric : null, config) };
    }

    if (panel.panel_type === 'state_bar') {
      const valueLabels = config.valueLabels || [];
      const defaultColor = config.defaultColor || '#8a93a6';
      // Per-monitor override (config.series, same shape/reasoning as the 'gauge' panel type's own
      // unit/thresholds override above) — a state bar stacking several monitors otherwise has no
      // way to give a lock's 0/1 and a mode control's 1/2/3 different meanings/colors when they
      // share one panel-wide mapping.
      const series = config.series || {};
      const { since, until } = rangeToWindow(range);
      const rangeStartMs = since ? new Date(since).getTime() : null;
      const rangeEndMs = until ? new Date(until).getTime() : Date.now();
      const { sql: rangeSql, params: rangeParams } = historyWindowClause(range);
      const bars = await Promise.all(monitors.map(async (monitor) => {
        const override = series[monitor.id];
        const effectiveValueLabels = override && override.valueLabels && override.valueLabels.length ? override.valueLabels : valueLabels;
        // DESC + LIMIT, then reversed back to ascending — NOT a plain ASC + LIMIT. A busy monitor
        // (polled every few seconds) can easily have more rows in a 24h/7d window than MAX_ROWS;
        // ASC+LIMIT would silently keep only the OLDEST slice of the range and cut off everything
        // recent, which is exactly backwards for a "what's it doing lately" panel — the segment
        // list would just stop partway through and the whole tail of the bar would read as one
        // giant unbroken (wrong) block. DESC+LIMIT keeps the most recent MAX_ROWS instead, same
        // direction table/series.json's own history queries already truncate in (see monitor.js).
        // Any truncation this still causes lands at the OLD end, which the "gap before the first
        // reading" logic below already renders as an explicit No data stretch.
        const rows = (await db.prepare(
          `SELECT recorded_at AS "recordedAt", value FROM monitor_history WHERE monitor_id = ?${rangeSql} ORDER BY recorded_at DESC LIMIT ?`
        ).all(monitor.id, ...rangeParams, MAX_ROWS)).reverse();
        // The state in effect AT the range's own start is whatever the monitor's last reading
        // BEFORE it was — not "unknown" just because that particular reading happens to sit outside
        // the window. A state that hasn't changed in days (only recorded on change, per
        // monitorCollector.js's dedup) can easily have zero rows within a short range like 24h,
        // reading as "No data" despite a perfectly well-known, unchanged value the whole time — a
        // longer range happens to reach far enough back to include that same still-relevant reading
        // and shows it correctly, which is what actually exposed this: identical real state, two
        // different (and disagreeing) answers depending only on which range was picked. Meaningless
        // for an unbounded "All" range (rangeStartMs null) — there's no fixed start to seed at.
        const priorRow = rangeStartMs != null
          ? await db.prepare('SELECT value FROM monitor_history WHERE monitor_id = ? AND recorded_at < ? ORDER BY recorded_at DESC LIMIT 1').get(monitor.id, since)
          : null;
        // One segment per RUN of consecutive readings sharing the same mapped label+color — not
        // one per raw row, which would draw an invisible-thin, unclickable sliver for every single
        // poll even while the underlying state hadn't actually changed at all.
        const segments = [];
        if (priorRow) {
          const mapping = effectiveValueLabels.find((vm) => vm.value === String(priorRow.value));
          segments.push({ label: mapping ? mapping.label : String(priorRow.value), color: (mapping && mapping.color) || defaultColor, startMs: rangeStartMs, endMs: null });
        }
        rows.forEach((r) => {
          const mapping = effectiveValueLabels.find((vm) => vm.value === String(r.value));
          const label = mapping ? mapping.label : String(r.value);
          const color = (mapping && mapping.color) || defaultColor;
          const startMs = new Date(r.recordedAt).getTime();
          const last = segments[segments.length - 1];
          if (!last || last.label !== label || last.color !== color) segments.push({ label, color, startMs, endMs: null });
        });
        // A segment's own end is the NEXT segment's start — it was in effect right up until the
        // reading that changed it — and the last one runs to the range's own end (still in effect
        // right now), not to its own last-seen timestamp.
        segments.forEach((seg, i) => { seg.endMs = i + 1 < segments.length ? segments[i + 1].startMs : rangeEndMs; });
        // A gap before the very first reading (or the whole range, if there's no history at all —
        // prior or in-window) reads as an explicit "no data" stretch instead of silently starting
        // the bar part-way with nothing to its left. Only still reachable now when there's truly no
        // reading at all before this point, since priorRow above already seeds the common case.
        if (rangeStartMs != null) {
          const firstStart = segments.length ? segments[0].startMs : rangeEndMs;
          if (firstStart > rangeStartMs) segments.unshift({ label: 'No data', color: 'var(--border)', startMs: rangeStartMs, endMs: firstStart, noData: true });
        }
        return { monitor, segments };
      }));
      // For an unbounded "All" range there's no fixed clock start to anchor every bar to (unlike
      // a real range, where rangeStartMs above already came from the clock, not the data, and so
      // was already the same for every bar) — falls back to the EARLIEST first-segment start
      // across ALL bars, not just the first one, so a panel mixing an old and a recently-added
      // monitor still lines every bar up against the same left edge instead of each drifting to
      // wherever ITS OWN oldest reading happens to be.
      const effectiveRangeStartMs = rangeStartMs != null
        ? rangeStartMs
        : bars.reduce((earliest, bar) => {
            const firstMs = bar.segments[0] ? bar.segments[0].startMs : null;
            return firstMs != null && (earliest == null || firstMs < earliest) ? firstMs : earliest;
          }, null) ?? rangeEndMs;
      return { ...base, bars, rangeStartMs: effectiveRangeStartMs, rangeEndMs };
    }

    if (panel.panel_type === 'stat_delta') {
      const monitor = monitors[0] || null;
      const current = monitor ? await getCurrentValue(monitor.id) : null;
      const scale = config.scale || 1;
      const decimals = config.decimals != null ? config.decimals : await getDefaultPanelDecimals();
      let comparison = null;
      if (monitor) {
        const { sql: rangeSql, params: rangeParams } = historyWindowClause(range);
        comparison = await db.prepare(`SELECT numeric_value AS "numericValue" FROM monitor_history WHERE monitor_id = ?${rangeSql} ORDER BY recorded_at ASC LIMIT 1`).get(monitor.id, ...rangeParams);
      }
      const currentNumeric = current ? applyScale(current.value, scale) : null;
      const comparisonNumeric = comparison ? applyScale(comparison.numericValue, scale) : null;
      const delta = Number.isFinite(currentNumeric) && Number.isFinite(comparisonNumeric) ? currentNumeric - comparisonNumeric : null;
      const thresholdColor = Number.isFinite(currentNumeric) ? colorForThresholdLadder(currentNumeric, config.thresholds) : null;
      const displayCurrent = current ? { ...current, displayValue: Number.isFinite(currentNumeric) ? formatPanelValue(currentNumeric, decimals) : current.value } : null;
      const displayDelta = delta !== null ? formatPanelValue(Math.abs(delta), decimals) : null;
      const effectiveUnit = config.unit || (current ? extractLoxoneUnit(current.value) : null);
      return { ...base, monitor, current: displayCurrent, delta, displayDelta, thresholdColor, effectiveUnit };
    }

    return base; // chart: rendered client-side via /monitor/series.json
  }));
}

async function listOwnedDashboards(userId) {
  return db
    .prepare(
      `SELECT custom_dashboards.*, COUNT(dashboard_panels.id) AS "panelCount",
              (SELECT COUNT(*) FROM dashboard_shares WHERE dashboard_shares.dashboard_id = custom_dashboards.id) AS "shareCount"
       FROM custom_dashboards LEFT JOIN dashboard_panels ON dashboard_panels.dashboard_id = custom_dashboards.id
       WHERE custom_dashboards.user_id = ?
       GROUP BY custom_dashboards.id ORDER BY custom_dashboards.position, custom_dashboards.id`
    )
    .all(userId);
}

// Union of two grant sources — shared with this exact user, or shared with a Role they currently
// hold — de-duplicated by dashboard (a dashboard could be reachable via both at once) with
// MAX(canEdit) so the more permissive of the two wins, same rule loadAccessibleDashboard uses.
async function listSharedWithMe(userId, roleId) {
  return db
    .prepare(
      `SELECT d.id, d.name, MAX(d.can_edit) AS "canEdit", d.owner_name AS "ownerName",
              (SELECT COUNT(*) FROM dashboard_panels WHERE dashboard_panels.dashboard_id = d.id) AS "panelCount"
       FROM (
         SELECT custom_dashboards.id, custom_dashboards.name, dashboard_shares.can_edit,
                COALESCE(users.display_name, users.username) AS owner_name
         FROM dashboard_shares
         JOIN custom_dashboards ON custom_dashboards.id = dashboard_shares.dashboard_id
         JOIN users ON users.id = custom_dashboards.user_id
         WHERE dashboard_shares.user_id = ?
         UNION
         SELECT custom_dashboards.id, custom_dashboards.name, dashboard_role_shares.can_edit,
                COALESCE(users.display_name, users.username) AS owner_name
         FROM dashboard_role_shares
         JOIN custom_dashboards ON custom_dashboards.id = dashboard_role_shares.dashboard_id
         JOIN users ON users.id = custom_dashboards.user_id
         WHERE dashboard_role_shares.role_id = ?
       ) d
       GROUP BY d.id, d.name, d.owner_name ORDER BY d.name`
      // Kept snake_case (can_edit/owner_name) through every reference inside this query, and only
      // renamed to camelCase (quoted, so Postgres doesn't fold it) in the outermost SELECT — an
      // outer reference to an inner ALIAS's camelCase name would need quoting too on Postgres, but
      // a quoted identifier there is a syntax error on MySQL/MariaDB (without ANSI_QUOTES, which
      // this app doesn't set); staying snake_case until the very last SELECT sidesteps that
      // entirely, since an already-lowercase name never needs quoting or folds to anything else.
      // SQLite tolerates selecting d.name/d.owner_name ungrouped (it just picks a row per d.id's
      // own group without complaint); Postgres requires every selected column to be in the GROUP
      // BY or wrapped in an aggregate. Safe to add both here — they're derived from the exact same
      // custom_dashboards/users join in both UNION halves, so they can never actually differ for
      // the same d.id regardless of which branch contributed it.
    )
    .all(userId, roleId || 0);
}

// Every dashboard id this user could actually open — own + shared-with-them/their-role + the one
// shared home Dashboard (user_id IS NULL, open to anyone with the `dashboard` Access Role's own
// view permission, same rule loadAccessibleDashboard applies). Used by the Monitor list page to
// only show a "Dashboard" badge the viewer can actually click through to — the badge itself has no
// ownership filter of its own (a monitor can be used on ANY dashboard, not just this viewer's), so
// without this a monitor's badge could point at another user's un-shared personal dashboard,
// something "My Dashboards" would never list and clicking through would just 403 on.
async function listAccessibleDashboardIds(userId, roleId) {
  const ids = new Set((await listOwnedDashboards(userId)).map((d) => d.id));
  (await listSharedWithMe(userId, roleId)).forEach((d) => ids.add(d.id));
  (await db.prepare('SELECT id FROM custom_dashboards WHERE user_id IS NULL').all()).forEach((d) => ids.add(d.id));
  return ids;
}

// Everyone but the current user — the pool a dashboard's "Add" share form picks from. Small
// enough (this app's own user base, not a customer list) that listing everyone and letting the
// view skip already-shared ones is simpler than a NOT IN subquery per dashboard.
async function listOtherUsers(userId) {
  return db.prepare('SELECT id, username, display_name FROM users WHERE id != ? ORDER BY username').all(userId);
}

async function listShares(dashboardId) {
  return db
    .prepare(
      `SELECT users.id AS "userId", COALESCE(users.display_name, users.username) AS name, dashboard_shares.can_edit AS "canEdit"
       FROM dashboard_shares JOIN users ON users.id = dashboard_shares.user_id
       WHERE dashboard_shares.dashboard_id = ? ORDER BY name`
    )
    .all(dashboardId);
}

// Role-based grants (admin-only to add/remove, see the /share-role routes below) — every user
// holding that Access Role gets access, without the owner picking each of them out individually.
async function listRoleShares(dashboardId) {
  return db
    .prepare(
      `SELECT access_roles.id AS "roleId", access_roles.name, dashboard_role_shares.can_edit AS "canEdit"
       FROM dashboard_role_shares JOIN access_roles ON access_roles.id = dashboard_role_shares.role_id
       WHERE dashboard_role_shares.dashboard_id = ? ORDER BY access_roles.name`
    )
    .all(dashboardId);
}

async function listRoles() {
  return db.prepare('SELECT id, name FROM access_roles ORDER BY name').all();
}

async function loadDashboardsPageData(req) {
  const dashboards = await listOwnedDashboards(req.session.userId);
  const sharedWithMe = await listSharedWithMe(req.session.userId, req.user && req.user.roleId);
  const otherUsers = await listOtherUsers(req.session.userId);
  const roles = await listRoles();
  // The star toggle on each row (see dashboards.ejs) — a plain id Set is enough here since both
  // lists' rows just need a yes/no, not the full favorite-dashboards sidebar query (that one also
  // fetches names/re-verifies access, neither of which is needed once a row already IS the result
  // of an access-checked list like these two).
  const favoriteIds = new Set(
    (await db.prepare('SELECT dashboard_id FROM dashboard_favorites WHERE user_id = ?').all(req.session.userId)).map((r) => r.dashboard_id)
  );
  dashboards.forEach((d) => { d.isFavorited = favoriteIds.has(d.id); });
  sharedWithMe.forEach((d) => { d.isFavorited = favoriteIds.has(d.id); });
  const shares = {};
  const roleShares = {};
  for (const d of dashboards) {
    shares[d.id] = await listShares(d.id);
    roleShares[d.id] = await listRoleShares(d.id);
  }
  return { dashboards, sharedWithMe, otherUsers, roles, shares, roleShares };
}

router.get('/', asyncHandler(async (req, res) => {
  res.render('dashboards', { ...(await loadDashboardsPageData(req)), error: null });
}));

router.post('/', asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.render('dashboards', { ...(await loadDashboardsPageData(req)), error: 'Name is required.' });
  }

  const maxPos = (await db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM custom_dashboards WHERE user_id = ?').get(req.session.userId)).m;
  const newId = await db.insertReturningId(
    'INSERT INTO custom_dashboards (user_id, name, position, created_at) VALUES (?, ?, ?, ?)',
    [req.session.userId, name, maxPos + 1, new Date().toISOString()]
  );

  res.redirect(`/dashboards/${newId}`);
}));

router.post('/:id/rename', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canManageDashboard(dashboard, req)) return forbidden(res);

  const name = (req.body.name || '').trim();
  if (name) await db.prepare('UPDATE custom_dashboards SET name = ? WHERE id = ?').run(name, dashboard.id);
  res.redirect(req.body.redirect_to ? safeDashboardRedirect(dashboard, req.body.redirect_to) : (isShared(dashboard) ? '/' : '/dashboards'));
}));

// Only ever '/dashboards' (the list, where a row's own star button lives) or '/dashboards/<id>'
// (a dashboard's own detail page) — never trusted as-is, since a submitted form field is fully
// attacker-editable (unlike, say, a Referer header) and an unchecked redirect target is an open
// redirect. Falls back to the list page for anything that isn't exactly one of those shapes.
function safeDashboardRedirect(dashboard, redirectTo) {
  if (redirectTo === '/dashboards' || redirectTo === `/dashboards/${dashboard.id}`) return redirectTo;
  return '/dashboards';
}

// Pinning a dashboard into the sidebar (see "Favorite Dashboards" under Monitor in
// partials/head.ejs) is a personal bookmark, not a change to the dashboard itself — anyone who can
// currently SEE it (owner or a direct/role share) can star it for themselves, unlike
// rename/delete/share below which are all owner- or editor-gated.
router.post('/:id/favorite', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');

  await db.insertIgnore('dashboard_favorites', { user_id: req.session.userId, dashboard_id: dashboard.id }, ['user_id', 'dashboard_id']);
  res.redirect(safeDashboardRedirect(dashboard, req.body.redirect_to));
}));

router.post('/:id/unfavorite', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');

  await db.prepare('DELETE FROM dashboard_favorites WHERE user_id = ? AND dashboard_id = ?').run(req.session.userId, dashboard.id);
  res.redirect(safeDashboardRedirect(dashboard, req.body.redirect_to));
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (isShared(dashboard)) return forbidden(res); // the shared home Dashboard can't be deleted, only its panels
  if (!canManageDashboard(dashboard, req)) return forbidden(res);

  // No PRAGMA foreign_keys enforcement in this DB (see db.js) — every OTHER user's star on this
  // dashboard has to be cleaned up explicitly too, not just the deleting user's own.
  await db.prepare('DELETE FROM dashboard_favorites WHERE dashboard_id = ?').run(dashboard.id);
  await db.prepare('DELETE FROM custom_dashboards WHERE id = ?').run(dashboard.id);
  res.redirect('/dashboards');
}));

// Sharing a personal dashboard is owner-only (not delegated to a shared editor, and meaningless
// for the one user_id IS NULL home Dashboard, which is already visible app-wide) — isOwner, not
// the broader canManageDashboard, is the right gate here.
router.post('/:id/share', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (isShared(dashboard) || !isOwner(dashboard, req)) return forbidden(res);

  const rawIds = Array.isArray(req.body.user_ids) ? req.body.user_ids : (req.body.user_ids ? [req.body.user_ids] : []);
  const canEdit = req.body.can_edit ? 1 : 0;
  const existsUser = db.prepare('SELECT 1 FROM users WHERE id = ?');
  const ids = rawIds.map(Number).filter((id) => Number.isInteger(id) && id !== dashboard.user_id);
  for (const id of ids) {
    if (!(await existsUser.get(id))) continue;
    await db.upsert('dashboard_shares', { dashboard_id: dashboard.id, user_id: id, can_edit: canEdit }, ['dashboard_id', 'user_id']);
  }
  res.redirect('/dashboards');
}));

router.post('/:id/share/:userId/remove', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (isShared(dashboard) || !isOwner(dashboard, req)) return forbidden(res);

  await db.prepare('DELETE FROM dashboard_shares WHERE dashboard_id = ? AND user_id = ?').run(dashboard.id, req.params.userId);
  res.redirect('/dashboards');
}));

// Sharing with a whole Access Role at once needs the dashboard_group_share permission on top of
// owner-only — handing out access to everyone in a group is a bigger, less reversible step than
// adding one trusted person, so it's a separate opt-in per role rather than implied by ownership.
function canManageRoleShares(dashboard, req) {
  return !isShared(dashboard) && isOwner(dashboard, req) && !!req.user && (req.user.isAdmin || !!req.user.permissions.dashboard_group_share?.edit);
}

router.post('/:id/share-role', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canManageRoleShares(dashboard, req)) return forbidden(res);

  const rawIds = Array.isArray(req.body.role_ids) ? req.body.role_ids : (req.body.role_ids ? [req.body.role_ids] : []);
  const canEdit = req.body.can_edit ? 1 : 0;
  const existsRole = db.prepare('SELECT 1 FROM access_roles WHERE id = ?');
  const ids = rawIds.map(Number).filter((id) => Number.isInteger(id));
  for (const id of ids) {
    if (!(await existsRole.get(id))) continue;
    await db.upsert('dashboard_role_shares', { dashboard_id: dashboard.id, role_id: id, can_edit: canEdit }, ['dashboard_id', 'role_id']);
  }
  res.redirect('/dashboards');
}));

router.post('/:id/share-role/:roleId/remove', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canManageRoleShares(dashboard, req)) return forbidden(res);

  await db.prepare('DELETE FROM dashboard_role_shares WHERE dashboard_id = ? AND role_id = ?').run(dashboard.id, req.params.roleId);
  res.redirect('/dashboards');
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canViewShared(dashboard, req)) return forbidden(res);

  const monitors = await db.prepare('SELECT id, label, source_type FROM monitors ORDER BY label').all();
  const panels = await loadPanelsWithMonitors(dashboard.id, req.query.range);

  // Only meaningful for a personal dashboard someone ELSE shared with the current user — the
  // owner sees no such hint on their own dashboards, and the shared home Dashboard has no single
  // owner to name.
  const sharedByOwner = !isShared(dashboard) && !isOwner(dashboard, req)
    ? (await db.prepare('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?').get(dashboard.user_id))?.name
    : null;
  const isFavorited = !!(await db.prepare('SELECT 1 FROM dashboard_favorites WHERE user_id = ? AND dashboard_id = ?').get(req.session.userId, dashboard.id));

  res.render('dashboard-detail', {
    dashboard,
    panels,
    monitors,
    error: null,
    canEditPanels: canMutate(dashboard, req),
    defaultPanelDecimals: await getDefaultPanelDecimals(),
    panelTypeDefaultsExist: await panelTypeDefaults.listDefaultTypes(dashboard.id),
    sharedByOwner,
    isFavorited,
    currentRange: req.query.range || '',
  });
}));

router.post('/:id/panels', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canMutate(dashboard, req)) return forbidden(res);

  const panelType = PANEL_TYPES.includes(req.body.panel_type) ? req.body.panel_type : null;
  const range = resolvePanelRange(req.body.range);
  let monitorIds = Array.isArray(req.body.monitor_ids) ? req.body.monitor_ids : (req.body.monitor_ids ? [req.body.monitor_ids] : []);
  monitorIds = monitorIds.map(Number).filter(Number.isInteger);
  if (SINGLE_MONITOR_TYPES.includes(panelType)) monitorIds = monitorIds.slice(0, 1); // one number in, one number out
  if (panelType === 'group_header') monitorIds = []; // a divider has none of its own, whatever the (hidden) checklist happened to submit

  if (!panelType || (monitorIds.length === 0 && panelType !== 'group_header')) {
    // Shared (home) and personal dashboards render through different pages (dashboard.ejs needs a
    // lot of home-page-only context this route doesn't have), so a validation failure here just
    // redirects back rather than trying to re-render the right one inline with an error message.
    return res.redirect(dashboardUrl(dashboard));
  }

  const config = JSON.stringify(buildConfig(panelType, req.body));
  const maxPos = (await db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM dashboard_panels WHERE dashboard_id = ?').get(dashboard.id)).m;

  // A fresh group_header always starts full-width/one row tall (a divider, not a card) — the
  // render loop in panel-grid.ejs re-enforces this on every load regardless, but starting the
  // stored value right keeps col_span/row_span truthful for anything else that reads them
  // directly (Auto-order's own area sort, say) before the panel's ever been touched again.
  const initialColSpan = panelType === 'group_header' ? 12 : 4;
  const initialRowSpan = panelType === 'group_header' ? 1 : 3;

  await db.transaction(async (tx) => {
    const panelId = await tx.insertReturningId(
      'INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, position, col_span, row_span) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [dashboard.id, panelType, req.body.title || null, range, config, maxPos + 1, initialColSpan, initialRowSpan]
    );
    for (let index = 0; index < monitorIds.length; index++) {
      await tx.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, ?)').run(panelId, monitorIds[index], index);
    }
  });

  res.redirect(dashboardUrl(dashboard));
}));

router.post('/:id/panels/:panelId/settings', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canMutate(dashboard, req)) return forbidden(res);

  const panel = await db.prepare('SELECT panel_type FROM dashboard_panels WHERE id = ? AND dashboard_id = ?').get(req.params.panelId, dashboard.id);
  if (!panel) return res.status(404).send('Panel not found');

  // Switching type is optional here (the field defaults to the panel's own current type when absent).
  const panelType = PANEL_TYPES.includes(req.body.panel_type) ? req.body.panel_type : panel.panel_type;
  const range = resolvePanelRange(req.body.range);
  const config = JSON.stringify(buildConfig(panelType, req.body));

  let monitorIds = Array.isArray(req.body.monitor_ids) ? req.body.monitor_ids : (req.body.monitor_ids ? [req.body.monitor_ids] : []);
  monitorIds = monitorIds.map(Number).filter(Number.isInteger);
  if (SINGLE_MONITOR_TYPES.includes(panelType)) monitorIds = monitorIds.slice(0, 1);
  if (panelType === 'group_header') monitorIds = []; // a divider has none of its own, whatever the (hidden) checklist happened to submit

  await db.transaction(async (tx) => {
    await tx.prepare('UPDATE dashboard_panels SET panel_type = ?, title = ?, range = ?, config = ? WHERE id = ? AND dashboard_id = ?')
      .run(panelType, req.body.title || null, range, config, req.params.panelId, dashboard.id);
    await tx.prepare('DELETE FROM dashboard_panel_monitors WHERE panel_id = ?').run(req.params.panelId);
    for (let index = 0; index < monitorIds.length; index++) {
      await tx.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, ?)').run(req.params.panelId, monitorIds[index], index);
    }
  });

  res.redirect(dashboardUrl(dashboard));
}));

router.post('/:id/panels/:panelId/duplicate', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canMutate(dashboard, req)) return forbidden(res);

  const panel = await db.prepare('SELECT * FROM dashboard_panels WHERE id = ? AND dashboard_id = ?').get(req.params.panelId, dashboard.id);
  if (!panel) return res.status(404).send('Panel not found');
  const monitorIds = (await db.prepare('SELECT monitor_id FROM dashboard_panel_monitors WHERE panel_id = ? ORDER BY position').all(panel.id)).map((r) => r.monitor_id);

  await db.transaction(async (tx) => {
    const maxPos = (await tx.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM dashboard_panels WHERE dashboard_id = ?').get(dashboard.id)).m;
    const newPanelId = await tx.insertReturningId(
      'INSERT INTO dashboard_panels (dashboard_id, panel_type, title, range, config, position, col_span, row_span) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [dashboard.id, panel.panel_type, panel.title ? `${panel.title} (copy)` : null, panel.range, panel.config, maxPos + 1, panel.col_span, panel.row_span]
    );
    for (let index = 0; index < monitorIds.length; index++) {
      await tx.prepare('INSERT INTO dashboard_panel_monitors (panel_id, monitor_id, position) VALUES (?, ?, ?)').run(newPanelId, monitorIds[index], index);
    }
  });

  res.redirect(dashboardUrl(dashboard));
}));

// Saves this panel's current appearance config as the house style for its panel_type — global
// (every dashboard, every editor), not tied to this specific panel's monitors/title/range. See
// panelTypeDefaults.js for how per-series settings (chart/value line colors etc.) get remapped by
// position rather than by monitor id, so the template still makes sense on a differently-wired panel.
router.post('/:id/panels/:panelId/save-as-default', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canMutate(dashboard, req)) return forbidden(res);

  const panel = await db.prepare('SELECT id FROM dashboard_panels WHERE id = ? AND dashboard_id = ?').get(req.params.panelId, dashboard.id);
  if (!panel) return res.status(404).send('Panel not found');

  await panelTypeDefaults.saveAsDefault(panel.id);
  res.redirect(dashboardUrl(dashboard));
}));

// Re-applies whatever's currently saved as this panel_type's house style — a no-op (redirects
// with nothing changed) if nothing's ever been saved for that type yet.
router.post('/:id/panels/:panelId/reset-to-default', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canMutate(dashboard, req)) return forbidden(res);

  const panel = await db.prepare('SELECT id FROM dashboard_panels WHERE id = ? AND dashboard_id = ?').get(req.params.panelId, dashboard.id);
  if (!panel) return res.status(404).send('Panel not found');

  await panelTypeDefaults.resetToDefault(panel.id);
  res.redirect(dashboardUrl(dashboard));
}));

// GridStack's own drag/resize 'change' event fires with every affected node's new x/y/w/h in one
// batch (see panel-grid.ejs's grid-init script) — this single endpoint updates every affected
// panel row in one request, replacing the role the old separate /panels/:panelId/resize and
// /panels/reorder routes used to serve (neither is referenced anywhere else in the app — the old
// pointer-based drag-reorder and corner-resize-drag scripts that posted to them are both deleted
// along with the hand-rolled skyline packer). x/y are GridStack's own explicit grid coordinates
// (see db.js's grid_x/grid_y columns); w/h reuse the same col_span/row_span columns/bounds the old
// resize route already validated against.
const MIN_GRID_XY = 0;
const MAX_GRID_XY = 1000; // sanity bound against a broken/malicious client value, not a design limit
// Cross-zone drag (see panel-grid.ejs's grid-init script: acceptWidgets:true lets a panel be
// dragged from one zone's GridStack instance into another) doesn't change WHICH group a panel
// belongs to on its own — group membership is still purely `position`-order-based (a panel
// between one group_header and the next), exactly as it was before this migration, and GridStack
// has no idea that concept exists. This is what actually moves it: renumbers every panel's
// `position` so the dragged one now falls right after whichever group it was dropped into (its
// LAST member, i.e. right before that group's own next boundary) — or, for a drop into zone 0
// (afterGroupId null), right before the first group_header, same "ungrouped" spot zone 0 always
// occupies. Fired from the target grid's own 'added' event, once per panel that actually crossed
// zones (a same-zone drag/resize only fires 'change', handled by /panels/layout below instead).
router.post('/:id/panels/:panelId/move-to-zone', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).json({ error: 'Dashboard not found' });
  if (!canMutate(dashboard, req)) return res.status(403).json({ error: 'Not authorized' });

  const panelId = Number(req.params.panelId);
  const afterGroupId = req.body.afterGroupId != null ? Number(req.body.afterGroupId) : null;

  const rows = await db.prepare('SELECT id, panel_type FROM dashboard_panels WHERE dashboard_id = ? ORDER BY position').all(dashboard.id);
  const moved = rows.find((r) => r.id === panelId);
  if (!moved) return res.status(404).json({ error: 'Panel not found' });
  const withoutMoved = rows.filter((r) => r.id !== panelId);

  let insertAt;
  if (afterGroupId === null) {
    insertAt = withoutMoved.findIndex((r) => r.panel_type === 'group_header');
    if (insertAt === -1) insertAt = withoutMoved.length;
  } else {
    const headerIdx = withoutMoved.findIndex((r) => r.id === afterGroupId);
    if (headerIdx === -1) return res.status(400).json({ error: 'Group not found' });
    let end = headerIdx + 1;
    while (end < withoutMoved.length && withoutMoved[end].panel_type !== 'group_header') end += 1;
    insertAt = end;
  }
  withoutMoved.splice(insertAt, 0, moved);

  await db.transaction(async (tx) => {
    for (let i = 0; i < withoutMoved.length; i++) {
      await tx.prepare('UPDATE dashboard_panels SET position = ? WHERE id = ?').run(i, withoutMoved[i].id);
    }
  });

  res.json({ ok: true });
}));

// Reorders whole GROUPS (a group_header plus every panel that currently follows it, up to the
// next group_header or the end — see the render loop's own zone-splitting logic in panel-grid.ejs
// for the exact same grouping rule) — dragging a group's own header (LoxRowReorder, panel-grid.ejs)
// sends the new header-id order here. Ungrouped panels (before the first header) always stay
// first regardless of what order is sent — they're not part of that sort list at all.
router.post('/:id/panels/reorder-groups', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).json({ error: 'Dashboard not found' });
  if (!canMutate(dashboard, req)) return res.status(403).json({ error: 'Not authorized' });

  const groupOrder = Array.isArray(req.body.groupOrder) ? req.body.groupOrder.map(Number) : [];
  const rows = await db.prepare('SELECT id, panel_type FROM dashboard_panels WHERE dashboard_id = ? ORDER BY position').all(dashboard.id);

  const ungrouped = [];
  const segments = new Map(); // header id -> [header row, ...member rows]
  let current = null;
  rows.forEach((r) => {
    if (r.panel_type === 'group_header') {
      current = [r];
      segments.set(r.id, current);
    } else if (current) {
      current.push(r);
    } else {
      ungrouped.push(r);
    }
  });

  // The set of ids actually sent must match the set of real groups exactly — a stale or malformed
  // order (a group that no longer exists, or one silently missing) would otherwise drop panels
  // from the renumbered list entirely, which the transaction below has no way to catch after the
  // fact since it only ever writes whatever it was given.
  const realIds = new Set(segments.keys());
  const sentIds = new Set(groupOrder);
  if (realIds.size !== sentIds.size || groupOrder.some((id) => !realIds.has(id))) {
    return res.status(400).json({ error: 'groupOrder must contain exactly the dashboard\'s current group ids' });
  }

  const reordered = ungrouped.concat(...groupOrder.map((id) => segments.get(id)));

  await db.transaction(async (tx) => {
    for (let i = 0; i < reordered.length; i++) {
      await tx.prepare('UPDATE dashboard_panels SET position = ? WHERE id = ?').run(i, reordered[i].id);
    }
  });

  res.json({ ok: true });
}));

router.post('/:id/panels/layout', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).json({ error: 'Dashboard not found' });
  if (!canMutate(dashboard, req)) return res.status(403).json({ error: 'Not authorized' });

  const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
  await db.transaction(async (tx) => {
    for (const row of updates) {
      const id = Number(row && row.id);
      if (!Number.isInteger(id)) continue;
      const x = clamp(row.x, MIN_GRID_XY, MAX_GRID_XY, 0);
      const y = clamp(row.y, MIN_GRID_XY, MAX_GRID_XY, 0);
      const colSpan = clamp(row.w, MIN_COL_SPAN, MAX_COL_SPAN, 4);
      const rowSpan = clamp(row.h, MIN_ROW_SPAN, MAX_ROW_SPAN, 3);
      await tx.prepare('UPDATE dashboard_panels SET grid_x = ?, grid_y = ?, col_span = ?, row_span = ? WHERE id = ? AND dashboard_id = ?')
        .run(x, y, colSpan, rowSpan, id, dashboard.id);
    }
  });

  res.json({ ok: true });
}));

router.post('/:id/panels/:panelId/delete', asyncHandler(async (req, res) => {
  const dashboard = await loadAccessibleDashboard(req.params.id, req);
  if (!dashboard) return res.status(404).send('Dashboard not found');
  if (!canMutate(dashboard, req)) return forbidden(res);

  await db.prepare('DELETE FROM dashboard_panels WHERE id = ? AND dashboard_id = ?').run(req.params.panelId, dashboard.id);
  res.redirect(dashboardUrl(dashboard));
}));

module.exports = router;
module.exports.loadPanelsWithMonitors = loadPanelsWithMonitors;
module.exports.getDefaultPanelDecimals = getDefaultPanelDecimals;
module.exports.serializeKeyValueLines = serializeKeyValueLines;
module.exports.serializeThresholdLadder = serializeThresholdLadder;
module.exports.serializeValueMappings = serializeValueMappings;
module.exports.parseValueMappings = parseValueMappings;
module.exports.serializeAnnotations = serializeAnnotations;
// Reused by routes/liveData.js's "Suggest dashboard" flow, which lets a bucket's panel type be
// overridden away from its own server-side default (see BUCKET_BY_KEY in dashboardSuggestions.js)
// — same type list, same single-vs-multi-monitor rule, and the same per-type config defaults a
// panel gets when created any other way, so a suggested panel never ends up in a shape the regular
// editor wouldn't also produce.
module.exports.PANEL_TYPES = PANEL_TYPES;
module.exports.SINGLE_MONITOR_TYPES = SINGLE_MONITOR_TYPES;
module.exports.buildConfig = buildConfig;
module.exports.listAccessibleDashboardIds = listAccessibleDashboardIds;
