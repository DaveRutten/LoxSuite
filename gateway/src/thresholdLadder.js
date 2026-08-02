// Grafana-style threshold ladder: each line is "<value>=<color>[=<style>][=<notify>]"; the color
// that applies to a given reading is the HIGHEST threshold the reading meets or exceeds (e.g.
// "1=orange, 2=red, 3=purple" means 0.5 stays uncolored, 1.5 is orange, 2.5 is red, 4 is purple) —
// not a single on/off alert the way the dedicated 'threshold' panel type's own config is. The
// optional third segment ('line', the default, or 'band') only means anything on a Chart panel's
// own plotted thresholds (see makeThresholdPlugin in monitor-chart.js); every other panel type
// that reuses this same builder for its value-coloring ladder (table/value/gauge/stat_delta) just
// ignores it. The optional fourth segment ('1' or omitted) marks a rung as notification-worthy —
// only evaluated against the Monitor detail page's own ladder (monitors.config.thresholds), not a
// dashboard panel's, since a monitor can sit on several panels with different ladders and there's
// no unambiguous single ladder to evaluate there (see notifications.js's checkThresholdLadderNotify).
//
// Moved here (originally lived in routes/dashboards.js) once notifications.js became a second
// consumer — that module is required by monitorCollector.js, which routes/dashboards.js itself
// requires, so a top-level require('./routes/dashboards') from notifications.js would close a
// cycle. These functions are pure and dependency-free, so a small leaf module sidesteps that
// entirely, the same move already made for chartFieldHelpers.js/toggleSwitch.js.

// A CSS-safe-ish check, not a full validator — just enough to stop something like
// "red; } body { display:none" (an attempted style injection via this free-text field) from ever
// reaching a rendered inline style="color: ...". Named colors, hex, rgb()/hsl() all pass. Also
// reused by routes/dashboards.js's parseValueMappings/parseAnnotations/parseSeriesConfig, which
// isn't threshold-ladder-specific but has no closer home of its own.
const SAFE_CSS_COLOR_RE = /^[a-zA-Z][a-zA-Z0-9]*$|^#[0-9a-fA-F]{3,8}$|^(rgb|hsl)a?\([0-9.,%\s]+\)$/;
function sanitizeColor(value) {
  return SAFE_CSS_COLOR_RE.test(value.trim()) ? value.trim() : null;
}

function parseThresholdLadder(text) {
  return (text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split('=');
    if (parts.length < 2) return null;
    const value = Number(parts[0]);
    const color = sanitizeColor(parts[1]);
    const style = parts[2] === 'band' ? 'band' : 'line';
    const notify = parts[3] === '1';
    if (!Number.isFinite(value) || !color) return null;
    return { value, color, style, notify };
  }).filter(Boolean).sort((a, b) => a.value - b.value);
}

function serializeThresholdLadder(ladder) {
  return (ladder || []).map((t) => {
    const base = `${t.value}=${t.color}=${t.style === 'band' ? 'band' : 'line'}`;
    return t.notify ? `${base}=1` : base;
  }).join('\n');
}

// The whole winning rung (value/color/style/notify), not just its color — colorForThresholdLadder
// below is a thin wrapper over this for every existing display-coloring call site, so the two can
// never drift out of sync with each other.
function matchedRung(numeric, ladder) {
  if (!Number.isFinite(numeric) || !ladder || ladder.length === 0) return null;
  let rung = null;
  for (const t of ladder) {
    if (numeric >= t.value) rung = t; // ladder is sorted ascending, so the last match wins
    else break;
  }
  return rung;
}

function colorForThresholdLadder(numeric, ladder) {
  return matchedRung(numeric, ladder)?.color ?? null;
}

module.exports = { sanitizeColor, parseThresholdLadder, serializeThresholdLadder, matchedRung, colorForThresholdLadder };
