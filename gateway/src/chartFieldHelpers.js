const { icon } = require('./icons');
const { serializeThresholdLadder, serializeAnnotations } = require('./routes/dashboards');

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

module.exports = { escAttr, unitField, scaleField, thresholdField, annotationField };
