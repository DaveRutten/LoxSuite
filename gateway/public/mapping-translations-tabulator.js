// Shared driver for both translation-table pages (mapping-translations.ejs / loxone-mapping-
// translations.ejs — the MQTT→Loxone and Loxone→MQTT directions of the exact same "value X
// becomes value Y" lookup table, differing only in copy and which permission area gates editing).
// Configured entirely from data-* attributes on the container, since each page's dataset is
// already server-rendered (small, per-mapping — no separate JSON endpoint needed): the rows
// themselves come from a sibling <script type="application/json"> tag instead of an ajaxURL.
(function () {
  var container = document.getElementById('mt-tabulator');
  if (!container) return;

  var rowsEl = document.getElementById('mt-rows');
  var rows = rowsEl ? JSON.parse(rowsEl.textContent) : [];
  var deleteBasePath = container.dataset.deleteBasePath;
  var canEdit = container.dataset.canEdit === '1';

  function deleteFormatter(cell) {
    if (!canEdit) return '';
    var v = cell.getRow().getData();
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'danger';
    btn.innerHTML = '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg> Delete';
    btn.addEventListener('click', function () {
      if (!window.confirm('Delete this translation?')) return;
      fetch(deleteBasePath + '/' + v.id + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { window.location.reload(); });
    });
    return btn;
  }

  initTabulatorTable({
    container: container,
    tableKey: location.pathname,
    columns: [
      { title: container.dataset.valueLabel, field: 'match_value', formatter: function (cell) { var c = document.createElement('code'); c.textContent = cell.getValue(); return c; }, headerSort: true, sorter: 'string' },
      { title: 'Becomes', field: 'output_value', formatter: function (cell) { var c = document.createElement('code'); c.textContent = cell.getValue(); return c; }, headerSort: true, sorter: 'string' },
      { title: 'Actions', field: 'actions', formatter: deleteFormatter, headerSort: false, resizable: false, width: 110 },
    ],
    data: rows,
    placeholder: 'No translations yet.',
    noControls: ['actions'],
    columnsBtn: 'mt-columns-btn',
    columnsPanel: 'mt-columns-panel',
  });
})();
