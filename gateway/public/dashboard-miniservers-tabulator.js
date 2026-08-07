// Home dashboard's own Miniservers summary — same engine, same data endpoint, and (via the
// Columns menu) the same full column set as the real Miniservers page, just with the Gateway/
// Client tree always expanded by default here (dataTreeStartExpanded:true, vs. that page's own
// collapsed-by-default) and only the original small column set visible out of the box. No row
// actions — this is a read-only summary; the real Miniservers page is where you act on one.
(function () {
  var container = document.getElementById('home-ms-tabulator');
  if (!container) return;

  function badge(text, cls) {
    var span = document.createElement('span');
    span.className = 'badge ' + cls;
    span.textContent = text;
    return span;
  }

  function statusFormatter(cell) {
    var v = cell.getRow().getData();
    var cls = v.status === 'online' ? 'badge-ok' : v.status === 'offline' ? 'badge-off' : 'badge-neutral';
    var wrap = document.createElement('span');
    wrap.className = 'badge badge-live ' + cls;
    wrap.textContent = v.statusLabel;
    return wrap;
  }

  function stateFormatter(cell) {
    var v = cell.getRow().getData();
    if (!v.stateLabel) return '-';
    return badge(v.stateLabel, v.stateBadgeClass || 'badge-neutral');
  }

  function gatewayClientFormatter(cell) {
    var v = cell.getRow().getData();
    if (v.gatewayRole === 'gateway') {
      return badge('Gateway · ' + v.gatewayClientCount + ' client' + (v.gatewayClientCount === 1 ? '' : 's'), 'badge-purple');
    }
    if (v.gatewayRole === 'client') {
      return badge('Client – ' + (v.gatewayClientOfName || '?'), 'badge-purple');
    }
    return badge('Standalone', 'badge-neutral');
  }

  function hostFormatter(cell) {
    var v = cell.getRow().getData();
    return v.host + ':' + v.httpPort;
  }

  function textOrDash(field) {
    return function (cell) {
      var value = cell.getValue();
      return value === null || value === undefined || value === '' ? '-' : value;
    };
  }

  var columns = [
    { title: 'Status', field: 'status', formatter: statusFormatter, headerSort: true, sorter: 'string' },
    { title: 'State', field: 'stateLabel', formatter: stateFormatter },
    { title: 'Firmware', field: 'firmwareVersion', formatter: textOrDash('firmwareVersion') },
    { title: 'Generation', field: 'generationLabel', formatter: textOrDash('generationLabel') },
    { title: 'CPU load', field: 'cpuLoad', formatter: textOrDash('cpuLoad') },
    { title: 'Heap', field: 'heapStatus', formatter: textOrDash('heapStatus') },
    { title: 'Tasks', field: 'numTasks', formatter: textOrDash('numTasks') },
    { title: 'Name', field: 'name', headerSort: true, sorter: 'string', minWidth: 180 },
    { title: 'Gateway Client', field: 'gatewayRole', formatter: gatewayClientFormatter },
    { title: 'Host', field: 'host', formatter: hostFormatter, headerSort: true, sorter: 'string' },
    { title: 'HTTPS', field: 'useHttps', formatter: function (cell) { return cell.getValue() ? 'yes' : 'no'; } },
    { title: 'User', field: 'username' },
    { title: 'Last checked', field: 'lastCheckedAt', formatter: textOrDash('lastCheckedAt') },
    { title: 'Last successful call', field: 'lastSuccessAt', formatter: textOrDash('lastSuccessAt') },
    { title: 'Last error', field: 'lastError', formatter: textOrDash('lastError') },
  ];

  initTabulatorTable({
    container: container,
    tableKey: '/:home-miniservers',
    columns: columns,
    defaultHidden: ['stateLabel', 'firmwareVersion', 'generationLabel', 'cpuLoad', 'heapStatus', 'numTasks', 'useHttps', 'username', 'lastCheckedAt'],
    noControls: ['name'],
    ajaxURL: '/miniservers/data.json',
    placeholder: 'No miniservers added yet.',
    dataTree: true,
    dataTreeChildField: '_children',
    dataTreeStartExpanded: true,
    dataTreeElementColumn: 'name',
    columnsBtn: 'home-ms-columns-btn',
    columnsPanel: 'home-ms-columns-panel',
  }).then(function (table) {
    if (!table) return;
    // Independent of the page's own liveSwap tbody-diffing (see partials/foot.ejs) — that
    // mechanism only knows how to replace a real <table>'s <tbody>, not Tabulator's own div-based
    // markup, so this table needs its own refresh loop. Matches the page's own refresh:5 cadence
    // (see the head include at the top of dashboard.ejs).
    setInterval(function () { table.replaceData(); }, 5000);
  });
})();
