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

  function formatTick(ms) {
    return new Date(ms).toLocaleString('en-GB', { timeZone: DISPLAY_TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // Chart.js's own default y-axis formatting already rounds sensibly — it's only replaced (and
  // that rounding lost) once a fixed decimal count or unit suffix needs appending. Format here
  // too, or float noise from its internal step math (20.4 becoming 20.400000000000006) prints
  // as literally typed.
  function formatAxisValue(value, decimals) {
    return value.toFixed(decimals);
  }

  // Draws each threshold as a horizontal dashed line across the plot area, in its own chosen
  // color, with a small label naming the value at the left edge — no external plugin needed
  // (chartjs-plugin-annotation isn't vendored here), just Chart.js's own public plugin hook API.
  // A plain object (not a class), created fresh per chart, since a plugin closes over that one
  // chart's own threshold list rather than looking it up by chart id on every draw.
  function makeThresholdPlugin(thresholds) {
    return {
      id: 'thresholdLines',
      afterDraw: function (chart) {
        if (!thresholds || thresholds.length === 0) return;
        var yScale = chart.scales.y;
        var area = chart.chartArea;
        var ctx = chart.ctx;
        ctx.save();
        thresholds.forEach(function (t) {
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
          ctx.textBaseline = 'bottom';
          ctx.fillText(String(t.value), area.left + 4, y - 2);
        });
        ctx.restore();
      },
    };
  }

  function initChartCanvas(canvas) {
    var monitorIds = canvas.dataset.monitorIds.split(',').map(Number).filter(function (n) { return Number.isInteger(n); });
    var range = canvas.dataset.range || '24h';
    // 'auto' (the default for any panel created before this setting existed) keeps the original
    // behavior — a legend only when there's something to distinguish (>1 monitor). 'off' hides it
    // even then; 'top'/'left'/'right' force it on regardless of monitor count.
    var legendPosition = canvas.dataset.legend || 'auto';
    var unit = canvas.dataset.unit || '';
    var decimals = parseInt(canvas.dataset.decimals, 10);
    if (!Number.isFinite(decimals)) decimals = 2;
    var thresholds = [];
    try { thresholds = JSON.parse(canvas.dataset.thresholds || '[]'); } catch (e) { /* malformed — just skip drawing any */ }
    // Per-series overrides — keyed by monitor id (see dashboards.js's parseSeriesConfig): a
    // series can rename itself, use its own unit instead of the panel-wide one, and/or move to a
    // second (right-hand) Y axis, for combining two differently-scaled/differently-unit'd
    // readings (e.g. temperature and humidity) on one chart the way Grafana's multi-axis does.
    var seriesConfig = {};
    try { seriesConfig = JSON.parse(canvas.dataset.series || '{}'); } catch (e) { /* malformed — no overrides */ }
    var chart = null;

    function render(series) {
      // First pass: which axis does each series use, and what's that axis's effective unit —
      // the first series assigned to an axis that set its own unit decides that whole axis's
      // unit (an axis can only display one), everything else on it falls back to that. The left
      // axis's fallback-of-last-resort is still the panel-wide unit, exactly as before this
      // per-series override existed.
      var axisUnit = { y: unit, y1: null };
      var usesRightAxis = false;
      series.forEach(function (s) {
        var override = seriesConfig[s.monitorId] || {};
        var axisId = override.axis === 'right' ? 'y1' : 'y';
        if (axisId === 'y1') usesRightAxis = true;
        var stillDefault = axisId === 'y' ? axisUnit.y === unit : !axisUnit.y1;
        if (override.unit && stillDefault) axisUnit[axisId] = override.unit;
      });

      var datasets = series.map(function (s, i) {
        var override = seriesConfig[s.monitorId] || {};
        var color = override.color || paletteColor(i);
        var axisId = override.axis === 'right' ? 'y1' : 'y';
        var displayName = override.name || s.label;
        var seriesUnit = override.unit || axisUnit[axisId] || '';
        return {
          label: displayName + (seriesUnit ? ' (' + seriesUnit + ')' : ''),
          data: s.rows.filter(function (r) { return r.numeric !== null; }).map(function (r) { return { x: new Date(r.t).getTime(), y: r.numeric }; }),
          borderColor: color,
          backgroundColor: color,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.15,
          yAxisID: axisId,
          _tooltipUnit: seriesUnit,
        };
      });

      if (chart) {
        chart.data.datasets = datasets;
        chart.update('none');
        return;
      }

      var showLegend = legendPosition === 'off' ? false : (legendPosition === 'auto' ? datasets.length > 1 : true);
      var resolvedPosition = (legendPosition === 'auto' || legendPosition === 'off') ? 'top' : legendPosition;

      var scales = {
        x: { type: 'linear', ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback: formatTick } },
        y: {
          beginAtZero: false,
          ticks: { callback: function (value) { return formatAxisValue(value, decimals) + (axisUnit.y ? ' ' + axisUnit.y : ''); } },
        },
      };
      // The right axis is only ever added when at least one series actually uses it — defining
      // an always-present, always-empty y1 would reserve its gutter space on every chart
      // regardless of whether anything is plotted against it.
      if (usesRightAxis) {
        scales.y1 = {
          beginAtZero: false,
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { callback: function (value) { return formatAxisValue(value, decimals) + (axisUnit.y1 ? ' ' + axisUnit.y1 : ''); } },
        };
      }

      chart = new Chart(canvas, {
        type: 'line',
        data: { datasets: datasets },
        // A per-instance plugin (registered here, not globally via Chart.register) — closes over
        // this canvas's own threshold list, since two chart panels on the same dashboard have
        // completely different thresholds.
        plugins: [makeThresholdPlugin(thresholds)],
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: showLegend, position: resolvedPosition },
            tooltip: {
              callbacks: {
                label: function (ctx) {
                  var v = typeof ctx.parsed.y === 'number' ? formatAxisValue(ctx.parsed.y, decimals) : ctx.formattedValue;
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

    function refresh() {
      fetch('/monitor/series.json?ids=' + monitorIds.join(',') + '&range=' + encodeURIComponent(range))
        .then(function (res) { return res.json(); })
        .then(function (data) { render(data.series); })
        .catch(function () { /* best-effort — keep showing the last known data */ });
    }

    refresh();
    setInterval(refresh, REFRESH_MS);
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
  var tbody = document.getElementById('monitor-history-body');
  if (meta && tbody) {
    var monitorId = meta.dataset.monitorId;
    var detailRange = meta.dataset.range;

    var renderTable = function (rows) {
      if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="2" class="empty">No readings in this range yet.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (r) {
        return '<tr><td>' + new Date(r.t).toLocaleString('en-GB', { timeZone: DISPLAY_TZ }) + '</td><td>' + r.value + '</td></tr>';
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
