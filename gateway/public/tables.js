// Drag-and-drop column reordering + show/hide + resize + click-to-sort, for every table inside a
// .table-wrap. Preferences are saved per logged-in user on the server (not
// localStorage), so they follow the user across browsers/devices.
(function () {
  // table -> { currentOrder, hiddenSet, widths, columnCount, sort: {index, dir} }, so a tbody
  // swapped in from outside (see refreshTables below) can be re-tagged and have the user's
  // current order/hidden/sort re-applied without rebuilding anything else (columns menu, drag
  // handlers on the header, the colgroup).
  var registry = new WeakMap();

  function tableKey(index) {
    return location.pathname + ':' + index;
  }

  function fetchPrefs(key) {
    return fetch('/api/table-prefs/' + encodeURIComponent(key)).then(function (res) { return res.json(); });
  }

  function savePrefs(key, state) {
    fetch('/api/table-prefs/' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: state.currentOrder, hidden: Array.from(state.hiddenSet), widths: state.widths }),
    }).catch(function () { /* best-effort */ });
  }

  // Cells (and <col>s) are looked up by their stable data-original-index (tagged once in
  // initTable) rather than by current position, so this stays correct no matter how many times
  // it's called after previous reorders.
  function reorderByOriginalIndex(parent, order) {
    var children = Array.prototype.slice.call(parent.children);
    if (children.length !== order.length) return; // e.g. a colspan "empty" row — leave it alone
    var byOriginalIndex = {};
    children.forEach(function (child) { byOriginalIndex[child.dataset.originalIndex] = child; });
    order.forEach(function (originalIndex) {
      var child = byOriginalIndex[originalIndex];
      if (child) parent.appendChild(child);
    });
  }

  function applyOrder(table, colgroup, order) {
    var headerRow = table.querySelector('thead tr');
    if (!headerRow) return;
    reorderByOriginalIndex(headerRow, order);
    table.querySelectorAll('tbody tr').forEach(function (row) { reorderByOriginalIndex(row, order); });
    if (colgroup) reorderByOriginalIndex(colgroup, order);
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

  // table-layout:auto only ever treats a <col>'s width as a hint — a column's own nowrap content
  // can still force it wider regardless, which is exactly why dragging a column narrower than its
  // text (or wider, for a .truncate cell — see style.css's .table-cols-fixed override) had no
  // visible effect. Freezing every OTHER column's current (auto-computed) width into a real pixel
  // value before switching the whole table to table-layout:fixed keeps them looking exactly as
  // they already did, while letting the actually-resized column go narrower (or wider) than its
  // own content from here on. The added class is what style.css keys off of to let .truncate
  // actually track the column's real width instead of its own fixed cap, once that's meaningful.
  // Idempotent — safe to call before the very first resize a table ever sees, not just once
  // widths are already known (applyWidths below), so a live drag switches layout immediately
  // instead of only taking effect after the next page load.
  function ensureFixedLayout(table, colgroup, widths) {
    if (!table || table.style.tableLayout === 'fixed') return;
    var headerRow = table.querySelector('thead tr');
    if (headerRow) {
      Array.prototype.forEach.call(headerRow.children, function (th) {
        var idx = th.dataset.originalIndex;
        if (idx == null || widths[idx]) return; // this one gets its real width from applyWidths below
        // A hidden column's th (display:none) measures as 0×0 — freezing that in would leave it
        // permanently collapsed even after being shown again from the Columns menu, visually
        // compressing every column after it and making the WRONG one line up under whichever
        // resize handle the user thinks they're dragging. Left with no explicit width instead —
        // table-layout:fixed gives it a share of whatever space is left over once it's visible.
        if (th.classList.contains('col-hidden')) return;
        var col = colgroup.querySelector('col[data-original-index="' + idx + '"]');
        if (col) col.style.width = th.getBoundingClientRect().width + 'px';
      });
    }
    table.style.tableLayout = 'fixed';
    table.classList.add('table-cols-fixed');
  }

  function applyWidths(colgroup, widths) {
    if (!colgroup) return;
    var table = colgroup.closest('table');
    if (table && Object.keys(widths).length > 0) ensureFixedLayout(table, colgroup, widths);
    Array.prototype.forEach.call(colgroup.children, function (col) {
      var px = widths[col.dataset.originalIndex];
      if (px) col.style.width = px + 'px';
    });
  }

  // A plain <table> has no columns to grab onto for a reliable width — table-layout:auto can
  // still widen/shrink an individual <td> based on what's in some other row entirely. A
  // <colgroup> with one <col> per column is the one part of the table the browser always
  // respects a set width on, regardless of cell content — built here rather than hand-added to
  // every view, since ~20 different table-bearing pages would otherwise all need the same markup.
  function buildColgroup(table, columnCount) {
    var existing = table.querySelector('colgroup');
    if (existing) return existing;
    var colgroup = document.createElement('colgroup');
    for (var i = 0; i < columnCount; i++) {
      var col = document.createElement('col');
      col.dataset.originalIndex = i;
      colgroup.appendChild(col);
    }
    table.insertBefore(colgroup, table.firstChild);
    return colgroup;
  }

  function addResizeHandle(th, colgroup, widths, onResized) {
    var handle = document.createElement('span');
    handle.className = 'col-resize-handle';
    th.appendChild(handle);

    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation(); // must not also start a column drag-reorder
      // stopPropagation only stops this file's own listeners — it doesn't stop the browser's
      // native HTML5 drag-and-drop detection, which watches the mousedown target's whole ancestor
      // chain for a draggable=true element (th, in this case) independently of JS event bubbling.
      // Disabling it for the duration of the resize is the only way to actually prevent that.
      th.draggable = false;
      var originalIndex = th.dataset.originalIndex;
      var col = colgroup.querySelector('col[data-original-index="' + originalIndex + '"]');
      if (!col) { th.draggable = true; return; }
      // Switched to fixed layout from the very first pixel of this drag, not just once it's saved
      // and the page reloads — otherwise the live drag itself still runs under table-layout:auto,
      // where a column's own nowrap content can silently override the width being dragged in.
      ensureFixedLayout(colgroup.closest('table'), colgroup, widths);
      var startX = e.clientX;
      var startWidth = th.getBoundingClientRect().width;
      // The handle's own CSS cursor:col-resize (see style.css) only shows while the mouse is
      // hovering its thin 10px strip — which a real drag moves off of immediately. Forced on
      // <body> for the drag's duration instead.
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        var next = Math.max(60, startWidth + (e.clientX - startX));
        col.style.width = next + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        th.draggable = true;
        // The mouseup that ends this drag is immediately followed by a 'click' on th (its own
        // listener checks this flag and bails) — cleared on a timeout rather than synchronously
        // here, since 'click' fires after this handler returns but still within the same event
        // sequence, before any timeout callback would run.
        th.dataset.justResized = '1';
        setTimeout(function () { delete th.dataset.justResized; }, 0);
        onResized(originalIndex, col.style.width ? parseFloat(col.style.width) : null);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Sorts by each row's cell text at the given original column index — good enough for the plain
  // text/number/date-string content every table here actually shows; not attempted for a colspan
  // "empty" row, which just stays wherever it already was.
  function applySort(table, sort) {
    if (!sort) return;
    var headerRow = table.querySelector('thead tr');
    var headers = Array.prototype.slice.call(headerRow.children);
    var visualIndex = headers.findIndex(function (th) { return Number(th.dataset.originalIndex) === sort.index; });
    if (visualIndex === -1) return;

    var tbody = table.querySelector('tbody');
    var rows = Array.prototype.slice.call(tbody.children).filter(function (row) {
      return row.children.length === headers.length;
    });

    rows.sort(function (a, b) {
      var av = (a.children[visualIndex].textContent || '').trim();
      var bv = (b.children[visualIndex].textContent || '').trim();
      var an = Number(av), bn = Number(bv);
      var cmp = (av !== '' && bv !== '' && !isNaN(an) && !isNaN(bn))
        ? an - bn
        : av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
      return sort.dir === 'desc' ? -cmp : cmp;
    });

    // A row's own expand-row(s) (Test/Rename/Reset-password/diagnostics/etc. — a single colspan'd
    // <td>, so the length filter above never included any of them in `rows`) have to move along
    // with it, or sorting strands every such detail panel wherever it originally sat instead of
    // following its own row. There can be MORE than one in a row: collapseRowActions() (above)
    // auto-collapses a >1-button Actions column into its own kebab + its own generated
    // .expand-row, inserted as the main row's immediate next sibling — a row using both that AND
    // a page-specific expand-row (e.g. Miniservers' diagnostics panel) ends up with two, back to
    // back. Collected as a whole run here, not just a single nextElementSibling check, so neither
    // gets left behind. Captured BEFORE this row's own appendChild — walking siblings after would
    // read the row's brand new neighbors at the tbody's current end, not the ones it actually had.
    //
    // Any of them that's open is force-collapsed INSTANTLY (transition disabled, then a
    // synchronous reflow via offsetHeight to make that actually take effect) rather than just
    // removing .open and letting its normal 0.2s transition run — the appendChild() moves below
    // fire immediately afterward, same tick, before a transition started by class removal alone
    // would have painted a single frame. Without forcing it synchronous first, the move still
    // carried the old "open" layout metrics with it, which is what the visible jump actually was.
    // "Which row was expanded" isn't state worth preserving through a full reorder anyway (unlike,
    // say, a half-filled edit form).
    rows.forEach(function (row) {
      var trailing = [];
      var sib = row.nextElementSibling;
      while (sib && sib.classList.contains('expand-row')) {
        trailing.push(sib);
        sib = sib.nextElementSibling;
      }
      trailing.forEach(function (expandRow) {
        if (!expandRow.classList.contains('open')) return;
        expandRow.style.transition = 'none';
        expandRow.classList.remove('open');
        void expandRow.offsetHeight; // forces layout now, with the collapsed state, before continuing
        expandRow.style.transition = '';
      });
      tbody.appendChild(row);
      trailing.forEach(function (expandRow) { tbody.appendChild(expandRow); });
    });
  }

  function updateSortIndicators(table, sort) {
    table.querySelectorAll('thead th .sort-indicator').forEach(function (el) { el.remove(); });
    if (!sort) return;
    var headerRow = table.querySelector('thead tr');
    var th = Array.prototype.slice.call(headerRow.children)
      .find(function (t) { return Number(t.dataset.originalIndex) === sort.index; });
    if (!th) return;
    var indicator = document.createElement('span');
    indicator.className = 'sort-indicator';
    indicator.textContent = sort.dir === 'desc' ? ' ▼' : ' ▲';
    th.appendChild(indicator);
  }

  // Built synchronously (before prefs are fetched) so the button doesn't
  // flash in and out of existence on pages that auto-refresh every few
  // seconds. Returns the checkboxes so callers can sync their checked state
  // once fetched prefs arrive.
  function buildColumnsMenu(table, headers, hiddenSet, onChange, onReset) {
    var wrap = table.closest('.table-wrap');
    if (!wrap) return null;

    // A page that already built its own toolbar directly above this table (see
    // .table-toolbar/.filterable-table-card in style.css, e.g. Live Data's search bar) gets the
    // Columns button appended into THAT toolbar instead of a second, separately-boxed strip of
    // its own — one attached toolbar reads as a whole; two stacked ones don't. Anything else
    // (most tables) gets the default self-contained strip, itself styled to attach to .table-wrap.
    var existingToolbar = wrap.previousElementSibling && wrap.previousElementSibling.classList.contains('table-toolbar')
      ? wrap.previousElementSibling
      : null;

    var container = document.createElement('div');
    container.className = existingToolbar ? 'columns-menu columns-menu-inline' : 'columns-menu';

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-soft';
    // Inlined rather than reusing src/icons.js's icon() helper — this file is a plain static
    // asset with no access to that server-side module — but kept visually identical to it
    // (same "columns" path, same .icon class the shared button/icon spacing CSS targets).
    button.innerHTML = '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/></svg>Columns';
    container.appendChild(button);

    var panel = document.createElement('div');
    panel.className = 'columns-menu-panel';
    panel.hidden = true;

    var checkboxesByIndex = {};
    var labelsByIndex = {};

    headers.forEach(function (th) {
      // A utility column with nothing to sort/resize/hide (e.g. the Logs pages' row-select
      // checkbox, see log-select.js) opts out via this attribute — listing it here would show a
      // blank-labelled ("Actions", the generic empty-header fallback below) entry that just hides
      // the one column a user can never actually want to hide, since it'd strand any already-
      // checked rows with no visible way to uncheck them.
      if (th.hasAttribute('data-no-controls')) return;
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
      labelsByIndex[originalIndex] = label;
    });

    var resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn-soft columns-menu-reset';
    resetBtn.textContent = 'Reset to default';
    resetBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      onReset();
      panel.hidden = true;
    });
    panel.appendChild(resetBtn);

    // Keeps the checkbox list in the same order the columns actually appear in — dragging a
    // column to reorder it (or a saved order from a previous session) would otherwise leave this
    // list showing the original left-to-right order forever, no longer matching the table.
    function resortToOrder(order) {
      order.forEach(function (originalIndex) {
        var label = labelsByIndex[originalIndex];
        if (label) panel.insertBefore(label, resetBtn);
      });
    }

    // Opens downward by default; a short table (few rows, e.g. right after creating one) can
    // leave less room below the button than this panel actually needs, running the bottom of
    // the checkbox list off the page instead of just scrolling it into view like a taller
    // table's page would. Flips to open upward whenever there's more room above the button
    // than below it and the panel doesn't actually fit in what's below — measured fresh on
    // every call since the viewport (and how many columns/rows exist) can change between opens,
    // and this same function also re-runs on scroll/resize while the panel stays open (see below).
    function reposition() {
      panel.style.maxHeight = ''; // clear any previous cap before measuring this open's natural height
      var buttonRect = button.getBoundingClientRect();
      var panelHeight = panel.getBoundingClientRect().height;
      var spaceBelow = window.innerHeight - buttonRect.bottom;
      var spaceAbove = buttonRect.top;
      var flipUp = panelHeight > spaceBelow && spaceAbove > spaceBelow;
      panel.classList.toggle('columns-menu-panel-flip-up', flipUp);

      // position:fixed (see .columns-menu-panel's own comment for why) has no positioned
      // ancestor to anchor a CSS top/right percentage against any more — set viewport-relative
      // coordinates here instead, right-aligned to the button's own right edge either way, with
      // only top vs. bottom flipping between the two open directions.
      panel.style.left = 'auto';
      panel.style.right = (window.innerWidth - buttonRect.right) + 'px';
      if (flipUp) {
        panel.style.top = 'auto';
        panel.style.bottom = (window.innerHeight - buttonRect.top + 6) + 'px';
      } else {
        panel.style.top = (buttonRect.bottom + 6) + 'px';
        panel.style.bottom = 'auto';
      }

      // A flat 70vh (the CSS default, see .columns-menu-panel) assumes the button sits roughly
      // mid-viewport — near the TOP of a long page (this toolbar, right under the page header)
      // there's nowhere near that much room below before hitting the viewport edge, on either
      // side. Capping to whatever's actually available in the direction it just opened toward
      // (with a little breathing room, and a sane floor so it's never squashed to nothing) is
      // what actually keeps every option reachable via the panel's own scroll instead of running
      // off the visible page.
      var available = (flipUp ? spaceAbove : spaceBelow) - 12;
      panel.style.maxHeight = Math.max(120, Math.min(available, window.innerHeight * 0.7)) + 'px';
    }

    button.addEventListener('click', function (e) {
      e.stopPropagation();
      var wasHidden = panel.hidden;
      panel.hidden = !wasHidden;
      if (wasHidden) reposition();
    });
    document.addEventListener('click', function () { panel.hidden = true; });
    // Recomputes rather than closing on scroll (including the panel's own checkbox list's own
    // overflow-y:auto scroll, caught here via the capture phase along with everything else, and
    // deliberately NOT skipped — repositioning is a no-op if the button hasn't moved, so there's no
    // real cost to re-running it) — position:fixed doesn't move with the page on its own, so
    // without this the panel visually detaches from the button the moment the page scrolls at all,
    // which read as the menu unexpectedly "springing away" mid-use rather than closing gracefully.
    window.addEventListener('scroll', function (e) {
      if (panel.hidden || e.target === panel) return;
      reposition();
    }, true);
    window.addEventListener('resize', function () {
      if (!panel.hidden) reposition();
    });

    container.appendChild(panel);
    if (existingToolbar) existingToolbar.appendChild(container);
    else wrap.parentNode.insertBefore(container, wrap);

    return { checkboxesByIndex: checkboxesByIndex, resortToOrder: resortToOrder };
  }

  // An Actions column's .row-actions (see style.css) keeps growing as pages gain more
  // capabilities — View/Edit/Reset password/Delete/Test, etc. — which either forces the column
  // wide (crowding out the rest of the table) or wraps into a cramped multi-line stack. Collapses
  // everything but a single "more actions" toggle into a dropdown, the same trigger-plus-popover
  // shape as .columns-menu above (and the .confirm-bar-popover in foot.ejs). Scoped to
  // `td .row-actions` specifically (not every .row-actions on the page — a card's own action row,
  // Export/Clear above a chart, etc. stay as plain inline buttons; those aren't a growing table
  // column the same way).
  //
  // A floating dropdown was tried here first and abandoned — .table-wrap needs overflow-x:auto
  // for wide tables, and per the CSS overflow spec that silently clips the vertical axis too, so a
  // position:absolute panel got cut off for any row near the bottom instead of overlapping the
  // content below it. position:fixed (the exact technique buildColumnsMenu's own panel and
  // foot.ejs's own confirm-bar-popover already rely on) escapes that same clipping entirely, so
  // the floating-popover approach is back — this earlier growing-the-row-taller design read as
  // one more distinct interaction pattern next to those two rather than the same one.
  function collapseRowActions(root) {
    (root || document).querySelectorAll('td .row-actions').forEach(function (bar) {
      if (bar.classList.contains('row-actions-collapsed')) return;
      var actions = Array.prototype.slice.call(bar.children);
      if (actions.length <= 1) return; // one action needs no menu to hide it behind

      bar.classList.add('row-actions-collapsed');

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn-soft row-actions-toggle';
      toggle.setAttribute('aria-label', 'More actions');
      toggle.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
      bar.appendChild(toggle);

      var panel = document.createElement('div');
      panel.className = 'row-actions-popover';
      panel.hidden = true;
      var expandedActions = document.createElement('div');
      // Both classes: .row-actions for its existing color/spacing rules and so the data-confirm
      // handler (foot.ejs) still anchors its "are you sure?" popover to THIS button the same way
      // as before (it looks for a .row-actions ancestor); .row-actions-expanded undoes the
      // nowrap+flex-end an Actions-column .row-actions gets (see style.css) — this one has the
      // whole popover's own width to work with, and wrapping is exactly what it's meant to do.
      expandedActions.className = 'row-actions row-actions-expanded';
      actions.forEach(function (action) { expandedActions.appendChild(action); }); // moves, doesn't clone — every existing listener/attribute survives
      panel.appendChild(expandedActions);

      // A moved action's own [data-toggle-row] (e.g. Loxone -> MQTT's own "Test" -> a separate
      // "Value to send" + Send row elsewhere in the table, see mappings-loxone-to-mqtt.ejs) folds
      // that row's own content into THIS SAME popover too, rather than leaving it revealed far
      // away in the table where opening it from inside a floating popover read as "nothing
      // happened". Only for a plain sibling tr.expand-row this collapse itself didn't generate —
      // Miniservers' own diagnostics row (a real page feature, not a leftover Actions column)
      // stays exactly as it was, expanding in place.
      Array.prototype.slice.call(expandedActions.querySelectorAll('[data-toggle-row]')).forEach(function (toggleBtn) {
        var targetId = toggleBtn.getAttribute('data-toggle-row');
        var targetRow = document.getElementById(targetId);
        if (!targetRow || targetRow.tagName !== 'TR' || !targetRow.classList.contains('expand-row')) return;
        var targetCell = targetRow.querySelector('td');
        if (!targetCell) return;
        var merged = document.createElement('div');
        merged.className = 'row-actions-popover-extra';
        merged.hidden = true;
        while (targetCell.firstChild) merged.appendChild(targetCell.firstChild);
        panel.appendChild(merged);
        targetRow.parentNode.removeChild(targetRow);
        toggleBtn.removeAttribute('data-toggle-row'); // the generic handler (foot.ejs) now has nothing left there to find
        // Only one sub-panel (this merged content, or a Delete confirm-bar — see foot.ejs) open at
        // a time inside the same popover, same "one thing open at once" convention the popover's
        // own outer toggle already follows — a 'subpanelopen' event on the shared panel element is
        // how the two otherwise-unrelated files coordinate this without either needing to know the
        // other's internals, just this one shared name/convention.
        panel.addEventListener('subpanelopen', function (e) {
          if (e.detail !== merged && !merged.hidden) merged.hidden = true;
        });
        toggleBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          merged.hidden = !merged.hidden;
          if (!merged.hidden) {
            panel.dispatchEvent(new CustomEvent('subpanelopen', { detail: merged }));
            var firstInput = merged.querySelector('input, select, textarea');
            if (firstInput) firstInput.focus({ preventScroll: true });
            // The popover's own max-height was computed once at open time, before this content
            // existed to measure (merged.hidden was still true) — without regrowing it here, a
            // dropdown living inside this newly-revealed content (e.g. the value-suggest-list
            // below "Value to send") got clipped by the popover's own overflow-y:auto scroll
            // instead of just being visible, same "make the first one bigger if needed" fix
            // already applied for a merged confirm-bar (see growRowActionsPopover in foot.ejs).
            panel.style.maxHeight = Math.min(panel.scrollHeight, window.innerHeight * 0.85) + 'px';
          }
        });
      });

      document.body.appendChild(panel);

      function reposition() {
        panel.style.maxHeight = '';
        var rect = toggle.getBoundingClientRect();
        var panelHeight = panel.getBoundingClientRect().height;
        var spaceBelow = window.innerHeight - rect.bottom;
        var spaceAbove = rect.top;
        var flipUp = panelHeight > spaceBelow && spaceAbove > spaceBelow;
        panel.style.left = 'auto';
        panel.style.right = (window.innerWidth - rect.right) + 'px';
        if (flipUp) {
          panel.style.top = 'auto';
          panel.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
        } else {
          panel.style.top = (rect.bottom + 6) + 'px';
          panel.style.bottom = 'auto';
        }
        var available = (flipUp ? spaceAbove : spaceBelow) - 12;
        panel.style.maxHeight = Math.max(120, Math.min(available, window.innerHeight * 0.7)) + 'px';
      }

      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var wasHidden = panel.hidden;
        // Only one of these open at a time, same as a native context menu.
        document.querySelectorAll('.row-actions-popover').forEach(function (p) { if (p !== panel) p.hidden = true; });
        panel.hidden = !wasHidden;
        if (panel.hidden) return;
        reposition();
      });
      // NOT a blanket panel.addEventListener('click', stopPropagation) — that would also stop the
      // click from ever reaching OTHER document-level delegated handlers a moved action button
      // might depend on (e.g. a page's own [data-toggle-row] Test-value expand-row, see foot.ejs),
      // silently breaking them for any button that happens to live inside this popover. Checking
      // the click's own target against the panel here instead only skips the CLOSE, leaving every
      // other listener's own bubble untouched.
      document.addEventListener('click', function (e) {
        if (panel.contains(e.target)) return;
        panel.hidden = true;
      });
      // Recomputes rather than closing on scroll (same reasoning as buildColumnsMenu's own panel
      // above) — still skips the panel's own internal overflow-y:auto scroll (wrapping onto
      // several buttons can make this one tall enough to need it), since repositioning would be a
      // pointless no-op there anyway (the toggle button hasn't moved).
      window.addEventListener('scroll', function (e) {
        if (panel.hidden || e.target === panel || panel.contains(e.target)) return;
        reposition();
      }, true);
      window.addEventListener('resize', function () {
        if (!panel.hidden) reposition();
      });
    });
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

    var colgroup = buildColgroup(table, columnCount);
    var hiddenSet = new Set();
    var widths = {};
    var headers = Array.prototype.slice.call(headerRow.children);
    // A <th data-default-hidden> (e.g. Token/UDP port on the Loxone -> MQTT mapping table — real
    // but rarely-needed technical detail) starts folded away for anyone who's never touched this
    // table's Columns menu, without having to hide it globally — someone who explicitly showed it
    // before keeps seeing it (see the fetchPrefs callback below, which knows the difference
    // between "never saved anything" and "saved, and chose to leave everything visible").
    var defaultHiddenIndices = [];
    headers.forEach(function (th) {
      if (th.hasAttribute('data-default-hidden')) {
        var idx = Number(th.dataset.originalIndex);
        hiddenSet.add(idx);
        defaultHiddenIndices.push(idx);
      }
    });
    var state = { currentOrder: currentOrder, hiddenSet: hiddenSet, widths: widths, columnCount: columnCount, sort: null };
    registry.set(table, state);
    // Applied synchronously (not left for the fetchPrefs().then() below, a network round-trip
    // away) so a data-default-hidden column doesn't flash visible for a moment on every load.
    if (hiddenSet.size > 0) applyHidden(table, hiddenSet);

    var columnsMenu = buildColumnsMenu(table, headers, hiddenSet, function () {
      applyHidden(table, hiddenSet);
      savePrefs(key, state);
    }, function () {
      // Back to exactly initTable's own starting state — original order, only the
      // data-default-hidden columns hidden, no custom widths, table-layout back to auto (a
      // custom width may have switched it to 'fixed' — see applyWidths), no active sort.
      currentOrder.length = 0;
      for (var i = 0; i < columnCount; i++) currentOrder.push(i);
      hiddenSet.clear();
      defaultHiddenIndices.forEach(function (i) { hiddenSet.add(i); });
      Object.keys(widths).forEach(function (k) { delete widths[k]; });
      table.style.tableLayout = '';
      table.classList.remove('table-cols-fixed');
      Array.prototype.forEach.call(colgroup.children, function (col) { col.style.width = ''; });
      state.sort = null;

      applyOrder(table, colgroup, currentOrder);
      applyHidden(table, hiddenSet);
      updateSortIndicators(table, null);
      columnsMenu.resortToOrder(currentOrder);
      Object.keys(columnsMenu.checkboxesByIndex).forEach(function (idx) {
        columnsMenu.checkboxesByIndex[idx].checked = !hiddenSet.has(Number(idx));
      });
      if (state.pager) renderPage(table, 1);

      // A bare header with no body isn't reliably kept by every fetch implementation on a
      // bodyless method like DELETE — sending an explicit (empty) JSON body is what actually
      // guarantees the Content-Type sticks, which is what exempts this from the CSRF check below
      // (see middleware/csrf.js) the same way the POST calls elsewhere in this file already do.
      fetch('/api/table-prefs/' + encodeURIComponent(key), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function () {});
    });
    var checkboxesByIndex = columnsMenu.checkboxesByIndex;

    var dragSrcIndex = null;
    headers.forEach(function (th) {
      // Same opt-out as buildColumnsMenu above — no drag-reorder, click-to-sort, or resize handle
      // for a utility column either.
      if (th.hasAttribute('data-no-controls')) return;
      th.setAttribute('draggable', 'true');
      th.classList.add('draggable-col');
      th.title = 'Click to sort, drag to reorder columns';

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
        applyOrder(table, colgroup, currentOrder);
        applyHidden(table, hiddenSet);
        applyWidths(colgroup, widths);
        columnsMenu.resortToOrder(currentOrder);
        savePrefs(key, state);
      });

      // A native HTML5 drag gesture doesn't fire 'click' on its source element, so this and the
      // drag-to-reorder handlers above coexist without special-casing one another. The resize
      // handle below is a plain mousedown/mousemove/mouseup drag, not native drag-and-drop — that
      // kind DOES still fire a 'click' right after mouseup, and by then the pointer has usually
      // moved off the handle itself (checking e.target here is not enough), so it needs its own
      // "did a resize just happen" flag instead (set by addResizeHandle's onUp, below).
      th.addEventListener('click', function (e) {
        if (e.target.classList.contains('col-resize-handle') || th.dataset.justResized) return;
        var originalIndex = Number(th.dataset.originalIndex);
        var next = (state.sort && state.sort.index === originalIndex && state.sort.dir === 'asc')
          ? { index: originalIndex, dir: 'desc' }
          : { index: originalIndex, dir: 'asc' };
        state.sort = next;
        applySort(table, next);
        updateSortIndicators(table, next);
        if (state.pager) renderPage(table, 1);
      });

      addResizeHandle(th, colgroup, widths, function (originalIndex, px) {
        if (px) widths[originalIndex] = Math.round(px);
        else delete widths[originalIndex];
        savePrefs(key, state);
      });
    });

    // Fetched asynchronously and merged into the already-rendered menu/table
    // (rather than building either from scratch) so nothing disappears or
    // flashes on pages that auto-refresh.
    fetchPrefs(key).then(function (prefs) {
      // prefs.order is null specifically when nothing has ever been saved for this table+user —
      // once something HAS been saved (even just a resize, never touching visibility), prefs.hidden
      // is the full authoritative list, including "explicitly nothing," which must be able to
      // override a data-default-hidden seed. Only merge on top of that seed for a first-ever visit.
      if (prefs.order !== null) hiddenSet.clear();
      (prefs.hidden || []).forEach(function (i) { hiddenSet.add(i); });
      headers.forEach(function (th) {
        var i = Number(th.dataset.originalIndex);
        if (checkboxesByIndex && checkboxesByIndex[i]) checkboxesByIndex[i].checked = !hiddenSet.has(i);
      });

      if (prefs.order && prefs.order.length === columnCount) {
        currentOrder.splice.apply(currentOrder, [0, currentOrder.length].concat(prefs.order));
        applyOrder(table, colgroup, currentOrder);
        columnsMenu.resortToOrder(currentOrder);
      }
      applyHidden(table, hiddenSet);

      if (prefs.widths) {
        Object.keys(prefs.widths).forEach(function (i) { widths[i] = prefs.widths[i]; });
        applyWidths(colgroup, widths);
      }
    });
  }

  var DEFAULT_PAGE_SIZE = 25;

  function getPageSize() {
    var raw = Number(document.body.dataset.pageSize);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PAGE_SIZE;
  }

  // A kebab-menu's own generated <tr class="expand-row"> (collapseRowActions above) or a
  // page-specific one (e.g. Miniservers' diagnostics panel) is a sibling of the data row it
  // belongs to, not a child of it — has to be paginated together with that row or it ends up
  // floating under whichever row happens to land on the visible page instead of following its own.
  function rowGroup(row) {
    var group = [row];
    var sib = row.nextElementSibling;
    while (sib && sib.classList.contains('expand-row')) {
      group.push(sib);
      sib = sib.nextElementSibling;
    }
    return group;
  }

  // Every page's own search/filter script (Monitor, Incoming Clients/Messages, Live Data, ...)
  // hides a non-matching row the same generic way: row.style.display = 'none'. Reacting to exactly
  // that attribute, rather than any one page's own filter markup or element ids, is what lets
  // pagination apply automatically on every table-bearing page without this file needing to know
  // anything about how any particular page's own search box works.
  function visibleDataRows(table, columnCount) {
    var tbody = table.querySelector('tbody');
    return Array.prototype.slice.call(tbody.children).filter(function (row) {
      return row.children.length === columnCount && !row.classList.contains('expand-row') && row.style.display !== 'none';
    });
  }

  // First 3 pages, last 3 pages, current page and its immediate neighbors — everything else
  // collapses into a "…" separator rather than one button per page, which would otherwise run
  // unusably wide on a table with dozens of pages. The current-page window (not just first/last)
  // is what keeps a deep page reachable without clicking Next a dozen times to get there.
  function buildPageList(current, total) {
    var keep = new Set();
    [1, 2, 3, total - 2, total - 1, total, current - 1, current, current + 1].forEach(function (p) {
      if (p >= 1 && p <= total) keep.add(p);
    });
    var sorted = Array.from(keep).sort(function (a, b) { return a - b; });
    var result = [];
    sorted.forEach(function (p, i) {
      if (i > 0 && p - sorted[i - 1] > 1) result.push(null); // null = "…" gap
      result.push(p);
    });
    return result;
  }

  function renderPage(table, page) {
    var state = registry.get(table);
    if (!state || !state.pager) return;
    var pager = state.pager;
    var rows = visibleDataRows(table, state.columnCount);
    var pageSize = getPageSize();
    var totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    page = Math.min(Math.max(1, page), totalPages);
    pager.page = page;

    if (rows.length <= pageSize) {
      pager.el.hidden = true;
      rows.forEach(function (row) {
        rowGroup(row).forEach(function (el) { el.classList.remove('pg-off-page'); });
      });
      return;
    }

    pager.el.hidden = false;
    var start = (page - 1) * pageSize;
    var end = start + pageSize;
    rows.forEach(function (row, i) {
      var onPage = i >= start && i < end;
      rowGroup(row).forEach(function (el) { el.classList.toggle('pg-off-page', !onPage); });
    });

    pager.numbers.innerHTML = '';
    buildPageList(page, totalPages).forEach(function (p) {
      if (p === null) {
        var ellipsis = document.createElement('span');
        ellipsis.className = 'table-pager-ellipsis';
        ellipsis.textContent = '…';
        pager.numbers.appendChild(ellipsis);
        return;
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-soft table-pager-page' + (p === page ? ' table-pager-page-current' : '');
      btn.textContent = String(p);
      if (p === page) btn.setAttribute('aria-current', 'true');
      btn.addEventListener('click', function () { renderPage(table, p); });
      pager.numbers.appendChild(btn);
    });

    pager.label.textContent = rows.length + ' rows';
    pager.prevBtn.disabled = page <= 1;
    pager.nextBtn.disabled = page >= totalPages;
  }

  // Builds the pager UI once per table (kept across live-refreshes via the registry, same as every
  // other piece of per-table state here) but re-attaches its MutationObserver every call — a
  // live-refresh replaces the whole <tbody> element (see refreshTables below), which would
  // otherwise leave the old observer watching a detached node that no longer receives anything.
  function initPagination(table) {
    var state = registry.get(table);
    if (!state) return;
    var wrap = table.closest('.table-wrap');
    if (!wrap) return;

    // Only the very first call (no pager built yet) should default to page 1 — every later call
    // is refreshTables() re-running this after a liveSwap tbody replace (see foot.ejs), and a
    // periodic background refresh silently yanking you back to page 1 every few seconds is exactly
    // the surprising behavior this avoids. A filter/sort change still resets to page 1 of its own
    // accord (the MutationObserver below, and the sort/reset-columns click handlers above) — this
    // only preserves the page across a refresh that didn't change what you were looking at.
    var isFirstInit = !state.pager;

    if (!state.pager) {
      var pager = document.createElement('div');
      pager.className = 'table-pager';
      pager.hidden = true;
      var prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'btn-soft';
      prevBtn.textContent = 'Prev';
      var nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'btn-soft';
      nextBtn.textContent = 'Next';
      var numbers = document.createElement('div');
      numbers.className = 'table-pager-numbers';
      var label = document.createElement('span');
      label.className = 'table-pager-label hint';
      pager.appendChild(prevBtn);
      pager.appendChild(numbers);
      pager.appendChild(nextBtn);
      pager.appendChild(label);
      wrap.parentNode.insertBefore(pager, wrap.nextSibling);

      state.pager = { el: pager, prevBtn: prevBtn, nextBtn: nextBtn, numbers: numbers, label: label, page: 1, observer: null };
      prevBtn.addEventListener('click', function () { renderPage(table, state.pager.page - 1); });
      nextBtn.addEventListener('click', function () { renderPage(table, state.pager.page + 1); });
    }

    if (state.pager.observer) state.pager.observer.disconnect();
    var observer = new MutationObserver(function () { renderPage(table, 1); });
    observer.observe(table.querySelector('tbody'), { attributes: true, attributeFilter: ['style'], subtree: true });
    state.pager.observer = observer;

    renderPage(table, isFirstInit ? 1 : state.pager.page);
  }

  document.querySelectorAll('.table-wrap table').forEach(function (table, index) {
    initTable(table, index);
  });
  collapseRowActions();
  // Run after collapseRowActions() (not from inside initTable itself, which runs per-table before
  // every table has necessarily been through collapseRowActions()) — a data row's own .expand-row
  // sibling (see rowGroup above) has to already exist for the very first render to paginate it
  // correctly, not just from the second render onward.
  document.querySelectorAll('.table-wrap table').forEach(function (table) {
    initPagination(table);
  });

  // Called after something outside this file has replaced a table's <tbody>
  // (e.g. a partial-refresh fetch) with fresh, originally-ordered rows: tags
  // them and re-applies this table's current order/hidden/sort columns.
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
      var colgroup = table.querySelector('colgroup');
      applyOrder(table, colgroup, state.currentOrder);
      applyHidden(table, state.hiddenSet);
      applyWidths(colgroup, state.widths);
      if (state.sort) applySort(table, state.sort);
    });
    collapseRowActions();
    document.querySelectorAll('.table-wrap table').forEach(function (table) {
      initPagination(table);
    });
  };
})();
