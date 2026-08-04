// Drives every chart-capable canvas on a page: the Monitor detail page's single
// chart, and each chart panel on a custom dashboard (which can overlay 1..N
// monitors on one canvas for comparison). Each canvas is fully independent —
// its own monitor id list, range, Chart.js instance, and refresh loop.
//
// Categorical palette from the dataviz skill's validated default order
// (blue/orange/aqua/yellow/magenta/green/violet/red), re-validated against this
// app's own light (#ffffff) and dark (#1c1f26) surfaces — see style.css for the
// --surface tokens. Colors are assigned by a series' fixed position in the
// canvas's monitor-id list, never reassigned as data refreshes.
(function () {
  var LIGHT_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  var DARK_PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  var REFRESH_MS = 15000;
  // Registered once, globally — chartjs-plugin-zoom (see vendor/chartjs-plugin-zoom.min.js) only
  // actually pans/zooms a given chart when that chart's own options.plugins.zoom says so (set
  // per-canvas below from data-zoom), so registering it here is inert for every chart that doesn't
  // opt in. Guarded for pages that don't load the plugin script at all (only monitor-detail.ejs and
  // panel-grid.ejs's chart canvas need it) and for a stale cached HTML that predates it.
  if (typeof window.ChartZoom !== 'undefined' && typeof Chart !== 'undefined') {
    Chart.register(window.ChartZoom);
  }
  // Set server-side (see partials/head.ejs) from the Settings-configured display timezone — every
  // other date in the app is rendered by the server via dateFormat.js, but the chart's axis/
  // tooltip labels are built client-side from raw timestamps, so they need the same timezone
  // passed in explicitly rather than falling back to the browser's own (ambient, possibly wrong).
  var DISPLAY_TZ = (document.querySelector('meta[name="display-timezone"]') || {}).content || 'UTC';

  function isDarkTheme() {
    var explicit = document.documentElement.getAttribute('data-theme');
    if (explicit === 'dark') return true;
    if (explicit === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function paletteColor(index) {
    var palette = isDarkTheme() ? DARK_PALETTE : LIGHT_PALETTE;
    if (index < palette.length) return palette[index];
    // Beyond the validated palette, reuse the muted ink token rather than
    // generating a new hue — the dataviz skill's rule against cycled colors.
    return getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#888';
  }

  // The same solid color used for a series' line/legend swatch would read as an opaque block if
  // used as-is for the area fill under it — hiding the gridlines and, with more than one series
  // filled, making the chart unreadable where they overlap. Translucent instead, only for the fill.
  function hexToRgba(hex, alpha) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex; // not a plain #rrggbb (e.g. a CSS var fallback) — used as-is, opaque
    var n = parseInt(m[1], 16);
    return 'rgba(' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(',') + ',' + alpha + ')';
  }

  // Extracts the DISPLAY_TZ calendar-day key ("2026-07-31") for a timestamp — used to tell
  // whether a chart's plotted range ever crosses a day boundary, since that's the only time the
  // date actually needs to be part of an axis tick label at all (see dayKey usage below).
  function dayKey(ms) {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: DISPLAY_TZ });
  }

  // Chart.js's own default y-axis formatting already rounds sensibly — it's only replaced (and
  // that rounding lost) once a fixed decimal count or unit suffix needs appending. Format here
  // too, or float noise from its internal step math (20.4 becoming 20.400000000000006) prints
  // as literally typed.
  function formatAxisValue(value, decimals) {
    return value.toFixed(decimals);
  }

  // Draws each threshold either as a horizontal dashed line (the original behavior) or, for a
  // threshold whose own style is 'band' (see the Style column in panel-grid.ejs's threshold
  // builder), a translucent filled zone from that threshold's value up to the NEXT threshold's
  // value — or to the top of the currently-visible range if it's the last/highest one. No external
  // plugin needed (chartjs-plugin-annotation isn't vendored here), just Chart.js's own public
  // plugin hook API. A plain object (not a class), created fresh per chart, since a plugin closes
  // over that one chart's own threshold list rather than looking it up by chart id on every draw.
  function makeThresholdPlugin(thresholds) {
    return {
      id: 'thresholdLines',
      // Bands paint UNDER the data lines (so a line crossing a band stays legible on top of it);
      // the line-style thresholds still draw afterDraw, above everything, as before.
      beforeDatasetsDraw: function (chart) {
        if (!thresholds || thresholds.length === 0) return;
        var bands = thresholds.filter(function (t) { return t.style === 'band'; });
        if (bands.length === 0) return;
        var yScale = chart.scales.y;
        var area = chart.chartArea;
        var ctx = chart.ctx;
        ctx.save();
        bands.forEach(function (t, i) {
          // thresholds arrives pre-sorted ascending (see parseThresholdLadder) — the band above
          // this one (if any) caps it; the topmost band instead extends to the axis's own max.
          var next = thresholds[thresholds.indexOf(t) + 1];
          var topValue = next ? next.value : yScale.max;
          var yBottom = Math.min(area.bottom, yScale.getPixelForValue(t.value));
          var yTop = Math.max(area.top, yScale.getPixelForValue(topValue));
          if (yBottom <= area.top || yTop >= area.bottom) return; // fully out of view
          ctx.fillStyle = hexToRgba(t.color, 0.14);
          ctx.fillRect(area.left, yTop, area.right - area.left, yBottom - yTop);
        });
        ctx.restore();
      },
      afterDraw: function (chart) {
        if (!thresholds || thresholds.length === 0) return;
        var lines = thresholds.filter(function (t) { return t.style !== 'band'; });
        if (lines.length === 0) return;
        var yScale = chart.scales.y;
        var area = chart.chartArea;
        var ctx = chart.ctx;
        ctx.save();
        lines.forEach(function (t) {
          var y = yScale.getPixelForValue(t.value);
          if (y < area.top || y > area.bottom) return; // out of the currently visible range
          ctx.strokeStyle = t.color;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(area.left, y);
          ctx.lineTo(area.right, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = t.color;
          ctx.font = '11px sans-serif';
          // Flips the label to below the line instead of above it whenever there isn't enough
          // headroom to the chart area's own top edge to fit it — a threshold sitting near the top
          // (a tight y-range, or a value close to the axis max) would otherwise get its label
          // clipped clean off by the canvas's own edge.
          if (y - 12 < area.top) {
            ctx.textBaseline = 'top';
            ctx.fillText(String(t.value), area.left + 4, y + 2);
          } else {
            ctx.textBaseline = 'bottom';
            ctx.fillText(String(t.value), area.left + 4, y - 2);
          }
        });
        ctx.restore();
      },
    };
  }

  // A labeled vertical line at a fixed point in time (see parseAnnotations in dashboards.js) — e.g.
  // marking "heating turned on". Drawn the same no-external-plugin way as the threshold lines
  // above, just against the x-scale instead of y, with the label rotated to fit a narrow lane.
  function makeAnnotationPlugin(annotations) {
    return {
      id: 'timeAnnotations',
      afterDraw: function (chart) {
        if (!annotations || annotations.length === 0) return;
        var xScale = chart.scales.x;
        var area = chart.chartArea;
        var ctx = chart.ctx;
        ctx.save();
        annotations.forEach(function (a) {
          var x = xScale.getPixelForValue(a.time);
          if (x < area.left || x > area.right) return; // out of the currently visible range
          var color = a.color || (getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#888');
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(x, area.top);
          ctx.lineTo(x, area.bottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = color;
          ctx.font = '11px sans-serif';
          ctx.save();
          ctx.translate(x + 4, area.top + 2);
          ctx.rotate(Math.PI / 2);
          ctx.textBaseline = 'bottom';
          ctx.fillText(a.label, 0, 0);
          ctx.restore();
        });
        ctx.restore();
      },
    };
  }

  // Chart.js's own type strings for the ones that don't match this app's config vocabulary
  // 1:1 — 'polar_area'/'bar_compare' are this app's names (matching its own snake_case config
  // fields, and 'bar_compare' specifically distinguishing it from a true time-series bar chart —
  // see routes/dashboards.js's CHART_TYPES comment), Chart.js itself calls them 'polarArea'/'bar'.
  var CHARTJS_TYPE = { polar_area: 'polarArea', bar_compare: 'bar' };
  var SNAPSHOT_TYPES = ['bar_compare', 'doughnut', 'pie', 'polar_area', 'radar'];

  function initChartCanvas(canvas) {
    var monitorIds = canvas.dataset.monitorIds.split(',').map(Number).filter(function (n) { return Number.isInteger(n); });
    var range = canvas.dataset.range || '24h';
    var chartType = canvas.dataset.chartType || 'line';
    var isSnapshot = SNAPSHOT_TYPES.indexOf(chartType) !== -1;
    // 'auto' (the default for any panel created before this setting existed) keeps the original
    // behavior — a legend only when there's something to distinguish (>1 monitor). 'off' hides it
    // even then; 'top'/'left'/'right' force it on regardless of monitor count.
    var legendPosition = canvas.dataset.legend || 'auto';
    var unit = canvas.dataset.unit || '';
    var decimals = parseInt(canvas.dataset.decimals, 10);
    if (!Number.isFinite(decimals)) decimals = 2;
    // Multiplies every raw reading before it's plotted (see clampScale/applyScale in
    // routes/dashboards.js for the same math server-side) — e.g. a Wh reading needs *0.001 to
    // chart as kWh. Threshold lines (below) are drawn straight against the y-axis, which is
    // already scaled once the data itself is, so they need no separate scaling of their own —
    // just enter them in whatever unit the chart now shows.
    var scale = parseFloat(canvas.dataset.scale);
    if (!Number.isFinite(scale) || scale === 0) scale = 1;
    var thresholds = [];
    try { thresholds = JSON.parse(canvas.dataset.thresholds || '[]'); } catch (e) { /* malformed — just skip drawing any */ }
    var annotations = [];
    try { annotations = JSON.parse(canvas.dataset.annotations || '[]'); } catch (e) { /* malformed — just skip drawing any */ }
    // Per-series overrides — keyed by monitor id (see dashboards.js's parseSeriesConfig): a
    // series can rename itself, use its own unit instead of the panel-wide one, and/or move to a
    // second (right-hand) Y axis, for combining two differently-scaled/differently-unit'd
    // readings (e.g. temperature and humidity) on one chart the way Grafana's multi-axis does.
    var seriesConfig = {};
    try { seriesConfig = JSON.parse(canvas.dataset.series || '{}'); } catch (e) { /* malformed — no overrides */ }
    // false|'before'|'after'|'middle' — Chart.js's own vocabulary for this option (see
    // https://www.chartjs.org/docs/latest/charts/line.html#stepped). Anything else (absent,
    // legacy '1' from before this was a per-granularity value, ...) means off.
    var stepped = ['before', 'after', 'middle'].includes(canvas.dataset.stepped) ? canvas.dataset.stepped : false;
    var curveTension = parseFloat(canvas.dataset.tension);
    if (!Number.isFinite(curveTension)) curveTension = 0.15;
    var animationEnabled = canvas.dataset.animation === '1';
    var showPoints = canvas.dataset.points === '1';
    var yScaleType = canvas.dataset.yScaleType === 'logarithmic' ? 'logarithmic' : 'linear';
    var yMin = parseFloat(canvas.dataset.yMin);
    if (!Number.isFinite(yMin)) yMin = undefined;
    var yMax = parseFloat(canvas.dataset.yMax);
    if (!Number.isFinite(yMax)) yMax = undefined;
    var zoomEnabled = canvas.dataset.zoom === '1';
    // Line style per series — a solid line (the default, no override) plus a color-only override
    // both keep borderDash empty/borderWidth at 2; only 'solid-thick'/'dashed'/'dotted' change
    // either. Centralized here (not inlined per-dataset below) since it's also needed to build the
    // legend, which otherwise always drew a plain solid swatch regardless of the line's real style.
    var LINE_STYLES = {
      'solid-thick': { dash: [], width: 3.5 },
      dashed: { dash: [7, 4], width: 2 },
      dotted: { dash: [1, 3], width: 2 },
    };
    function lineStyleFor(styleKey) {
      return LINE_STYLES[styleKey] || { dash: [], width: 2 };
    }
    // The range's true fixed END (see rangeToWindow in routes/monitor.js) — only ever set for an
    // absolute (fixed from/to) range, since that's the one case "now" is the wrong right edge to
    // draw/extend up to (see axisMaxMs below). An ordinary relative range (24h, 7d, ...) always has
    // this null, so axisMaxMs falls through to real "now" for those exactly as before this existed.
    var rangeUntilMs = parseInt(canvas.dataset.rangeUntil, 10);
    if (!Number.isFinite(rangeUntilMs)) rangeUntilMs = null;
    var fillArea = canvas.dataset.fill === '1';
    var chart = null;
    // Whether the currently-plotted range spans more than one calendar day — recomputed on every
    // render() (initial draw AND each live refresh), so a chart doesn't need reloading for this to
    // stay correct as time passes. Read live by the tick callback below rather than baked into a
    // fixed format string, since Chart.js keeps calling the same callback function on every redraw
    // (including the fast chart.update('none') path, which never rebuilds `scales` itself) — a
    // closure variable it re-reads each call is what makes updating it here actually take effect.
    var showDate = true;
    function formatTick(ms) {
      var opts = { timeZone: DISPLAY_TZ, hour: '2-digit', minute: '2-digit' };
      if (showDate) { opts.month = 'short'; opts.day = 'numeric'; }
      return new Date(ms).toLocaleString('en-GB', opts);
    }

    function render(series) {
      // First pass: which axis does each series use, and what's that axis's effective unit —
      // the first series assigned to an axis that set its own unit decides that whole axis's
      // unit (an axis can only display one), everything else on it falls back to that. The left
      // axis's fallback-of-last-resort is still the panel-wide unit, exactly as before this
      // per-series override existed.
      var axisUnit = { y: unit, y1: null };
      // Same reasoning/tie-break as axisUnit above, for decimals — an axis's own tick labels are
      // one shared format, so on a multi-series dashboard chart whichever series was first assigned
      // to it decides for the whole axis. The Monitor detail page never has this ambiguity at all
      // (always exactly one series), so its own Decimals field always wins outright here.
      var axisDecimals = { y: decimals, y1: null };
      var usesRightAxis = false;
      series.forEach(function (s) {
        var override = seriesConfig[s.monitorId] || {};
        var axisId = override.axis === 'right' ? 'y1' : 'y';
        if (axisId === 'y1') usesRightAxis = true;
        var stillDefault = axisId === 'y' ? axisUnit.y === unit : !axisUnit.y1;
        if (override.unit && stillDefault) axisUnit[axisId] = override.unit;
        var decimalsStillDefault = axisId === 'y' ? axisDecimals.y === decimals : axisDecimals.y1 === null;
        if (override.decimals != null && decimalsStillDefault) axisDecimals[axisId] = override.decimals;
      });

      var nowMs = Date.now();
      // The right edge to draw/extend up to — real "now" for every ordinary relative range, but a
      // fixed point in the past for an absolute range (rangeUntilMs set), since "now" would be
      // wrong there (that range's own end already passed).
      var axisMaxMs = rangeUntilMs != null ? rangeUntilMs : nowMs;
      var earliestMs = null;

      var datasets = series.map(function (s, i) {
        var override = seriesConfig[s.monitorId] || {};
        var color = override.color || paletteColor(i);
        var axisId = override.axis === 'right' ? 'y1' : 'y';
        var displayName = override.name || s.label;
        var seriesUnit = override.unit || axisUnit[axisId] || '';
        // A series with its own scale multiplies on top of/instead of the panel-wide one (not
        // both) — same "this one override replaces the panel default entirely" relationship the
        // value panel's own per-monitor scale has with its (nonexistent) panel-wide equivalent.
        var seriesScale = override.scale != null ? override.scale : scale;
        var seriesDecimals = override.decimals != null ? override.decimals : decimals;
        // The API returns rows newest-first (ORDER BY recorded_at DESC) — sorted ascending here so
        // every later use of "first"/"last" in this array actually means earliest/most-recent.
        // Left unsorted, points[length-1] was the OLDEST reading, not the newest: the "hold flat to
        // now" step below appended {now, <oldest value>} and drew a straight segment connecting the
        // real oldest-to-newest zigzag's oldest point to that wrong value at the far right edge — a
        // spurious flat line cutting across the whole chart, often right along its bottom (whatever
        // that oldest reading happened to be).
        var points = s.rows.filter(function (r) { return r.numeric !== null; }).map(function (r) { return { x: new Date(r.t).getTime(), y: r.numeric * seriesScale }; });
        points.sort(function (a, b) { return a.x - b.x; });
        if (points.length) {
          if (earliestMs === null || points[0].x < earliestMs) earliestMs = points[0].x;
          var last = points[points.length - 1];
          // Holds the last known reading flat through to the axis's right edge — without this, the
          // line simply stopped at whenever that monitor last reported, leaving a blank gap between
          // there and the edge instead of reading as "still this value".
          if (last.x < axisMaxMs) points.push({ x: axisMaxMs, y: last.y });
        }
        var lineStyle = lineStyleFor(override.style);
        return {
          label: displayName + (seriesUnit ? ' (' + seriesUnit + ')' : ''),
          data: points,
          borderColor: color,
          backgroundColor: fillArea ? hexToRgba(color, 0.15) : color,
          fill: fillArea ? 'origin' : false,
          // Stepped/points are panel-wide (apply to every series alike, like Fill area) — line
          // style/width is per-series (see the Style column in the series builder), since the
          // whole point of styling one line differently is telling it apart from the others.
          stepped: stepped,
          pointRadius: showPoints ? 2.5 : 0,
          pointStyle: override.pointStyle || 'circle',
          pointBackgroundColor: color,
          borderDash: lineStyle.dash,
          borderWidth: lineStyle.width,
          tension: stepped ? 0 : curveTension, // Chart.js ignores tension on a stepped line anyway, but 0 is the honest value
          yAxisID: axisId,
          _tooltipUnit: seriesUnit,
          _tooltipDecimals: seriesDecimals,
        };
      });

      // The axis's own left edge — always the earliest surviving DATA point, not the range's
      // nominal start (e.g. "24h ago"). Pinning it to the nominal start was tried, on the reasoning
      // that it's more "honest" when monitor_history's MAX_ROWS cap truncates away older data than
      // the range asks for — but that just left a big blank gap eating most of the chart's width
      // whenever a monitor hadn't been running the full range yet (a brand new monitor, or the
      // truncation itself), which is worse than the auto-scaled small gap it was meant to fix. Auto
      // is also just correct for the "all" range, which has no fixed start at all to pin to.
      var axisMinMs = earliestMs;

      // The date only earns a place in the tick labels when the visible range actually crosses a
      // calendar-day boundary — a same-day chart repeating "31 Jul at ..." on every single tick is
      // pure noise once the hour:minute already disambiguates them from each other.
      showDate = axisMinMs !== null && dayKey(axisMinMs) !== dayKey(axisMaxMs);

      if (chart) {
        chart.data.datasets = datasets;
        chart.options.scales.x.max = axisMaxMs;
        if (axisMinMs !== null) chart.options.scales.x.min = axisMinMs;
        chart.update('none');
        return;
      }

      var showLegend = legendPosition === 'off' ? false : (legendPosition === 'auto' ? datasets.length > 1 : true);
      var resolvedPosition = (legendPosition === 'auto' || legendPosition === 'off') ? 'top' : legendPosition;

      var scales = {
        x: { type: 'linear', min: axisMinMs === null ? undefined : axisMinMs, max: axisMaxMs, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback: formatTick } },
        y: {
          type: yScaleType,
          // A logarithmic scale can't include zero/negative values at all — left undefined (no
          // forced beginAtZero) rather than false specifically for that case, since Chart.js's own
          // 'logarithmic' scale already ignores beginAtZero and picks a sensible positive floor.
          beginAtZero: yScaleType === 'linear' ? false : undefined,
          // 10% of headroom above/below the data's own min/max, so a line doesn't visually run
          // flush along the very top/bottom edge of the chart area — a no-op whenever min/max
          // below are explicitly set (a user-fixed axis range), since grace only ever pads an
          // auto-computed range, never overrides a forced one. Skipped entirely when the area under
          // the line is filled: 'fill: origin' below fills down to whichever axis edge is nearest
          // zero, so this same headroom would leave a visible gap between the filled area and BOTH
          // the top edge (above the line, never filled) and, once the range's auto min no longer
          // sits exactly at the axis's own edge, the bottom edge too — a filled chart already reads
          // as "full" flush against the edges without needing the padding a bare line benefits from.
          grace: fillArea ? undefined : '10%',
          min: yMin,
          max: yMax,
          ticks: { callback: function (value) { return formatAxisValue(value, axisDecimals.y) + (axisUnit.y ? ' ' + axisUnit.y : ''); } },
        },
      };
      // The right axis is only ever added when at least one series actually uses it — defining
      // an always-present, always-empty y1 would reserve its gutter space on every chart
      // regardless of whether anything is plotted against it.
      if (usesRightAxis) {
        scales.y1 = {
          beginAtZero: false,
          // Same reasoning as the left axis's own grace above — skipped when filled, since fillArea
          // (canvas.dataset.fill) applies panel-wide to every series regardless of which axis it's on.
          grace: fillArea ? undefined : '10%',
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { callback: function (value) { return formatAxisValue(value, axisDecimals.y1 != null ? axisDecimals.y1 : decimals) + (axisUnit.y1 ? ' ' + axisUnit.y1 : ''); } },
        };
      }

      chart = new Chart(canvas, {
        type: 'line',
        data: { datasets: datasets },
        // Per-instance plugins (registered here, not globally via Chart.register) — each closes
        // over this canvas's own threshold/annotation list, since two chart panels on the same
        // dashboard have completely different ones.
        plugins: [makeThresholdPlugin(thresholds), makeAnnotationPlugin(annotations)],
        options: {
          // Off by default (opt in per panel, see the Animate on load toggle) — the live 15s
          // refresh's own chart.update('none') call (below) already skips animation regardless of
          // this setting, so all this actually controls is first paint and hover/active
          // transitions, not a per-tick "jump" on every live update.
          animation: animationEnabled ? { duration: 400, easing: 'easeOutQuart' } : false,
          responsive: true,
          maintainAspectRatio: false,
          // Points usually aren't drawn (pointRadius: 0 unless Show points is on, see datasets
          // above), so Chart.js's default intersect:true hover mode would need the cursor exactly
          // on an invisible point — practically impossible on a line. 'index'+intersect:false finds
          // the nearest data point at the hovered x position instead, matching the other panel
          // types' feel, regardless of whether points are actually visible.
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: showLegend, position: resolvedPosition },
            // Only meaningfully active when data-zoom="1" (see the Zoom & pan toggle in
            // panel-grid.ejs) — chartjs-plugin-zoom is registered globally (harmless/inert for
            // every other chart) but each instance's own pan/zoom stays off unless enabled here.
            zoom: zoomEnabled ? {
              pan: { enabled: true, mode: 'x' },
              zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
              limits: { x: { min: 'original', max: 'original' } },
            } : { pan: { enabled: false }, zoom: { wheel: { enabled: false }, pinch: { enabled: false } } },
            tooltip: {
              callbacks: {
                // The x scale is 'linear' (raw epoch ms), not 'time', so Chart.js's own default
                // title would print the raw millisecond number — format it the same way the axis
                // ticks are (formatTick), so the tooltip actually reads as a date/time.
                title: function (items) {
                  return items.length ? formatTick(items[0].parsed.x) : '';
                },
                label: function (ctx) {
                  var d = ctx.dataset._tooltipDecimals != null ? ctx.dataset._tooltipDecimals : decimals;
                  var v = typeof ctx.parsed.y === 'number' ? formatAxisValue(ctx.parsed.y, d) : ctx.formattedValue;
                  var u = ctx.dataset._tooltipUnit;
                  return ctx.dataset.label + ': ' + v + (u ? ' ' + u : '');
                },
              },
            },
          },
          scales: scales,
        },
      });
    }

    // Polar Area/Doughnut/Pie/Radar/Bar-compare — a snapshot of each monitor's CURRENT value, not
    // a history. Deliberately a separate function from render() above rather than a conditional
    // threaded through it: the data shape is fundamentally different (one dataset, one point per
    // monitor, vs. one dataset per monitor plotted over time), and none of render()'s time-axis
    // machinery (thresholds, annotations, zoom, stepped/curve, the x-scale itself) applies here.
    function renderSnapshot(values) {
      var names = [];
      var data = [];
      var colors = [];
      var pointUnits = [];
      var pointDecimals = [];
      values.forEach(function (v, i) {
        var override = seriesConfig[v.monitorId] || {};
        var numeric = parseFloat(v.value);
        var seriesScale = override.scale != null ? override.scale : scale;
        names.push(override.name || v.label);
        data.push(Number.isFinite(numeric) ? numeric * seriesScale : null);
        colors.push(override.color || paletteColor(i));
        pointUnits.push(override.unit || unit);
        pointDecimals.push(override.decimals != null ? override.decimals : decimals);
      });

      var surfaceColor = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#fff';
      // Radar has ONE connected shape (not one mark per monitor), so unlike the others its own
      // fill/stroke aren't meaningfully "this monitor's color" — a low-opacity wash of the first
      // palette slot reads as "the shape", while each vertex still gets its own real color via
      // pointBackgroundColor so the per-monitor distinction isn't lost, just moved to the points.
      var isRadar = chartType === 'radar';
      var dataset = {
        label: unit || 'Value',
        data: data,
        backgroundColor: isRadar ? hexToRgba(colors[0] || paletteColor(0), 0.2) : colors,
        borderColor: isRadar ? (colors[0] || paletteColor(0)) : surfaceColor,
        borderWidth: isRadar ? 2 : 2,
        pointBackgroundColor: isRadar ? colors : undefined,
        pointBorderColor: isRadar ? colors : undefined,
        _pointUnits: pointUnits,
        _pointDecimals: pointDecimals,
      };

      if (chart) {
        chart.data.labels = names;
        chart.data.datasets = [dataset];
        chart.update('none');
        return;
      }

      var showLegend = legendPosition === 'off' ? false : (legendPosition === 'auto' ? values.length > 1 : true);
      var resolvedPosition = (legendPosition === 'auto' || legendPosition === 'off') ? 'top' : legendPosition;

      var scales;
      if (chartType === 'bar_compare') {
        scales = {
          x: { type: 'category' },
          y: { type: 'linear', beginAtZero: true, ticks: { callback: function (v) { return formatAxisValue(v, decimals) + (unit ? ' ' + unit : ''); } } },
        };
      } else if (chartType === 'polar_area' || chartType === 'radar') {
        // Chart.js's own radial-scale defaults (web/spoke lines, tick text) are a fixed dark gray
        // that reads fine on the light theme but all but disappears against a dark --surface — the
        // rest of this file never needed an explicit color here because a plain Cartesian x/y grid
        // happens to still read OK either way, but the radar/polar web really doesn't. Ticks also
        // get their own translucent "backdrop" box by default (meant to keep a tick number legible
        // over a busy filled shape it might sit on top of) — dropped in favor of just using the
        // same muted text color as everything else, same reasoning as the tooltip/legend text below.
        var radialMutedColor = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#888';
        var radialGridColor = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || 'rgba(128,128,128,0.3)';
        scales = {
          r: {
            beginAtZero: true,
            angleLines: { color: radialGridColor },
            grid: { color: radialGridColor },
            pointLabels: { color: radialMutedColor },
            ticks: {
              color: radialMutedColor,
              backdropColor: 'transparent',
              callback: function (v) { return formatAxisValue(v, decimals); },
            },
          },
        };
      } // doughnut/pie: no scales object at all — Chart.js doesn't use one for either.

      chart = new Chart(canvas, {
        type: CHARTJS_TYPE[chartType] || chartType,
        data: { labels: names, datasets: [dataset] },
        // Deliberately no plugins array here (unlike the line chart above) — the hand-written
        // threshold/annotation plugins both assume a linear time x-axis that simply doesn't exist
        // on any of these chart types, so they're never even offered a chance to draw on one.
        options: {
          animation: animationEnabled ? { duration: 400, easing: 'easeOutQuart' } : false,
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: showLegend, position: resolvedPosition },
            tooltip: {
              callbacks: {
                label: function (ctx) {
                  var d = ctx.dataset._pointDecimals[ctx.dataIndex];
                  var u = ctx.dataset._pointUnits[ctx.dataIndex];
                  var v = typeof ctx.parsed === 'number' ? ctx.parsed : (ctx.parsed && ctx.parsed.r);
                  var formatted = typeof v === 'number' ? formatAxisValue(v, d) : ctx.formattedValue;
                  return (ctx.label || '') + ': ' + formatted + (u ? ' ' + u : '');
                },
              },
            },
          },
          scales: scales,
        },
      });
    }

    // A live-updating flag, not a fetch abort — an in-flight request from right before a
    // teardown can still land after it; this just makes sure a very-late response can't call
    // render() (and so chart.update()) on a chart that's already been destroyed.
    var stopped = false;
    function refresh() {
      if (stopped) return;
      fetch('/monitor/series.json?ids=' + monitorIds.join(',') + '&range=' + encodeURIComponent(range))
        .then(function (res) { return res.json(); })
        .then(function (data) { if (!stopped) render(data.series); })
        .catch(function () { /* best-effort — keep showing the last known data */ });
    }

    // /monitor/current.json (not series.json) — a snapshot chart only ever needs each monitor's
    // single latest reading, never its history, so this skips the MAX_ROWS-bounded history query
    // series.json runs entirely (see that route's own comment in routes/monitor.js).
    function refreshSnapshot() {
      if (stopped) return;
      fetch('/monitor/current.json?ids=' + monitorIds.join(','))
        .then(function (res) { return res.json(); })
        .then(function (data) { if (!stopped) renderSnapshot(data.values); })
        .catch(function () { /* best-effort — keep showing the last known data */ });
    }

    var tick = isSnapshot ? refreshSnapshot : refresh;
    tick();
    var intervalId = setInterval(tick, REFRESH_MS);

    // Every settings-triggered auto-save on a chart panel (see panel-grid.ejs's applyPatch)
    // replaces this <canvas> with a brand new one and calls initChartCanvas() on THAT one —
    // without this, the OLD canvas's own refresh() kept firing forever in the background even
    // after its element left the document (setInterval doesn't know or care that its target is
    // gone), each one an independent, never-ending fetch loop stacking up with every edit.
    canvas._loxsuiteCleanup = function () {
      stopped = true;
      clearInterval(intervalId);
      if (chart) chart.destroy();
    };
  }

  document.querySelectorAll('canvas[data-monitor-ids]').forEach(initChartCanvas);
  // Exposed so the dashboard panel auto-save patch (see panel-grid.ejs) can start a freshly
  // swapped-in <canvas> — one that replaced an old chart panel's after its settings changed —
  // without needing this whole file's setup to run again from scratch.
  window.initChartCanvas = initChartCanvas;

  // Monitor detail page only: keep its raw-values table in sync too (chart
  // panels on a custom dashboard don't need this — their table panels already
  // refresh via the generic .panel-table swap in partials/foot.ejs).
  var meta = document.getElementById('monitor-meta');
  var groupsEl = document.getElementById('monitor-history-groups');
  if (meta && groupsEl) {
    var monitorId = meta.dataset.monitorId;
    var detailRange = meta.dataset.range;
    // Fixed for the page's lifetime (range only changes via a link, which reloads the page) — set
    // server-side by chooseGroupMode() in routes/monitor.js; the key/label format below must stay
    // in sync with that function's.
    var groupMode = meta.dataset.groupMode;

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    // Mirrors groupHistoryRows() in routes/monitor.js — rows arrive newest-first (server ORDER BY
    // recorded_at DESC), so groups and each group's own rows come out newest-first too.
    function groupRows(rows) {
      var groups = [];
      var current = null;
      rows.forEach(function (r) {
        var parts = {};
        new Intl.DateTimeFormat('en-GB', {
          timeZone: DISPLAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
        }).formatToParts(new Date(r.t)).forEach(function (p) { parts[p.type] = p.value; });
        var hour = parts.hour === '24' ? '00' : parts.hour;
        var key = groupMode === 'hour' ? (parts.year + '-' + parts.month + '-' + parts.day + '-' + hour) : (parts.year + '-' + parts.month + '-' + parts.day);
        if (!current || current.key !== key) {
          var label = groupMode === 'hour'
            ? (parts.day + '/' + parts.month + '/' + parts.year + ', ' + hour + ':00–' + String((Number(hour) + 1) % 24).padStart(2, '0') + ':00')
            : (parts.day + '/' + parts.month + '/' + parts.year);
          current = { key: key, label: label, rows: [] };
          groups.push(current);
        }
        current.rows.push(r);
      });
      return groups;
    }

    var renderTable = function (rows) {
      if (rows.length === 0) {
        groupsEl.innerHTML = '<table><thead><tr><th>Timestamp</th><th>Value</th></tr></thead><tbody><tr><td colspan="2" class="empty">No readings in this range yet.</td></tr></tbody></table>';
        return;
      }
      // Keep whatever the user had expanded/collapsed across this silent refresh — rebuilding
      // from scratch would otherwise re-collapse every group back to "only the newest open" every
      // 15s, undoing a click mid-review.
      var openKeys = {};
      groupsEl.querySelectorAll('details.history-group[open]').forEach(function (d) { openKeys[d.dataset.groupKey] = true; });
      var hadAnyGroupsBefore = groupsEl.querySelector('details.history-group') !== null;

      groupsEl.innerHTML = groupRows(rows).map(function (g, gi) {
        var isOpen = hadAnyGroupsBefore ? !!openKeys[g.key] : gi === 0;
        var rowsHtml = g.rows.map(function (r) {
          return '<tr><td>' + new Date(r.t).toLocaleString('en-GB', { timeZone: DISPLAY_TZ }) + '</td><td>' + escapeHtml(r.value) + '</td></tr>';
        }).join('');
        return '<details class="history-group" data-group-key="' + g.key + '"' + (isOpen ? ' open' : '') + '>' +
          '<summary>' + escapeHtml(g.label) + ' <span class="hint">(' + g.rows.length + ' reading' + (g.rows.length === 1 ? '' : 's') + ')</span></summary>' +
          '<table><thead><tr><th>Timestamp</th><th>Value</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
          '</details>';
      }).join('');
    };

    setInterval(function () {
      fetch('/monitor/' + monitorId + '/data.json?range=' + encodeURIComponent(detailRange))
        .then(function (res) { return res.json(); })
        .then(function (data) { renderTable(data.rows); })
        .catch(function () { /* best-effort */ });
    }, REFRESH_MS);
  }
})();
