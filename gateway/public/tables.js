// Drag-and-drop column reordering + show/hide, for every table inside a
// .table-wrap. Preferences are saved per logged-in user on the server (not
// localStorage), so they follow the user across browsers/devices.
(function () {
  // table -> { currentOrder, hiddenSet, columnCount }, so a tbody swapped in
  // from outside (see refreshTables below) can be re-tagged and have the
  // user's current order/hidden columns re-applied without rebuilding
  // anything else (columns menu, drag handlers on the header).
  var registry = new WeakMap();

  function tableKey(index) {
    return location.pathname + ':' + index;
  }

  function fetchPrefs(key) {
    return fetch('/api/table-prefs/' + encodeURIComponent(key)).then(function (res) { return res.json(); });
  }

  function savePrefs(key, order, hidden) {
    fetch('/api/table-prefs/' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: order, hidden: hidden }),
    }).catch(function () { /* best-effort */ });
  }

  // Cells are looked up by their stable data-original-index (tagged once in
  // initTable) rather than by current position, so this stays correct no
  // matter how many times it's called after previous reorders.
  function reorderRow(row, order) {
    var cells = Array.prototype.slice.call(row.children);
    if (cells.length !== order.length) return; // e.g. a colspan "empty" row — leave it alone
    var byOriginalIndex = {};
    cells.forEach(function (cell) { byOriginalIndex[cell.dataset.originalIndex] = cell; });
    order.forEach(function (originalIndex) {
      var cell = byOriginalIndex[originalIndex];
      if (cell) row.appendChild(cell);
    });
  }

  function applyOrder(table, order) {
    var headerRow = table.querySelector('thead tr');
    if (!headerRow) return;
    reorderRow(headerRow, order);
    table.querySelectorAll('tbody tr').forEach(function (row) { reorderRow(row, order); });
  }

  function applyHidden(table, hiddenSet) {
    var headerRow = table.querySelector('thead tr');
    if (!headerRow) return;
    var headers = Array.prototype.slice.call(headerRow.children); // live query, reflects current order

    headers.forEach(function (th, visualIndex) {
      var originalIndex = Number(th.dataset.originalIndex);
      var hide = hiddenSet.has(originalIndex);
      th.classList.toggle('col-hidden', hide);
      table.querySelectorAll('tbody tr').forEach(function (row) {
        if (row.children.length !== headers.length) return; // colspan "empty" row
        var cell = row.children[visualIndex];
        if (cell) cell.classList.toggle('col-hidden', hide);
      });
    });
  }

  // Built synchronously (before prefs are fetched) so the button doesn't
  // flash in and out of existence on pages that auto-refresh every few
  // seconds. Returns the checkboxes so callers can sync their checked state
  // once fetched prefs arrive.
  function buildColumnsMenu(table, headers, hiddenSet, onChange) {
    var wrap = table.closest('.table-wrap');
    if (!wrap) return null;

    var container = document.createElement('div');
    container.className = 'columns-menu';

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'columns-menu-btn';
    button.textContent = 'Columns';
    container.appendChild(button);

    var panel = document.createElement('div');
    panel.className = 'columns-menu-panel';
    panel.hidden = true;

    var checkboxesByIndex = {};

    headers.forEach(function (th) {
      var originalIndex = Number(th.dataset.originalIndex);
      var label = document.createElement('label');
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !hiddenSet.has(originalIndex);
      checkbox.addEventListener('change', function () {
        if (checkbox.checked) hiddenSet.delete(originalIndex);
        else hiddenSet.add(originalIndex);
        onChange();
      });
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(' ' + (th.textContent.trim() || 'Actions')));
      panel.appendChild(label);
      checkboxesByIndex[originalIndex] = checkbox;
    });

    button.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    });
    document.addEventListener('click', function () { panel.hidden = true; });

    container.appendChild(panel);
    wrap.parentNode.insertBefore(container, wrap);

    return checkboxesByIndex;
  }

  function initTable(table, index) {
    var headerRow = table.querySelector('thead tr');
    if (!headerRow) return;
    var columnCount = headerRow.children.length;
    if (columnCount < 2) return;

    var key = tableKey(index);
    var currentOrder = Array.from({ length: columnCount }, function (_, i) { return i; });

    // Tag every cell (header + body) with its original position so later
    // reorders can always find cells by identity instead of by index.
    [headerRow].concat(Array.prototype.slice.call(table.querySelectorAll('tbody tr'))).forEach(function (row) {
      if (row.children.length !== columnCount) return; // colspan "empty" row
      Array.prototype.slice.call(row.children).forEach(function (cell, i) {
        cell.dataset.originalIndex = i;
      });
    });

    var hiddenSet = new Set();
    var headers = Array.prototype.slice.call(headerRow.children);

    registry.set(table, { currentOrder: currentOrder, hiddenSet: hiddenSet, columnCount: columnCount });

    var checkboxesByIndex = buildColumnsMenu(table, headers, hiddenSet, function () {
      applyHidden(table, hiddenSet);
      savePrefs(key, currentOrder, Array.from(hiddenSet));
    });

    var dragSrcIndex = null;
    headers.forEach(function (th) {
      th.setAttribute('draggable', 'true');
      th.classList.add('draggable-col');
      th.title = 'Drag to reorder columns';

      th.addEventListener('dragstart', function () {
        dragSrcIndex = Array.prototype.indexOf.call(headerRow.children, th);
        th.classList.add('dragging');
      });
      th.addEventListener('dragend', function () { th.classList.remove('dragging'); });
      th.addEventListener('dragover', function (e) { e.preventDefault(); });
      th.addEventListener('drop', function (e) {
        e.preventDefault();
        var targetIndex = Array.prototype.indexOf.call(headerRow.children, th);
        if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;
        currentOrder.splice(targetIndex, 0, currentOrder.splice(dragSrcIndex, 1)[0]);
        applyOrder(table, currentOrder);
        applyHidden(table, hiddenSet);
        savePrefs(key, currentOrder, Array.from(hiddenSet));
      });
    });

    // Fetched asynchronously and merged into the already-rendered menu/table
    // (rather than building either from scratch) so nothing disappears or
    // flashes on pages that auto-refresh.
    fetchPrefs(key).then(function (prefs) {
      (prefs.hidden || []).forEach(function (i) {
        hiddenSet.add(i);
        if (checkboxesByIndex && checkboxesByIndex[i]) checkboxesByIndex[i].checked = false;
      });

      if (prefs.order && prefs.order.length === columnCount) {
        currentOrder.splice.apply(currentOrder, [0, currentOrder.length].concat(prefs.order));
        applyOrder(table, currentOrder);
      }
      applyHidden(table, hiddenSet);
    });
  }

  document.querySelectorAll('.table-wrap table').forEach(function (table, index) {
    initTable(table, index);
  });

  // Called after something outside this file has replaced a table's <tbody>
  // (e.g. a partial-refresh fetch) with fresh, originally-ordered rows: tags
  // them and re-applies this table's current order/hidden columns.
  window.refreshTables = function () {
    document.querySelectorAll('.table-wrap table').forEach(function (table) {
      var state = registry.get(table);
      if (!state) return;
      table.querySelectorAll('tbody tr').forEach(function (row) {
        if (row.children.length !== state.columnCount) return;
        Array.prototype.slice.call(row.children).forEach(function (cell, i) {
          cell.dataset.originalIndex = i;
        });
      });
      applyOrder(table, state.currentOrder);
      applyHidden(table, state.hiddenSet);
    });
  };
})();
