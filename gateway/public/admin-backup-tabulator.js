// Admin > Backups' own backup list — small, server-rendered dataset (embedded via the sibling
// #backup-rows JSON script tag, same "no separate endpoint needed for a handful of local files"
// reasoning as mapping-translations-tabulator.js), driven by the shared tabulator-table.js.
(function () {
  var container = document.getElementById('backup-tabulator');
  if (!container) return;

  var rowsEl = document.getElementById('backup-rows');
  var rows = rowsEl ? JSON.parse(rowsEl.textContent) : [];

  var ICONS = {
    download: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    upload: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    trash: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>',
  };

  function contentsFormatter(cell) {
    var v = cell.getRow().getData();
    var wrap = document.createElement('div');
    var db = document.createElement('span');
    db.className = 'badge badge-neutral';
    db.textContent = 'gateway.db';
    wrap.appendChild(db);
    if (v.includesMqttConfig) {
      var mqtt = document.createElement('span');
      mqtt.className = 'badge badge-neutral';
      mqtt.style.marginLeft = '0.3rem';
      mqtt.textContent = 'MQTT config';
      wrap.appendChild(mqtt);
    }
    return wrap;
  }

  function actionsFormatter(cell) {
    var v = cell.getRow().getData();
    var wrap = document.createElement('div');
    wrap.className = 'row-actions';
    // Unlike a real <td>, a Tabulator cell isn't matched by style.css's "td .row-actions {
    // flex-wrap: nowrap }" (Tabulator renders cells as plain divs, not actual table markup) — set
    // directly here so 3 buttons stay on one line instead of each wrapping the row taller.
    wrap.style.flexWrap = 'nowrap';

    var downloadLink = document.createElement('a');
    downloadLink.className = 'inline';
    downloadLink.href = '/admin/backup/' + encodeURIComponent(v.filename) + '/download';
    var downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'btn-soft';
    downloadBtn.innerHTML = ICONS.download + ' Download';
    downloadLink.appendChild(downloadBtn);
    wrap.appendChild(downloadLink);

    var restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'primary';
    restoreBtn.innerHTML = ICONS.upload + ' Restore';
    restoreBtn.addEventListener('click', function () {
      if (!window.confirm('Stage this backup for restore? It replaces the current database next time the gateway container restarts.')) return;
      fetch('/admin/backup/' + encodeURIComponent(v.filename) + '/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { window.location.reload(); });
    });
    wrap.appendChild(restoreBtn);

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger';
    deleteBtn.innerHTML = ICONS.trash + ' Delete';
    deleteBtn.addEventListener('click', function () {
      if (!window.confirm('Delete this backup?')) return;
      fetch('/admin/backup/' + encodeURIComponent(v.filename) + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { window.location.reload(); });
    });
    wrap.appendChild(deleteBtn);

    return wrap;
  }

  initTabulatorTable({
    container: container,
    tableKey: '/admin/backup',
    columns: [
      { title: 'Created', field: 'createdAt', headerSort: true, sorter: 'string' },
      { title: 'Size', field: 'size', formatter: function (cell) { return (cell.getValue() / 1024).toFixed(1) + ' KB'; }, headerSort: true, sorter: 'number', hozAlign: 'left' },
      { title: 'Contents', field: 'includesMqttConfig', formatter: contentsFormatter, headerSort: false },
      { title: 'Reason', field: 'reason', formatter: function (cell) { return cell.getValue() === 'scheduled' ? 'Scheduled' : 'Manual'; }, headerSort: true, sorter: 'string' },
      { title: 'Actions', field: 'actions', formatter: actionsFormatter, headerSort: false, resizable: false, minWidth: 320 },
    ],
    data: rows,
    placeholder: 'No backups yet — run one manually above or enable the schedule.',
    defaultHidden: ['reason'],
    noControls: ['actions'],
    columnsBtn: 'backup-columns-btn',
    columnsPanel: 'backup-columns-panel',
  });
})();
