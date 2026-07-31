// Multi-select + "Copy selection" for a Logs page's table (see logs-*.ejs's td/th.col-select) —
// checkbox per row, shift-click for a range like a file manager, a header checkbox to select
// everything currently loaded. Copies the visible text of every selected row, tab-separated per
// column, to the clipboard via window.copyToClipboard (see partials/foot.ejs).
(function () {
  var table = document.querySelector('.table-wrap table');
  if (!table) return;
  var selectAll = table.querySelector('thead .log-select-all');
  var copyBtn = document.querySelector('.log-copy-selection');
  var countEl = document.querySelector('.log-selection-count');
  var lastIndex = null;

  function rowCheckboxes() {
    return Array.prototype.slice.call(table.querySelectorAll('tbody > tr > td.col-select > input[type="checkbox"]'));
  }

  function refresh() {
    var boxes = rowCheckboxes();
    var checked = boxes.filter(function (b) { return b.checked; });
    boxes.forEach(function (b) { b.closest('tr').classList.toggle('log-row-selected', b.checked); });
    if (selectAll) {
      selectAll.checked = boxes.length > 0 && checked.length === boxes.length;
      selectAll.indeterminate = checked.length > 0 && checked.length < boxes.length;
    }
    if (copyBtn) copyBtn.disabled = checked.length === 0;
    if (countEl) countEl.textContent = checked.length > 0 ? (checked.length + ' selected') : '';
  }

  // Read by partials/foot.ejs's live-refresh loop (postponed the same way it already postpones
  // for an open Columns menu) — a swap mid-selection would silently replace every selected row
  // with a fresh, unchecked one from the next poll.
  window.hasActiveLogSelection = function () {
    return rowCheckboxes().some(function (b) { return b.checked; });
  };

  document.addEventListener('click', function (e) {
    var box = e.target.closest('td.col-select input[type="checkbox"]');
    if (!box || !table.contains(box)) return;
    var boxes = rowCheckboxes();
    var index = boxes.indexOf(box);
    // Checkbox 'click' fires after the browser has already toggled .checked, so box.checked here
    // is the new state — extending that same new state across the range is what makes a
    // shift-click both select and deselect a run of rows, not just always check them.
    if (e.shiftKey && lastIndex !== null && index !== -1) {
      var from = Math.min(lastIndex, index), to = Math.max(lastIndex, index);
      for (var i = from; i <= to; i++) boxes[i].checked = box.checked;
    }
    lastIndex = index;
    refresh();
  });

  if (selectAll) {
    selectAll.addEventListener('change', function () {
      rowCheckboxes().forEach(function (b) { b.checked = selectAll.checked; });
      lastIndex = null;
      refresh();
    });
  }

  function selectOnly(index, boxes) {
    boxes.forEach(function (b, i) { b.checked = (i === index); });
  }

  function selectRange(fromIndex, toIndex, boxes, checked) {
    var from = Math.min(fromIndex, toIndex), to = Math.max(fromIndex, toIndex);
    for (var i = from; i <= to; i++) boxes[i].checked = checked;
  }

  // Clicking anywhere on a row — not just its checkbox — selects the way a file manager does: a
  // plain click selects only that row; Ctrl/Cmd-click OR Shift-click both extend the selection to
  // everything between the last-clicked row and this one (kept as two equivalent gestures rather
  // than splitting them into "range" vs. "toggle just this one", since a range is what's actually
  // wanted here either way). The checkbox's own click listener above stays purely additive (never
  // clears the rest of the selection) since that's the one deliberately-explicit "add/remove just
  // this row" control on the row.
  document.addEventListener('click', function (e) {
    if (e.target.closest('td.col-select')) return; // the checkbox listener above already handled this
    var row = e.target.closest('tbody > tr');
    if (!row || !table.contains(row)) return;
    // A drag across the row's text to copy it also ends in a 'click' on mouseup — bail rather than
    // hijacking that into a selection change just because the pointer came up over a row.
    if (window.getSelection && String(window.getSelection())) return;

    var boxes = rowCheckboxes();
    var box = row.querySelector('td.col-select input[type="checkbox"]');
    var index = boxes.indexOf(box);
    if (index === -1) return;

    if ((e.shiftKey || e.ctrlKey || e.metaKey) && lastIndex !== null) {
      selectRange(lastIndex, index, boxes, true);
    } else {
      selectOnly(index, boxes);
    }
    lastIndex = index;
    refresh();
  });

  document.addEventListener('click', function (e) {
    if (!copyBtn || !e.target.closest('.log-copy-selection')) return;
    var rows = rowCheckboxes().filter(function (b) { return b.checked; }).map(function (b) { return b.closest('tr'); });
    if (rows.length === 0) return;
    var text = rows.map(function (row) {
      return Array.prototype.slice.call(row.children)
        .filter(function (cell) { return !cell.classList.contains('col-select'); })
        .map(function (cell) { return cell.textContent.trim(); })
        .join('\t');
    }).join('\n');

    var label = copyBtn.querySelector('.btn-label');
    window.copyToClipboard(text).then(function () {
      var original = label.textContent;
      label.textContent = 'Copied!';
      // Clears the selection (and so releases the live-refresh pause above) rather than leaving
      // it checked — ready for a fresh selection instead of re-copying the same rows by accident.
      rowCheckboxes().forEach(function (b) { b.checked = false; });
      lastIndex = null;
      refresh();
      setTimeout(function () { label.textContent = original; }, 1500);
    });
  });

  // The live-refresh in foot.ejs (paused while hasActiveLogSelection() is true, but not on a
  // plain manual page reload/navigation) replaces the whole tbody with fresh, unchecked rows —
  // resync the toolbar to match instead of showing a stale "N selected" for rows that are gone.
  new MutationObserver(refresh).observe(table.querySelector('tbody'), { childList: true });

  refresh();
})();
