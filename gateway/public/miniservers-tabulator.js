// Miniservers table — backed by Tabulator (vendor/tabulator.min.js), driven by the shared
// gateway/public/tabulator-table.js for everything generic (prefs persistence, Columns menu,
// Expand/Collapse all). This file only supplies Miniservers' own column defs/formatters, the
// Gateway/Client tree shape, the diagnostics dialog, and the kebab row-actions popover.
(function () {
  var container = document.getElementById('ms-tabulator');
  if (!container) return;
  var TABLE_KEY = '/miniservers:tabulator-pilot';
  var DEFAULT_HIDDEN = ['stateLabel', 'firmwareVersion', 'generationLabel', 'cpuLoad', 'heapStatus', 'numTasks', 'firmwareDate', 'updateLevel', 'udpPort', 'externalUrl', 'lastSuccessAt', 'lastError'];
  // Columns nobody can hide — the tree/name column (needs to always be there to navigate the
  // Gateway/Client hierarchy) and Actions (same "data-no-controls" reasoning tables.js's own
  // Columns menu already uses for a utility column with nothing to hide behind itself).
  var NO_CONTROLS = ['name', 'actions', 'drag'];

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

  function textOrDash(field) {
    return function (cell) {
      var value = cell.getValue();
      return value === null || value === undefined || value === '' ? '-' : value;
    };
  }

  // Single kebab button + a floating .row-actions-popover (see style.css — the exact same
  // trigger-plus-fixed-panel shape tables.js's own collapseRowActions already uses for a table
  // cell with more than one action) instead of 3 always-visible buttons — narrower Actions column
  // (more room for fitColumns to give everything else), and matches the "one Action button"
  // this app's other tables already collapse down to once there's more than one thing to do.
  // Popover open/close/positioning itself lives in the shared openTabulatorRowActionsPopover
  // (tabulator-table.js) — this only supplies what goes inside it.
  var table;

  function actionsFormatter(cell) {
    var v = cell.getRow().getData();
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
    // Same below-the-buttons panel Delete's own Yes/Cancel bar uses (see confirmInPopover) —
    // built and appended to ctx.panel (a sibling of the actions row, not a child of it) only once
    // Test is actually clicked, not eagerly on open; appending an empty .row-actions-popover-extra
    // up front would show an empty bordered strip under the buttons before there's anything to
    // show in it. Previously appended directly into the actions row itself with a plain width:100%
    // — before .row-actions.row-actions-expanded was changed to flex-wrap:nowrap (see that rule's
    // own comment) that happened to wrap onto its own line by accident; under nowrap it instead
    // got squeezed into the fixed-position popover with no real width or placement of its own,
    // which is what actually put it in the top-left corner of the page.
    var testResultBar = null;
    var testResultText = null;
    function setTestResult(text) {
      if (!testResultBar) {
        testResultBar = document.createElement('div');
        testResultBar.className = 'row-actions-popover-extra';
        testResultText = document.createElement('div');
        testResultText.className = 'hint';
        testResultText.style.margin = '0';
        testResultBar.appendChild(testResultText);
        ctx.panel.appendChild(testResultBar);
      }
      testResultText.textContent = text;
      ctx.reposition();
    }

    // A successful Test also refreshes other rows' status/firmware columns (e.g. a Gateway whose
    // Client just got tested) via table.replaceData() — but that rebuilds every row's Actions cell
    // from scratch, including this popover's own kebab anchor, which would otherwise yank the
    // still-open panel (with the result text the user is meant to actually read) to the top-left
    // corner (see onClose's own comment in tabulator-table.js). Deferred until the popover actually
    // closes instead of running it while the result is still on screen.
    var needsRefreshOnClose = false;
    ctx.onClose(function () {
      if (needsRefreshOnClose && table) table.replaceData();
    });

    var editLink = document.createElement('a');
    editLink.className = 'inline';
    editLink.href = '/miniservers/' + v.id + '/edit';
    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-edit';
    editBtn.innerHTML = ICONS.edit + ' Edit';
    editLink.appendChild(editBtn);
    actions.appendChild(editLink);

    var diagBtn = document.createElement('button');
    diagBtn.type = 'button';
    diagBtn.className = 'btn-soft';
    diagBtn.innerHTML = ICONS.refresh + ' Diagnostics';
    diagBtn.addEventListener('click', function () { closePopover(); openDiagnostics(v); });
    actions.appendChild(diagBtn);

    // Restores the per-row "Test now" the old expand-row used to carry (POST /miniservers/:id/
    // check — the same Local/External/Loxone API/Logbook probe the Add form's own Test button
    // runs, plus a live-connection leg and a fresh status/firmware read, keyed off this row's
    // already-saved credentials instead of whatever's currently typed into a form).
    var testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'btn-test';
    testBtn.innerHTML = ICONS.refresh + ' Test now';
    testBtn.addEventListener('click', function () {
      testBtn.disabled = true;
      setTestResult('Testing…');
      fetch('/miniservers/' + v.id + '/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { setTestResult(data.error); return; }
          var parts = [];
          if (data.local) parts.push('Local: ' + (data.local.ok ? data.local.ms + ' ms' : (data.local.error || 'failed')));
          if (data.external) parts.push('External: ' + (data.external.ok ? data.external.ms + ' ms' : (data.external.error || 'failed')));
          if (data.api) parts.push('Loxone API: ' + (data.api.ok ? 'ok' : (data.api.error || 'failed')));
          if (data.logbook) parts.push('Logbook: ' + (data.logbook.ok ? 'ok' : (data.logbook.error || 'failed')));
          setTestResult(parts.join(' · '));
          // Fresh status/firmware/generation for this row (and any other row, e.g. a Gateway whose
          // Client just got tested) — simplest correct refresh given the table's rows are backed by
          // one shared ajax source, same as any other cross-row-effect action already does (Delete).
          // Deferred until the popover closes — see needsRefreshOnClose's own comment above.
          needsRefreshOnClose = true;
        })
        .catch(function () { setTestResult('Test failed to run.'); })
        .then(function () { testBtn.disabled = false; });
    });
    actions.appendChild(testBtn);

    if (v.canEdit) {
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger';
      delBtn.innerHTML = ICONS.trash + ' Delete';
      delBtn.addEventListener('click', function () {
        confirmInPopover(ctx, 'Delete Miniserver "' + v.name + '"?', function () {
          fetch('/miniservers/' + v.id + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function () { window.location.reload(); });
        });
      });
      actions.appendChild(delBtn);
    }
  }

  // Inline rather than pulling in icons.js server-side helpers — this is a plain static asset
  // with no template access, same reasoning tables.js's own inlined Columns-icon SVG already
  // documents for itself.
  var ICONS = {
    edit: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>',
    refresh: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    upload: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    plus: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    chevronsDown: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg>',
    chevronsUp: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/></svg>',
  };

  // ---- Diagnostics dialog: Check for update / Update to latest release / Add to Dashboard/Monitor
  // — the 4 action buttons the old table's own expand-row carried, moved into a dialog instead of
  // an inline expand (Tabulator has no first-class "expand this row taller" concept the way a
  // plain <table> row does) since every DATA field that row used to show is now just a regular,
  // independently-hideable column on the row itself instead. ----
  var diagDialog = document.getElementById('ms-diag-dialog');
  var diagTitle = document.getElementById('ms-diag-dialog-title');
  var diagStats = document.getElementById('ms-diag-dialog-stats');
  var diagActions = document.getElementById('ms-diag-dialog-actions');
  var diagResult = document.getElementById('ms-diag-dialog-result');
  var diagHint = document.getElementById('ms-diag-dialog-hint');
  document.getElementById('ms-diag-dialog-close').addEventListener('click', function () { diagDialog.close(); });

  function statBox(label, value, badgeCls) {
    var box = document.createElement('div');
    var labelEl = document.createElement('span');
    labelEl.className = 'hint';
    labelEl.style.margin = '0';
    labelEl.textContent = label;
    box.appendChild(labelEl);
    var valueEl = document.createElement('div');
    if (badgeCls && value && value !== '-') {
      valueEl.appendChild(badge(value, badgeCls));
    } else {
      valueEl.textContent = value || '-';
    }
    box.appendChild(valueEl);
    return box;
  }

  function openDiagnostics(v) {
    diagTitle.textContent = 'Diagnostics — ' + v.name;
    diagResult.textContent = '';
    diagHint.textContent = '';
    diagActions.innerHTML = '';
    diagStats.innerHTML = '';
    diagStats.appendChild(statBox('Miniserver state', v.stateLabel, v.stateBadgeClass));
    diagStats.appendChild(statBox('Firmware', v.firmwareVersion));
    diagStats.appendChild(statBox('Generation', v.generationLabel));
    diagStats.appendChild(statBox('CPU load', v.cpuLoad));
    diagStats.appendChild(statBox('Heap', v.heapStatus));
    diagStats.appendChild(statBox('Tasks', v.numTasks));
    diagStats.appendChild(statBox('Firmware date', v.firmwareDate));
    diagStats.appendChild(statBox('Update channel', v.updateLevel));
    var msOffline = v.status !== 'online';

    var checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'btn-test';
    checkBtn.innerHTML = ICONS.refresh + ' Check for update';
    checkBtn.disabled = msOffline;
    if (msOffline) checkBtn.title = 'Unavailable while this Miniserver is offline';

    var updateBtn = document.createElement('button');
    updateBtn.type = 'button';
    updateBtn.className = 'btn-edit';
    updateBtn.innerHTML = ICONS.upload + ' Update to latest release';
    updateBtn.disabled = true;
    updateBtn.title = msOffline ? 'Unavailable while this Miniserver is offline'
      : 'Run "Check for update" first — Loxone doesn’t expose a plain update-available flag over HTTP, so this only unlocks once you’ve looked at the current release channel yourself';

    checkBtn.addEventListener('click', function () {
      checkBtn.disabled = true;
      diagResult.textContent = 'Checking…';
      fetch('/miniservers/' + v.id + '/check-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { diagResult.textContent = data.error; return; }
          diagResult.textContent = 'Release channel: ' + (data.updateLevel || 'unknown') + '. Loxone doesn’t expose a plain "update available" flag over HTTP — open Loxone Config to see if a new release is actually offered.';
          updateBtn.disabled = false;
          updateBtn.title = 'Trigger a real firmware update on this Miniserver now';
        })
        .catch(function () { diagResult.textContent = 'Check failed.'; })
        .then(function () { checkBtn.disabled = false; });
    });

    updateBtn.addEventListener('click', function () {
      var confirmed = window.confirm(
        'This will trigger a REAL firmware update and reboot on "' + v.name + '" right now.\n\n' +
        'Loxone doesn’t expose whether a newer release actually exists over HTTP — this may reinstall the version you’re already running. Check Loxone Config directly first if you want to be sure.\n\n' +
        'Every device it controls will briefly stop responding while it restarts. This cannot be undone once started.\n\nContinue?'
      );
      if (!confirmed) return;
      updateBtn.disabled = true;
      diagResult.textContent = 'Triggering update…';
      fetch('/miniservers/' + v.id + '/update-firmware', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (data) { diagResult.textContent = data.note || (data.triggered ? 'Update triggered. The Miniserver may now reboot.' : 'Something went wrong.'); })
        .catch(function () { diagResult.textContent = 'Update triggered — connection ended (expected if the Miniserver is now rebooting).'; });
    });

    diagActions.appendChild(checkBtn);
    diagActions.appendChild(updateBtn);

    var addDashForm = document.createElement('form');
    addDashForm.className = 'inline';
    addDashForm.method = 'post';
    addDashForm.action = '/dashboards/quick-add-diag';
    addDashForm.innerHTML = '<input type="hidden" name="miniserver_id" value="' + v.id + '">' +
      '<button type="submit" class="primary"' + (msOffline ? ' disabled' : '') + '>' + ICONS.plus + ' Add to Dashboard</button>';
    diagActions.appendChild(addDashForm);

    // Greyed out once CPU load/Heap value/Task count already each have their own monitor —
    // findOrCreateDiagMonitor (monitorCollector.js) makes clicking it again harmless either way
    // (it reuses whichever already exist), so this is purely a clarity improvement, same as Live
    // Data's own already-monitored +Monitor button (routes/liveData.js).
    var monAlreadyDone = !msOffline && v.diagFullyMonitored;
    var addMonForm = document.createElement('form');
    addMonForm.className = 'inline';
    addMonForm.method = 'post';
    addMonForm.action = '/monitor/quick-add-diag';
    addMonForm.innerHTML = '<input type="hidden" name="miniserver_id" value="' + v.id + '">' +
      '<button type="submit" class="primary"' + (msOffline || monAlreadyDone ? ' disabled' : '') +
      (monAlreadyDone ? ' title="CPU load, Heap value and Task count are all already monitored"' : '') + '>' +
      ICONS.plus + ' ' + (monAlreadyDone ? 'Monitored' : 'Add to Monitor') + '</button>';
    diagActions.appendChild(addMonForm);

    diagHint.textContent = '"Check for update" reads this Miniserver’s own release channel (best-effort, not a guarantee). "Update to latest release" sends a real update command — a real firmware update and reboot on this Miniserver right now.';

    diagDialog.showModal();
  }

  // ---- Column definitions ----
  var columns = [
    { title: 'Status', field: 'status', formatter: statusFormatter, headerSort: true, sorter: 'string' },
    { title: 'State', field: 'stateLabel', formatter: stateFormatter, visible: false },
    { title: 'Firmware', field: 'firmwareVersion', formatter: textOrDash('firmwareVersion'), visible: false },
    { title: 'Generation', field: 'generationLabel', formatter: textOrDash('generationLabel'), visible: false },
    { title: 'CPU load', field: 'cpuLoad', formatter: textOrDash('cpuLoad'), visible: false },
    { title: 'Heap', field: 'heapStatus', formatter: textOrDash('heapStatus'), visible: false },
    { title: 'Tasks', field: 'numTasks', formatter: textOrDash('numTasks'), visible: false },
    { title: 'Firmware date', field: 'firmwareDate', formatter: textOrDash('firmwareDate'), visible: false },
    { title: 'Update channel', field: 'updateLevel', formatter: textOrDash('updateLevel'), visible: false },
    { title: 'Name', field: 'name', headerSort: true, sorter: 'string', minWidth: 180 },
    { title: 'Gateway Client', field: 'gatewayRole', formatter: gatewayClientFormatter },
    { title: 'Host', field: 'host' },
    { title: 'HTTP port', field: 'httpPort', hozAlign: 'left' },
    { title: 'HTTPS', field: 'useHttps', formatter: function (cell) { return cell.getValue() ? 'yes' : 'no'; } },
    { title: 'UDP port', field: 'udpPort', formatter: textOrDash('udpPort'), visible: false },
    { title: 'External URL', field: 'externalUrl', formatter: textOrDash('externalUrl'), visible: false },
    { title: 'User', field: 'username' },
    { title: 'Last checked', field: 'lastCheckedAt', formatter: textOrDash('lastCheckedAt') },
    { title: 'Last successful call', field: 'lastSuccessAt', formatter: textOrDash('lastSuccessAt') },
    { title: 'Last error', field: 'lastError', formatter: textOrDash('lastError') },
    { title: 'Actions', field: 'actions', formatter: actionsFormatter, headerSort: false, resizable: false, hozAlign: 'left', width: 90, headerHozAlign: 'left' },
  ];

  initTabulatorTable({
    container: 'ms-tabulator',
    tableKey: TABLE_KEY,
    columns: columns,
    defaultHidden: DEFAULT_HIDDEN,
    noControls: NO_CONTROLS,
    ajaxURL: '/miniservers/data.json',
    placeholder: 'No miniservers added yet.',
    dataTree: true,
    dataTreeChildField: '_children',
    dataTreeStartExpanded: false,
    dataTreeElementColumn: 'name',
    columnsBtn: 'ms-columns-btn',
    columnsPanel: 'ms-columns-panel',
    collapseAllBtn: 'ms-collapse-all-btn',
    collapseAllIconExpand: ICONS.chevronsDown,
    collapseAllIconCollapse: ICONS.chevronsUp,
    tabulatorOptions: {
      // Off — nothing on this page reads a row-selected state, and it was one of several internal
      // Tabulator mousedown handlers found to call stopPropagation() (see the row drag-reorder
      // comment below) for reasons unrelated to this page.
      selectableRows: false,
      // vendor/sortable.min.js (SortableJS) was the first thing tried here — vendored specifically
      // for this pilot, and confirmed working correctly against a plain, un-managed list (a bare
      // <ul>) — but Tabulator's own vendor/tabulator.min.js turned out to call
      // event.stopPropagation() on mousedown in several of its own internal handlers (row
      // selection, resize, its own range-selection), confirmed directly in its source, which
      // silently ate the mousedown before Sortable's own bubble-phase listener on the table
      // element ever saw it — a real, load-bearing part of how Tabulator keeps its OWN competing
      // drag-driven features (column resize, row selection drag, etc.) from clashing with each
      // other, not a bug, and not something an external library can safely route around. Tabulator
      // ships its own row-move module for exactly this reason — since it's Tabulator's own code
      // running inside Tabulator's own event system, it never hits that wall. Restores the old
      // plain-<table> version's own row-reorder (deliberately deferred out of the original pilot)
      // using that instead.
      movableRows: true,
      // Tags each row's own DOM element so rowMoved (below) can tell a top-level row apart from a
      // Client nested under it — Tabulator's own dataTree rows are all siblings in the same flat
      // DOM list once a Gateway's group is expanded, with indentation/branch icons the only visual
      // difference, so there's no existing class to check against without this. Also disables
      // move-by-drag on a Client row directly — vanilla movableRows has no separate handle/filter
      // option the way Sortable did, so this is done by hand: a non-top-level row's own drag
      // affordance is removed by intercepting its mousedown before Tabulator's own row-move
      // listener (registered earlier, during table construction) ever sees it.
      rowFormatter: function (row) {
        var el = row.getElement();
        if (row.getTreeParent()) {
          el.classList.remove('ms-toplevel-row');
          if (!el.dataset.msMoveBlocked) {
            el.dataset.msMoveBlocked = '1';
            el.addEventListener('mousedown', function (e) { e.stopPropagation(); }, true);
          }
        } else {
          el.classList.add('ms-toplevel-row');
          el.style.cursor = 'grab';
          el.title = 'Drag to reorder — this order is used everywhere Miniservers are listed';
          // Belt-and-suspenders on top of .ms-toplevel-row's own CSS user-select:none (see
          // style.css) — that alone stopped a NEW selection from starting cleanly in headless
          // Chromium, but a real click-and-drag in an actual browser could still leave a stray
          // selection highlighted right as the mouse comes up (a timing race between the
          // browser's own native mousedown-drag-select handling and Tabulator's own movableRows
          // taking over the same mousedown, browser-dependent). Clearing on mouseup catches that
          // regardless of exactly how it got created — only when the selection actually started
          // inside THIS row, so a legitimate text selection elsewhere on the page (e.g. copying
          // a value out of a different, non-draggable row) is never touched.
          if (!el.dataset.msSelectionGuard) {
            el.dataset.msSelectionGuard = '1';
            el.addEventListener('mouseup', function () {
              var sel = window.getSelection();
              if (sel && !sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode)) {
                sel.removeAllRanges();
              }
            });
          }
        }
      },
    },
  }).then(function (t) {
    table = t;
    // rowMoved as a plain constructor option (alongside rowFormatter above) never actually fired —
    // registered as a real event via .on() instead, the same reliable pattern the shared driver
    // itself already uses for columnResized/columnVisibilityChanged. Fires once a row-move drag
    // actually completes, not on every intermediate step. Only top-level rows are draggable in the
    // first place (Client rows have their own mousedown blocked above, see rowFormatter), so this
    // only ever needs to persist the top-level order.
    table.on('rowMoved', function () {
      var ids = table.getRows().filter(function (r) { return !r.getTreeParent(); }).map(function (r) { return r.getData().id; });
      // Full data reload, not just trusting the DOM Tabulator's own drag already produced —
      // /miniservers/reorder is the same route the old plain-<table> version's own native HTML5
      // drag-and-drop already used (still present and working server-side); reloading from it
      // afterward keeps Tabulator's row order in sync with the freshly-saved sort_order exactly,
      // the actual source of truth for every other page listing Miniservers.
      fetch('/miniservers/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids }) })
        .then(function () { table.replaceData(); });
    });
  });
})();
