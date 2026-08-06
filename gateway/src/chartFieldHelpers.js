const { icon } = require('./icons');
const { serializeThresholdLadder, serializeAnnotations, serializeValueMappings } = require('./routes/dashboards');

// Shared chart-config field builders, registered as global EJS helpers (see app.locals in
// server.js) — originally lived only in panel-grid.ejs's own top block since it was the only
// consumer, moved here once the Monitor detail page's own chart settings became a second one,
// the same reasoning that already applies to toggleSwitch/icon/serializeThresholdLadder etc.
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// A <datalist> suggestion list is easy to miss — nothing marks the field as "has a dropdown" the
// way a <select> does, and whether clicking (rather than typing first) reveals every suggestion
// varies by browser. A real <select> is unambiguous: pick one of these, or the explicit
// "Custom..." option reveals a free-text field (wired up in panel-grid.ejs's own script).
const UNIT_PRESETS = ['°C', '°F', '%', 'W', 'kW', 'kWh', 'V', 'A', 'Hz', 'hPa', 'lux', 'ppm', 'bar', 'm³', 'dB'];
function unitField(fieldName, currentValue) {
  const isCustom = !!currentValue && !UNIT_PRESETS.includes(currentValue);
  let html = `<select class="unit-select" data-unit-name="${fieldName}"><option value="">(none)</option>`;
  UNIT_PRESETS.forEach((u) => {
    html += `<option value="${escAttr(u)}" ${currentValue === u ? 'selected' : ''}>${u}</option>`;
  });
  html += `<option value="__custom__" ${isCustom ? 'selected' : ''}>Custom&hellip;</option></select>`;
  html += `<input type="text" class="unit-custom-input" placeholder="Custom unit"
    value="${isCustom ? escAttr(currentValue) : ''}" style="margin-top:0.3rem; width:100%; ${isCustom ? '' : 'display:none;'}">`;
  return html;
}

// Same select-or-custom-input shape as unitField above, for a multiplier — a bare number input
// made "×0.001 for Wh -> kWh" something you had to already know to type correctly, where a preset
// list gets you there by picking the unit conversion you actually want. Mirrors the dashboard chart
// panel's own per-series scale picker (see panel-grid.ejs's buildScalePicker), which only exists as
// dynamically-created JS (built per comparison-series row, added/removed as monitors are checked) —
// this is the same preset list and behavior for a page (Monitor detail) that always has exactly one
// value and can render it as a plain static field instead.
const SCALE_PRESETS = [0.001, 0.01, 0.1, 1, 10, 100, 1000];
function scaleField(fieldName, currentValue) {
  const value = currentValue === null || currentValue === undefined || currentValue === '' ? 1 : Number(currentValue);
  const isCustom = !SCALE_PRESETS.includes(value);
  let html = `<select class="scale-select" data-scale-name="${fieldName}">`;
  SCALE_PRESETS.forEach((s) => {
    html += `<option value="${s}" ${!isCustom && value === s ? 'selected' : ''}>${s === 1 ? '&times;1 (none)' : '&times;' + s}</option>`;
  });
  html += `<option value="__custom__" ${isCustom ? 'selected' : ''}>Custom&hellip;</option></select>`;
  html += `<input type="number" step="any" class="scale-custom-input" placeholder="Scale"
    value="${isCustom ? escAttr(value) : ''}" style="margin-top:0.3rem; width:100%; ${isCustom ? '' : 'display:none;'}">`;
  return html;
}

// Grafana-style threshold ladder (see dashboards.js's parseThresholdLadder/colorForThresholdLadder)
// — a dynamic add/remove-row builder (value + color picker + line/band style per row), not a
// hand-typed "value=color" textarea; that hidden textarea still exists underneath and is what
// actually submits (kept in the exact same format buildConfig() already parses), just filled in by
// threshold-annotation-builder.js instead of typed directly. Collapsed by default unless there's
// already at least one threshold configured, so an unused feature doesn't take up space.
//
// allowNotify renders a per-row "Notify" checkbox (see notifications.js's checkThresholdLadderNotify)
// — only ever passed true from the Monitor detail page's own call site. Every dashboard-panel call
// site leaves it off: a monitor can sit on several panels each with its own independent ladder, so
// there's no single unambiguous one to evaluate for notifications there (see thresholdLadder.js's
// own header comment) — showing a checkbox that would silently do nothing on those forms would just
// be confusing, so it's opt-in per call site rather than a constant checked at evaluation time.
function thresholdField(fieldName, ladder, allowNotify) {
  return `<details class="threshold-builder-details" style="grid-column:1/-1;" ${ladder && ladder.length > 0 ? 'open' : ''}>
    <summary>Threshold colors (optional)</summary>
    <div class="threshold-builder" data-name="${fieldName}" ${allowNotify ? 'data-allow-notify="1"' : ''}>
      <div class="threshold-builder-rows"></div>
      <button type="button" class="btn-soft threshold-add-row">${icon('plus')} Add threshold</button>
      <textarea name="${fieldName}" class="threshold-builder-hidden" hidden>${escAttr(serializeThresholdLadder(ladder))}</textarea>
      <p class="hint" style="margin:0.4rem 0 0;">A reading is colored using the highest threshold it meets or exceeds. <strong>Style</strong> only visibly changes anything on a Chart panel: <strong>Line</strong> draws a dashed horizontal line at that value; <strong>Band</strong> fills the zone from that value up to the next threshold above it (or to the top of the chart, for the highest one) — everything else (Table, Gauge, Stat, Threshold indicator) only ever uses the color.${allowNotify ? ' Check "Notify" on a rung to also send it to the Notification Center when a reading enters it — evaluated from this page\'s own ladder only, not any dashboard panel\'s.' : ''}</p>
    </div>
  </details>`;
}

// Chart-only: a labeled vertical line at a fixed moment in time (see parseAnnotations in
// dashboards.js) — same collapsible dynamic-row-builder shape as thresholdField above, just keyed
// by a datetime instead of a reading value/threshold.
function annotationField(fieldName, list) {
  return `<details class="threshold-builder-details" style="grid-column:1/-1;" ${list && list.length > 0 ? 'open' : ''}>
    <summary>Annotations (optional)</summary>
    <div class="annotation-builder" data-name="${fieldName}">
      <div class="annotation-builder-rows"></div>
      <button type="button" class="btn-soft annotation-add-row">${icon('plus')} Add annotation</button>
      <textarea name="${fieldName}" class="annotation-builder-hidden" hidden>${escAttr(serializeAnnotations(list))}</textarea>
      <p class="hint" style="margin:0.4rem 0 0;">Marks a specific moment on the chart with a vertical line and label &mdash; e.g. "heating turned on".</p>
    </div>
  </details>`;
}

// Same shape as thresholdField() (a collapsible, dynamic add/remove-row builder over a hidden
// textarea in the exact format dashboards.js already parses) but for an EXACT value match rather
// than a >= ladder — each row is a value, the name to show instead of it, and an optional color of
// its own (its own color wins over the threshold ladder for that one value, since it's the more
// specific rule — see loadPanelsWithMonitors). Moved here (was originally only in panel-grid.ejs)
// once the Monitor detail page's own chart settings became a second consumer, same reasoning as
// the other fields in this file — a reading is sometimes a Loxone/MQTT enum (1 = Active, 50 =
// Resetting), not a continuous quantity, on a single-monitor chart exactly as much as it can be on
// a dashboard's 'value' panel.
function valueMappingField(fieldName, mappings) {
  return `<details class="threshold-builder-details" style="grid-column:1/-1;" ${mappings && mappings.length > 0 ? 'open' : ''}>
    <summary>Value names &amp; colors (optional)</summary>
    <div class="value-mapping-builder" data-name="${fieldName}">
      <div class="value-mapping-rows"></div>
      <button type="button" class="btn-soft value-mapping-add-row">${icon('plus')} Add value</button>
      <textarea name="${fieldName}" class="value-mapping-hidden" hidden>${escAttr(serializeValueMappings(mappings))}</textarea>
      <p class="hint" style="margin:0.4rem 0 0;">Shows the name instead of a matching reading's raw value — every row gets a color too, starting from a default you can pick your own instead of.</p>
    </div>
  </details>`;
}

// Shared range-picker: dropdown presets + a custom-duration text input ("3h", "10m") + a real
// absolute From/To date-time pair — one shared implementation of what used to be four separate
// ones (the dashboard-panel Range field, Monitor detail's own freeform text box, the Home/My
// Dashboards popover, and Logs' bare From/To pair with no presets at all), all driving the exact
// same server-side vocabulary (resolveRange/rangeToWindow in routes/monitor.js). The client-side
// sync behavior — only one of select/custom-input/absolute-hidden-input ever carries a `name` at
// a time, so the field always submits exactly one "range" value regardless of which mode is
// active — lives in public/range-picker.js, loaded once for the whole site (see partials/foot.ejs)
// rather than per-page, since every consumer needs the identical behavior.
const RANGE_PRESETS = [
  ['1h', 'Last hour'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All'],
];
const ABS_RANGE_RE = /^abs_(\d+)_(\d+)$/;
function rangeField(currentValue, opts) {
  opts = opts || {};
  const presetValues = RANGE_PRESETS.map((p) => p[0]);
  const absMatch = typeof currentValue === 'string' ? currentValue.match(ABS_RANGE_RE) : null;
  // Only the dashboard-panel Range field has anything to inherit FROM (the dashboard-wide
  // filter) — every other consumer (Monitor detail, Home/My Dashboards, Logs) has no such parent
  // to follow, so this option is off unless a call site explicitly asks for it.
  const isDashboardDefault = !!opts.includeDashboardDefault && currentValue === 'dashboard';
  const isBlank = !!opts.blankLabel && !currentValue;
  const isCustom = !!currentValue && !presetValues.includes(currentValue) && !absMatch && !isDashboardDefault;
  // autoSubmit: picking a plain preset immediately submits the enclosing <form> — right for every
  // read-only "filter this page" consumer (Monitor detail/Home/Logs), but NOT the dashboard panel
  // Range field, which lives inside its own auto-saving settings form instead (see
  // range-picker.js's own sync() for where this actually gets read).
  // Wrapped in its own inline-flex span (not left to whatever the parent happens to be) so the
  // custom-duration input always sits BESIDE the select — shrinking to fit rather than dropping
  // to its own line — regardless of whether the parent is a form-grid cell (Logs/dashboard panel
  // forms), a topbar row, or anything else. The absolute From/To pair still doesn't fit inline at
  // any reasonable width, so that one floats out to the right instead (see .range-field-inline in
  // style.css) — this wrapper's own position:relative is what gives it something to anchor to
  // everywhere, not just the one page that used to hand-roll that positioning itself.
  let html = '<span class="range-field-inline">';
  html += `<select class="range-select" data-range-name="range"${opts.autoSubmit ? ' data-auto-submit="1"' : ''}>`;
  if (opts.includeDashboardDefault) {
    // Follows the dashboard-wide time filter (see loadPanelsWithMonitors in dashboards.js) rather
    // than a real range of its own — the default for every new panel, so most panels move
    // together when that filter changes; picking one of the real ranges below instead pins THIS
    // panel to its own choice regardless of what the dashboard-wide filter says.
    html += `<option value="dashboard" ${isDashboardDefault ? 'selected' : ''}>Dashboard default</option>`;
  }
  // blankLabel: a page-level "no override" state (e.g. the Home/My Dashboards filter's own
  // "Default range", meaning every panel just uses its own saved range) — a DIFFERENT concept
  // from includeDashboardDefault above (that's one specific PANEL following the page-wide
  // filter); this is the page-wide filter itself having nothing active. Submits as an empty
  // string, which the resolveRange() call site treats the same as the param being absent.
  if (opts.blankLabel) {
    html += `<option value="" ${isBlank ? 'selected' : ''}>${opts.blankLabel}</option>`;
  }
  RANGE_PRESETS.forEach(([value, label]) => {
    html += `<option value="${value}" ${currentValue === value ? 'selected' : ''}>${label}</option>`;
  });
  html += `<option value="__custom__" ${isCustom ? 'selected' : ''}>Custom&hellip;</option>`;
  html += `<option value="__absolute__" ${absMatch ? 'selected' : ''}>Absolute range&hellip;</option></select>`;
  html += `<input type="text" class="range-custom-input" placeholder="e.g. 3h, 10m, 45s"
    value="${isCustom ? escAttr(currentValue) : ''}" style="${isCustom ? '' : 'display:none;'}">`;
  // Raw epoch ms (not a pre-formatted date string) — the actual datetime-local values are filled
  // in by client-side JS from these, specifically so they render in the BROWSER's own local
  // timezone. Formatting them here instead would use the server process's timezone (the Docker
  // container, always UTC — see dateFormat.js), silently showing the wrong moment to anyone not in
  // UTC themselves.
  html += `<div class="range-absolute-wrap" data-start-ms="${absMatch ? absMatch[1] : ''}" data-end-ms="${absMatch ? absMatch[2] : ''}"
    style="${absMatch ? '' : 'display:none;'}">
    <div><label style="font-size:0.7rem; margin-bottom:0.15rem;">From</label><input type="datetime-local" class="range-absolute-start"></div>
    <div><label style="font-size:0.7rem; margin-bottom:0.15rem;">To</label><input type="datetime-local" class="range-absolute-end"></div>
    <input type="hidden" class="range-absolute-hidden">
  </div>`;
  html += '</span>';
  return html;
}

module.exports = { escAttr, unitField, scaleField, thresholdField, annotationField, valueMappingField, rangeField };
