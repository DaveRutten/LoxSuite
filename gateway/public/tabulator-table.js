// Shared driver for every Tabulator-backed table in this app — extracted from the Miniservers
// pilot (miniservers-tabulator.js) once a second page needed the exact same plumbing. This file
// covers everything that ISN'T specific to one page's own data shape: loading/saving column
// order/hidden/width prefs (through the same generic /api/table-prefs/:tableKey endpoint
// tables.js's own Columns menu already uses), the Columns button + panel + Reset-to-default, the
// manuallyResizedFields tracking that keeps fitColumns' non-resized columns actually flexible, the
// redraw(true) call that fixes a newly-shown column pushing the last column out of view, and the
// Expand-all/Collapse-all button for a dataTree table. A page's own *-tabulator.js file supplies
// only its column defs/formatters/row-actions and calls initTabulatorTable(...).
//
// Both bugs referenced in the comments below were found against a live table during the
// Miniservers pilot, not theorized in advance — keeping the fixes in one shared place means every
// future table gets them for free instead of rediscovering them one page at a time.
function initTabulatorTable(opts) {
  function resolveEl(v) { return typeof v === 'string' ? document.getElementById(v) : v; }

  var container = resolveEl(opts.container);
  if (!container || typeof Tabulator === 'undefined') return Promise.resolve(null);

  var tableKey = opts.tableKey;
  var defaultHidden = opts.defaultHidden || [];
  var noControls = opts.noControls || ['actions'];
  var columns = opts.columns;

  var columnsBtn = resolveEl(opts.columnsBtn);
  var columnsPanel = resolveEl(opts.columnsPanel);
  var collapseAllBtn = resolveEl(opts.collapseAllBtn);

  var table;
  var manuallyResizedFields = {};
  var columnsMenuCheckboxes = {};
  var allExpanded = !!opts.dataTreeStartExpanded;

  function savePrefs() {
    var order = table.getColumnDefinitions().map(function (c) { return c.field; }).filter(Boolean);
    var hidden = table.getColumns().filter(function (c) { return !c.isVisible() && c.getField(); }).map(function (c) { return c.getField(); });
    var widths = {};
    table.getColumns().forEach(function (c) {
      var field = c.getField();
      if (!field || !manuallyResizedFields[field]) return;
      var w = c.getWidth();
      if (w) widths[field] = w;
    });
    fetch('/api/table-prefs/' + encodeURIComponent(tableKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: order, hidden: hidden, widths: widths }),
    }).catch(function () {});
  }

  // ---- Columns button + panel — reuses .columns-menu/.columns-menu-panel (see style.css) so this
  // looks identical to every other table's own Columns button, just driven by Tabulator's own
  // column API instead of tables.js. Both are optional: a page with nothing worth hiding (e.g. a
  // 3-column lookup table) can simply not pass columnsBtn/columnsPanel. ----
  function buildColumnsMenu() {
    if (!columnsPanel) return;
    columnsPanel.innerHTML = '';
    columnsMenuCheckboxes = {};
    table.getColumns().forEach(function (col) {
      var field = col.getField();
      if (!field || noControls.indexOf(field) !== -1) return;
      var label = document.createElement('label');
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = col.isVisible();
      checkbox.addEventListener('change', function () { col.toggle(); });
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(' ' + col.getDefinition().title));
      columnsPanel.appendChild(label);
      columnsMenuCheckboxes[field] = checkbox;
    });

    // Same "Reset to default" affordance every other table's own Columns menu already has (see
    // tables.js's buildColumnsMenu) — clears the saved prefs server-side and reloads, simplest way
    // to get back to exactly this page's own initial column set/order/widths without duplicating
    // that reset logic against Tabulator's own column API.
    var resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn-soft columns-menu-reset';
    resetBtn.textContent = 'Reset to default';
    resetBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      fetch('/api/table-prefs/' + encodeURIComponent(tableKey), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { location.reload(); })
        .catch(function () { location.reload(); });
    });
    columnsPanel.appendChild(resetBtn);
  }

  function syncColumnsMenu() {
    table.getColumns().forEach(function (col) {
      var field = col.getField();
      if (field && columnsMenuCheckboxes[field]) columnsMenuCheckboxes[field].checked = col.isVisible();
    });
  }

  // Floating UI (vendor/floating-ui.{core,dom}.umd.min.js) replaces what used to be a hand-rolled
  // getBoundingClientRect() + flip-up-if-no-room + scroll/resize-listener reimplementation here —
  // the same category of bug (menus "springing away" on scroll, landing flush against/past the
  // viewport edge) kept resurfacing across every one of this app's own fixed-position popovers
  // because each one re-derived that logic slightly differently. flip() swaps to open upward when
  // there's no room below; shift() nudges it back onto the viewport horizontally rather than
  // letting it run off the right edge; size() caps maxHeight to whatever room is actually
  // available in the direction it opened, the same floor/ceiling the old manual version used.
  // autoUpdate() is the actual scroll/resize fix — it re-runs computePosition on scroll (including
  // a nested scrollable ancestor), resize, and the anchor/panel's own size changes (ResizeObserver),
  // started only while the panel is open and stopped the instant it closes.
  var stopColumnsAutoUpdate = null;
  function positionColumnsPanel() {
    FloatingUIDOM.computePosition(columnsBtn, columnsPanel, {
      // .columns-menu-panel is position:fixed (style.css) — strategy must match, or
      // computePosition returns document-relative coordinates that exactly cancel out the
      // anchor's own viewport-relative movement on a plain whole-page scroll, freezing the panel
      // in place instead of tracking the button (found and confirmed on the near-identical
      // inline-suggest menu in admin-notifications.ejs — see that file's own reposition() comment
      // for how; every page here scrolls the whole document rather than a nested container, so
      // this applies here too even though it hadn't surfaced yet on the shorter pages this was
      // first tried on).
      strategy: 'fixed',
      placement: 'bottom-end',
      middleware: [
        FloatingUIDOM.offset(6),
        FloatingUIDOM.flip(),
        FloatingUIDOM.shift({ padding: 8 }),
        FloatingUIDOM.size({
          padding: 8,
          apply: function (args) {
            columnsPanel.style.maxHeight = Math.max(120, Math.min(args.availableHeight, window.innerHeight * 0.7)) + 'px';
          },
        }),
      ],
    }).then(function (pos) {
      columnsPanel.style.left = pos.x + 'px';
      columnsPanel.style.top = pos.y + 'px';
    });
  }

  if (columnsBtn && columnsPanel) {
    columnsBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var wasHidden = columnsPanel.hidden;
      columnsPanel.hidden = !wasHidden;
      if (wasHidden) {
        stopColumnsAutoUpdate = FloatingUIDOM.autoUpdate(columnsBtn, columnsPanel, positionColumnsPanel);
      } else if (stopColumnsAutoUpdate) {
        stopColumnsAutoUpdate();
        stopColumnsAutoUpdate = null;
      }
    });
    document.addEventListener('click', function () {
      columnsPanel.hidden = true;
      if (stopColumnsAutoUpdate) { stopColumnsAutoUpdate(); stopColumnsAutoUpdate = null; }
    });
    columnsPanel.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  // ---- Expand all / Collapse all — only wired up when a page actually passes collapseAllBtn
  // (a dataTree table with something to fold); hidden entirely once built if nothing on the page
  // actually has children, same "nothing to control" reasoning noControls already uses. ----
  function treeParentRows() {
    var childField = opts.dataTreeChildField || '_children';
    return table.getRows().filter(function (row) {
      var children = row.getData()[childField];
      return Array.isArray(children) && children.length > 0;
    });
  }

  function refreshCollapseAllButton() {
    if (!collapseAllBtn) return;
    var parents = treeParentRows();
    collapseAllBtn.hidden = parents.length === 0;
    // Chevrons point the direction the click will now go — down while collapsed ("Expand all"
    // opens downward), up once expanded ("Collapse all" folds back up) — rather than a single
    // fixed icon that never matched the action for whichever state you were about to leave.
    var icon = allExpanded ? (opts.collapseAllIconCollapse || opts.collapseAllIcon || '') : (opts.collapseAllIconExpand || opts.collapseAllIcon || '');
    collapseAllBtn.innerHTML = icon + (allExpanded ? ' Collapse all' : ' Expand all');
  }

  if (collapseAllBtn) {
    collapseAllBtn.addEventListener('click', function () {
      allExpanded = !allExpanded;
      treeParentRows().forEach(function (row) {
        if (allExpanded) row.treeExpand();
        else row.treeCollapse();
      });
      refreshCollapseAllButton();
    });
  }

  // ---- Load saved prefs, apply to column defs, then build the table ----
  return fetch('/api/table-prefs/' + encodeURIComponent(tableKey))
    .then(function (r) { return r.json(); })
    .catch(function () { return {}; })
    .then(function (prefs) {
      var hidden = (prefs.hidden && prefs.hidden.length) ? prefs.hidden : (prefs.order ? [] : defaultHidden);
      var widths = prefs.widths || {};

      columns.forEach(function (col) {
        if (noControls.indexOf(col.field) === -1) col.visible = hidden.indexOf(col.field) === -1;
        if (widths[col.field]) col.width = widths[col.field];
      });

      if (prefs.order && prefs.order.length) {
        var byField = {};
        columns.forEach(function (c) { byField[c.field] = c; });
        var ordered = prefs.order.map(function (f) { return byField[f]; }).filter(Boolean);
        columns.forEach(function (c) { if (ordered.indexOf(c) === -1) ordered.push(c); });
        columns = ordered;
      }

      var tabulatorOptions = {
        layout: 'fitColumns',
        movableColumns: true,
        placeholder: opts.placeholder || 'No rows.',
        columns: columns,
      };
      if (opts.ajaxURL) tabulatorOptions.ajaxURL = opts.ajaxURL;
      if (opts.data) tabulatorOptions.data = opts.data;
      if (opts.dataTree) {
        tabulatorOptions.dataTree = true;
        tabulatorOptions.dataTreeChildField = opts.dataTreeChildField || '_children';
        tabulatorOptions.dataTreeStartExpanded = !!opts.dataTreeStartExpanded;
        if (opts.dataTreeElementColumn) tabulatorOptions.dataTreeElementColumn = opts.dataTreeElementColumn;
      }
      if (opts.tabulatorOptions) {
        Object.keys(opts.tabulatorOptions).forEach(function (k) { tabulatorOptions[k] = opts.tabulatorOptions[k]; });
      }

      table = new Tabulator(container, tabulatorOptions);

      table.on('tableBuilt', buildColumnsMenu);
      table.on('tableBuilt', refreshCollapseAllButton);
      table.on('dataLoaded', refreshCollapseAllButton);
      table.on('columnMoved', function () { savePrefs(); });
      // columnResized fires for a column's own genuine drag-resize, but ALSO as a side effect on
      // every OTHER column whenever fitColumns reflows the row (a visibility change, a resize
      // anywhere, the initial layout pass) — capturing every column's width on any one of those
      // firings is what quietly turned every column into a fixed pixel width over time, leaving
      // fitColumns with nothing flexible left to stretch and a gap on the right once the saved sum
      // no longer matched the real container width. Only the column actually named in the event is
      // recorded as a genuine manual resize; everything else stays flexible.
      table.on('columnResized', function (column) {
        manuallyResizedFields[column.getField()] = true;
        savePrefs();
      });
      table.on('columnVisibilityChanged', function () {
        savePrefs();
        syncColumnsMenu();
        // Unlike a genuine drag-resize (which reliably reflows every other flexible column via its
        // own columnResized side effects, see above), toggling a column's visibility via the
        // checkbox — column.toggle() — does NOT retrigger fitColumns' own width recalculation on
        // its own; the newly-shown column just gets appended at its own natural width, growing the
        // row past the container with nothing shrinking to compensate ("the last column falls out
        // of view when I turn one more on" — the last column ends up past the container's right
        // edge with no scrollbar to reach it, since .tabulator-tableholder's overflow-x is
        // intentionally hidden for the harmless few-px fitColumns rounding remainder, see
        // tabulator-theme.css). redraw(true) forces Tabulator to recompute the fitColumns layout
        // from scratch — flexible (non manually-resized) columns share the change, and
        // manually-resized ones keep their own explicit width, exactly the same split
        // columnResized already keeps for a genuine drag.
        table.redraw(true);
      });

      return table;
    });
}

// ---- Shared kebab row-actions popover — the same "..." button + floating .row-actions-popover
// shape tables.js's own collapseRowActions builds for a plain-<table> row with more than one
// action, reused here so every Tabulator page's Actions column looks and behaves identically
// instead of each *-tabulator.js file reimplementing its own copy (this started life duplicated
// once in miniservers-tabulator.js, then a second time almost verbatim for the next table — moved
// here once a second consumer needed it, same "extract on the second copy" pattern already used
// for chartFieldHelpers.js/toggleSwitch.js elsewhere in this app).
//
// A single module-level "currently open" tracker (not one per caller) means only one popover is
// ever open at a time even across two different Tabulator tables on the same page (e.g.
// transformations.ejs's two independent tables) — the same "only one at a time, like a native
// context menu" behavior tables.js's own version already has.
var openTabulatorRowActionsPopover = (function () {
  var current = null; // { panel, closeListener, stopAutoUpdate, onCloseCallbacks } for whichever popover is open, if any

  function closeOpenPopover() {
    if (!current) return;
    var callbacks = current.onCloseCallbacks;
    current.panel.remove();
    document.removeEventListener('click', current.closeListener);
    current.stopAutoUpdate();
    current = null;
    // Run after the panel/anchor bookkeeping above is fully torn down — e.g. a deferred
    // table.replaceData() (see ctx.onClose below) is safe to run now since nothing is still
    // trying to track this popover's anchor.
    callbacks.forEach(function (fn) { fn(); });
  }

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeOpenPopover(); });

  // buildActions(actionsEl, close, ctx) — appends buttons/links to actionsEl (a .row-actions.row-
  // actions-expanded div); call close() from inside an action's own handler to dismiss the
  // popover after it runs (e.g. once a fetch() finishes). ctx = { panel, reposition, onClose } for
  // actions that need to grow the popover itself (see confirmInPopover below, e.g. a Delete
  // button's own Yes/Cancel bar) — reposition() is a manual nudge for the instant the content
  // changes; autoUpdate() below (see the Columns-panel positioning's own comment for what it
  // replaces) already re-measures on the panel's own ResizeObserver-detected size change a moment
  // later, so this is a belt-and-suspenders correctness net, not the only thing keeping it
  // positioned. onClose(fn) queues fn to run once this popover instance actually closes — for an
  // action that wants to refresh the whole table's data (e.g. Miniservers' own "Test now", which
  // touches other rows too) but can't safely do that while its own popover is still open:
  // rebuilding the table recreates every row's Actions-cell kebab button from scratch, including
  // the one this popover is anchored to, so a still-open popover's autoUpdate() ends up tracking a
  // now-detached element (getBoundingClientRect() on a node no longer in the document resolves to
  // 0,0) and the whole panel — buttons included — jumps to the top-left corner. Deferring the
  // refresh until close sidesteps that entirely instead of trying to re-anchor a live popover
  // mid-display.
  return function open(anchor, buildActions) {
    if (current) { closeOpenPopover(); return; }

    var panel = document.createElement('div');
    panel.className = 'row-actions-popover';
    panel.addEventListener('click', function (e) { e.stopPropagation(); });

    function reposition() {
      FloatingUIDOM.computePosition(anchor, panel, {
        // .row-actions-popover is position:fixed (style.css) — see positionColumnsPanel's own
        // comment above for why strategy must explicitly match that (default 'absolute' silently
        // freezes the panel in place on a whole-page scroll instead of tracking the anchor).
        strategy: 'fixed',
        placement: 'bottom-end',
        middleware: [FloatingUIDOM.offset(6), FloatingUIDOM.flip(), FloatingUIDOM.shift({ padding: 8 })],
      }).then(function (pos) {
        panel.style.left = pos.x + 'px';
        panel.style.top = pos.y + 'px';
      });
    }

    var onCloseCallbacks = [];
    var actions = document.createElement('div');
    actions.className = 'row-actions row-actions-expanded';
    buildActions(actions, closeOpenPopover, {
      panel: panel,
      reposition: reposition,
      onClose: function (fn) { onCloseCallbacks.push(fn); },
    });
    panel.appendChild(actions);
    document.body.appendChild(panel);

    var closeListener = function (e) { if (!panel.contains(e.target)) closeOpenPopover(); };
    document.addEventListener('click', closeListener);
    var stopAutoUpdate = FloatingUIDOM.autoUpdate(anchor, panel, reposition);

    current = { panel: panel, closeListener: closeListener, stopAutoUpdate: stopAutoUpdate, onCloseCallbacks: onCloseCallbacks };
  };
})();

// Same "Yes/Cancel" inline confirm foot.ejs's own data-confirm handling shows for a plain-<table>
// row's Delete button (see growRowActionsPopover there) — reused here so a Tabulator row's own
// Delete doesn't fall back to a jarring native window.confirm() instead, which looked and behaved
// inconsistently with every other table's own Delete. ctx is the { panel, reposition } object
// buildActions' own 3rd argument already provides (see openTabulatorRowActionsPopover above).
// Self-toggling: calling this again while its own bar is already open (e.g. a second click on the
// same Delete button) removes it instead of stacking a second one underneath.
function confirmInPopover(ctx, message, onConfirm) {
  var existing = ctx.panel.querySelector('.row-actions-popover-extra');
  if (existing) { existing.remove(); ctx.reposition(); return; }

  var bar = document.createElement('div');
  bar.className = 'row-actions-popover-extra';
  // Reuses .confirm-bar-inner (see style.css) rather than a hand-rolled flex row — it already has
  // exactly the right layout (flex/wrap/gap) AND a .row-actions-popover .confirm-bar-inner rule
  // that right-packs it (justify-content:flex-end) the same way foot.ejs's own data-confirm bars
  // already do inside this same popover context, AND its own button margin-right:0 reset (a plain
  // hand-rolled row here landed Cancel a few px short of the button row's right edge above, from
  // the base button rule's own margin-right that only .row-actions/.confirm-bar-inner/etc. reset).
  var row = document.createElement('div');
  row.className = 'confirm-bar-inner';
  var msg = document.createElement('span');
  msg.className = 'hint';
  msg.style.margin = '0';
  msg.textContent = message;
  row.appendChild(msg);
  var yesBtn = document.createElement('button');
  yesBtn.type = 'button';
  yesBtn.className = 'danger';
  yesBtn.textContent = 'Yes';
  yesBtn.addEventListener('click', onConfirm);
  row.appendChild(yesBtn);
  var cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-soft';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function () { bar.remove(); ctx.reposition(); });
  row.appendChild(cancelBtn);
  bar.appendChild(row);
  ctx.panel.appendChild(bar);
  ctx.reposition();
}
