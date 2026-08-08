// MQTT → Loxone mappings table, driven by the shared gateway/public/tabulator-table.js.
// Replaces the old page's own field-select + text "Filter…" combo with a single search box (see
// initTabulatorTable's own searchInput/searchFields) matching Topic/Miniserver/Transport/Target/
// Transform at once — a per-column headerFilter row (one small box under every column) was tried
// first here but read as visual clutter; one search bar per page, same as every other table.js
// table already has, was the actual preference.
(function () {
  var container = document.getElementById('m2l-tabulator');
  if (!container) return;

  function badge(text, cls) {
    var span = document.createElement('span');
    span.className = 'badge ' + cls;
    span.textContent = text;
    return span;
  }

  function statusFormatter(cell) {
    var v = cell.getRow().getData();
    var wrap = document.createElement('span');
    wrap.className = 'badge badge-live ' + (v.enabled ? 'badge-ok' : 'badge-neutral');
    wrap.textContent = v.enabled ? 'Active' : 'Off';
    return wrap;
  }

  function topicFormatter(cell) {
    var value = cell.getValue();
    var code = document.createElement('code');
    code.className = 'truncate';
    code.style.cssText = 'max-width:none; width:100%;';
    code.title = value;
    code.textContent = value;
    return code;
  }

  function transformFormatter(cell) {
    var v = cell.getRow().getData();
    var wrap = document.createElement('span');
    wrap.textContent = v.valueTransform;
    if (v.transformArg) {
      wrap.appendChild(document.createTextNode(' ('));
      var arg = document.createElement('span');
      arg.className = 'truncate';
      arg.title = v.transformArg;
      arg.textContent = v.transformArg;
      wrap.appendChild(arg);
      wrap.appendChild(document.createTextNode(')'));
    }
    return wrap;
  }

  function intervalFormatter(cell) {
    var value = cell.getValue();
    return value ? value + ' ms' : '-';
  }

  var ICONS = {
    edit: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>',
    power: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>',
    list: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  };

  function actionsFormatter(cell) {
    var v = cell.getRow().getData();
    if (!v.canEdit) return '';
    var wrap = document.createElement('div');
    wrap.className = 'row-actions';
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn-soft row-actions-toggle';
    toggle.setAttribute('aria-label', 'Actions');
    toggle.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      openTabulatorRowActionsPopover(toggle, function (actions, closePopover, ctx) { buildRowActions(actions, closePopover, ctx, v); });
    });
    wrap.appendChild(toggle);
    return wrap;
  }

  function buildRowActions(actions, closePopover, ctx, v) {
    var editLink = document.createElement('a');
    editLink.className = 'inline';
    editLink.href = '/mappings/mqtt-to-loxone/' + v.id + '/edit';
    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-edit';
    editBtn.innerHTML = ICONS.edit + ' Edit';
    editLink.appendChild(editBtn);
    actions.appendChild(editLink);

    if (v.valueTransform === 'translation_table') {
      var transLink = document.createElement('a');
      transLink.className = 'inline';
      transLink.href = '/mappings/mqtt-to-loxone/' + v.id + '/translations';
      var transBtn = document.createElement('button');
      transBtn.type = 'button';
      transBtn.className = 'btn-edit';
      transBtn.innerHTML = ICONS.list + ' Translations';
      transLink.appendChild(transBtn);
      actions.appendChild(transLink);
    }

    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn-edit';
    toggleBtn.innerHTML = ICONS.power + ' ' + (v.enabled ? 'Disable' : 'Enable');
    toggleBtn.addEventListener('click', function () {
      // Full reload, not just table.replaceData() — the toolbar's own "Enable all (N)/Disable all
      // (N)" counts are server-rendered from the same underlying data and would otherwise go stale
      // the instant a row's status changes here, same reasoning Delete below already follows.
      fetch('/mappings/mqtt-to-loxone/' + v.id + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { window.location.reload(); });
    });
    actions.appendChild(toggleBtn);

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger';
    delBtn.innerHTML = ICONS.trash + ' Delete';
    delBtn.addEventListener('click', function () {
      confirmInPopover(ctx, 'Delete this mapping?', function () {
        fetch('/mappings/mqtt-to-loxone/' + v.id + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function () { window.location.reload(); });
      });
    });
    actions.appendChild(delBtn);
  }

  initTabulatorTable({
    container: container,
    tableKey: '/mappings/mqtt-to-loxone',
    columns: [
      { title: 'Status', field: 'enabled', formatter: statusFormatter, headerSort: true, sorter: 'boolean' },
      { title: 'Topic', field: 'mqttTopic', formatter: topicFormatter, headerSort: true, sorter: 'string', minWidth: 220 },
      { title: 'Miniserver', field: 'miniserverName', headerSort: true, sorter: 'string' },
      { title: 'Transport', field: 'transport', headerSort: true, sorter: 'string' },
      { title: 'Target', field: 'target', headerSort: true, sorter: 'string' },
      { title: 'Transform', field: 'valueTransform', formatter: transformFormatter, headerSort: true, sorter: 'string' },
      { title: 'Min. interval', field: 'minIntervalMs', formatter: intervalFormatter, headerSort: true, sorter: 'number', hozAlign: 'left' },
      { title: 'Actions', field: 'actions', formatter: actionsFormatter, headerSort: false, resizable: false, width: 90 },
    ],
    ajaxURL: '/mappings/mqtt-to-loxone/data.json',
    placeholder: 'No mappings yet.',
    noControls: ['actions'],
    columnsBtn: 'm2l-columns-btn',
    columnsPanel: 'm2l-columns-panel',
    searchInput: 'm2l-search',
    searchClear: 'm2l-search-clear',
    searchFields: ['mqttTopic', 'miniserverName', 'transport', 'target', 'valueTransform'],
  });
})();
