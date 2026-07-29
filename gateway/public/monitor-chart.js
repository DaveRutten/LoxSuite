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
    return new Date(ms).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // Chart.js's own default y-axis formatting already rounds sensibly — it's only replaced (and
  // that rounding lost) once a fixed decimal count or unit suffix needs appending. Format here
  // too, or float noise from its internal step math (20.4 becoming 20.400000000000006) prints
  // as literally typed.
  function formatAxisValue(value, decimals) {
    return value.toFixed(decimals);
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
    var chart = null;

    function render(series) {
      var datasets = series.map(function (s, i) {
        var color = paletteColor(i);
        return {
          label: s.label,
          data: s.rows.filter(function (r) { return r.numeric !== null; }).map(function (r) { return { x: new Date(r.t).getTime(), y: r.numeric }; }),
          borderColor: color,
          backgroundColor: color,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.15,
        };
      });

      if (chart) {
        chart.data.datasets = datasets;
        chart.update('none');
        return;
      }

      var showLegend = legendPosition === 'off' ? false : (legendPosition === 'auto' ? datasets.length > 1 : true);
      var resolvedPosition = (legendPosition === 'auto' || legendPosition === 'off') ? 'top' : legendPosition;

      chart = new Chart(canvas, {
        type: 'line',
        data: { datasets: datasets },
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
                  return ctx.dataset.label + ': ' + v + (unit ? ' ' + unit : '');
                },
              },
            },
          },
          scales: {
            x: { type: 'linear', ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback: formatTick } },
            y: {
              beginAtZero: false,
              ticks: { callback: function (value) { return formatAxisValue(value, decimals) + (unit ? ' ' + unit : ''); } },
            },
          },
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
        return '<tr><td>' + new Date(r.t).toLocaleString('en-GB') + '</td><td>' + r.value + '</td></tr>';
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
