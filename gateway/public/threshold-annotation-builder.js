// Drives every .threshold-builder/.annotation-builder on the page (see thresholdField()/
// annotationField() in chartFieldHelpers.js) — dynamic add/remove-row UIs over a hidden textarea,
// kept in the exact format dashboards.js's parseThresholdLadder/parseAnnotations already expect.
// Originally inline in panel-grid.ejs (the only page with either builder); extracted here once the
// Monitor detail page's own chart settings became a second consumer — both pages just need
// LoxColorPicker (color-picker.js) loaded first, same as panel-grid.ejs already required.

// Generic drag-to-reorder for any dynamic row-builder list — threshold/value-mapping/annotation
// rows all share this same shape (a flat list of sibling rows in one container, each serialized
// back into a hidden textarea by reading the container's CURRENT DOM order), so one shared helper
// covers all three rather than three near-identical drag implementations. A small dedicated grip
// handle (not the whole row) is what's actually draggable — a row is full of its own inputs/
// selects/color pickers, and making the whole thing draggable risks fighting those for an
// ordinary click/drag-to-select-text gesture. Exposed globally (not an IIFE-private helper) since
// foot.ejs's own value-mapping-builder script is a separate <script> block from this file, loaded
// afterward — see panel-grid.ejs/monitor-detail.ejs's own <script src> order for why this file's
// top-level code is guaranteed to have already run by the time that one calls in.
//
// Two implementations behind the same attachRow/removeRow API, picked by opts.dropIndicator:
//  - The plain row lists (threshold/annotation/value-mapping — this file's own three builders
//    below, plus foot.ejs's value-mapping-builder) now use SortableJS (vendor/sortable.min.js,
//    already vendored for an earlier Miniservers pilot — reverted THERE only because Tabulator's
//    own internal mousedown handlers ate the event before Sortable's own listener ever saw it, see
//    miniservers-tabulator.js's own comment; nothing here is inside a Tabulator table, so that
//    conflict doesn't apply). See attachRowSortable below for why forceFallback:true and
//    body.lox-row-reordering are still both needed despite switching libraries.
//  - The dashboard group-reorder (panel-grid.ejs, opts.dropIndicator:true — whole variable-height
//    GROUP units, each hosting its own nested GridStack grid) stays on the original hand-rolled
//    pointer-drag below (attachRowLegacy) unchanged. That's the one consumer a from-scratch
//    GridStack-based rewrite already proved fragile against (dragging never reliably registered,
//    and a failed drag left GridStack's own internal state inconsistent enough to also break the
//    color picker and delete on the SAME row) — not something to risk a second library swap on
//    when it's never actually had a reported bug of its own, and the live drop-zone box it uses has
//    no equivalent built into the SortableJS path.
window.LoxRowReorder = (function () {
  var GRIP_SVG = '<svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>';

  // SortableJS path — see the shared drag-to-reorder comment above. Only ONE Sortable instance is
  // ever created per container (guarded by dataset.loxSortableInit), the first time a row is added
  // to it; every later row just needs its own grip handle, since Sortable's own `handle` option is
  // a CSS selector matched fresh at drag-time against whatever's currently inside the container —
  // one shared class covers every row already/still-to-be added, no per-row Sortable API calls
  // needed. onReorder is likewise only captured once, from the container's first row — every
  // existing caller passes a fresh-but-functionally-identical closure per row (it always just
  // re-serializes the container's current DOM order), so reusing the first one is safe.
  function attachRowSortable(row, container, onReorder) {
    var handle = document.createElement('span');
    handle.className = 'row-drag-handle';
    handle.title = 'Drag to reorder';
    handle.innerHTML = GRIP_SVG;
    handle.setAttribute('draggable', 'false'); // belt-and-suspenders, see attachRowLegacy's own note on native drag
    row.insertBefore(handle, row.firstChild);

    if (container.dataset.loxSortableInit) return;
    container.dataset.loxSortableInit = '1';
    Sortable.create(container, {
      handle: '.row-drag-handle',
      animation: 150,
      // Keeps this off NATIVE HTML5 drag-and-drop specifically — a native drag starting anywhere
      // inside this same .panel-settings-form drawer is exactly what caused the "see-through
      // drawer" compositing glitch documented on attachRowLegacy below (Chromium flattening the
      // drawer's own position:fixed + CSS-transform box into its own layer for the drag). Sortable's
      // fallback mode drives the drag with plain mouse/touch events instead, so that browser
      // mechanism never gets involved — the same reason the original hand-rolled version avoided
      // native drag entirely.
      forceFallback: true,
      // Reuses the existing "lifted" look (style.css) already built for this exact row-dragging
      // state, so switching engines doesn't change how a drag actually looks.
      chosenClass: 'row-dragging',
      // Same body-level class the legacy path below still toggles for its own drag, and the SAME
      // CSS rule it exists for (style.css: body.lox-row-reordering .panel-settings-form.open —
      // strips the drawer's transform for the drag's duration, pulling it out of its own
      // compositing layer). That fix is about the drawer's own transform, not about which code is
      // doing the reordering — Sortable's live DOM-reflow-during-drag is a different mechanism than
      // the legacy path's defer-until-drop approach, so this isn't assumed to be automatically
      // immune to the same glitch just because it's a different library; toggled here for the same
      // protection regardless.
      onStart: function () { document.body.classList.add('lox-row-reordering'); },
      onEnd: function () {
        document.body.classList.remove('lox-row-reordering');
        onReorder();
      },
    });
  }

  // Legacy hand-rolled pointer-drag — kept only for the dashboard group-reorder consumer
  // (opts.dropIndicator:true, see the shared comment above for why). Call once per newly-built
  // row, right after it's appended to its own container. opts.handle lets a caller supply its OWN
  // pre-existing element as the drag trigger (e.g. a dashboard group's header bar already has its
  // own grip icon in a specific spot) instead of always getting a freshly-created, auto-prepended
  // one.
  // Pointer-based (mousedown/move/up), not native HTML5 drag-and-drop — tried native drag first
  // (draggable=true + dragstart/dragover/drop + an explicit small setDragImage to avoid the
  // browser's own oversized default ghost) but a translucent-layer rendering artifact still showed
  // during the drag regardless, almost certainly Chromium flattening the whole position:fixed
  // .panel-settings-form drawer into a compositing layer for the drag operation because of its own
  // CSS transform (the same mechanism that drawer's slide-in animation uses). A plain pointer-driven
  // reorder — the same technique the panel-resize-handle elsewhere in this app already uses — never
  // starts a native drag operation at all, so that whole rendering path never gets involved.
  //
  // A GridStack-based rewrite of this (reusing the same engine as the dashboard panel grid) was
  // tried and reverted — dragging never reliably registered via dragHandle scoping inside the
  // .panel-settings-form drawer's own fixed-position/transformed layout, and a failed drag left the
  // grid's internal state inconsistent enough to also break the color picker and delete on the SAME
  // row afterward. This hand-rolled version has none of that: it never asks GridStack to track
  // anything happening inside a drawer at all.
  function attachRowLegacy(row, container, onReorder, opts) {
    var handle = opts && opts.handle;
    if (!handle) {
      handle = document.createElement('span');
      handle.className = 'row-drag-handle';
      handle.title = 'Drag to reorder';
      handle.innerHTML = GRIP_SVG;
      row.insertBefore(handle, row.firstChild);
    }

    var dragging = false;

    // Belt-and-suspenders against a NATIVE drag ever starting from the grip (its <svg> icon, an
    // image, etc.). This is NOT what caused the "see through the edit panel" glitch — that was
    // GridStack grabbing the panel, handled just below — but a stray native drag is cheap to rule
    // out and would look just as broken, so dragstart is cancelled here and (for the duration of a
    // reorder) at the document level too.
    function blockNativeDrag(e) { e.preventDefault(); }
    handle.setAttribute('draggable', 'false');
    handle.addEventListener('dragstart', blockNativeDrag);

    // THE important one: a threshold/value/annotation row lives inside the panel's edit drawer, which
    // is itself inside a GridStack grid item (the panel being edited). GridStack listens for a
    // pointerdown/mousedown bubbling up out of that item and — since the press isn't on its own
    // .widget-drag-handle it should ignore it, but in practice a press that then moves still kicked
    // off a panel drag — starts dragging the WHOLE panel. That stray panel drag is what turned the
    // drawer translucent ("see through the edit panel") AND lit up the dashboard's drop zones behind
    // it. Stopping the press from propagating past the grip keeps GridStack from ever seeing it, so
    // grabbing a row reorders the row and nothing else. (Harmless for the group-reorder caller, whose
    // handle isn't inside a grid item.)
    handle.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

    // Where would the row land if dropped at this Y? Tested against the OTHER rows' live positions,
    // which never move during the drag (see onMove) — so this stays a plain midpoint check, and it
    // works fine for variable-height items too (the group-reorder caller drags whole group units).
    function computeAfterEl(clientY) {
      var siblings = Array.prototype.slice.call(container.children).filter(function (el) {
        return el !== row && el !== dropIndicator;
      });
      for (var i = 0; i < siblings.length; i++) {
        var rect = siblings[i].getBoundingClientRect();
        if (clientY - rect.top - rect.height / 2 < 0) return siblings[i];
      }
      return null;
    }

    // Optional live "it lands here" box (opts.dropIndicator) — a green drop zone shown at the target
    // slot during the drag, so a group reorder gets the same green drop feedback the panel grids give
    // (see .lox-reorder-drop-indicator in style.css). Only this thin marker moves through the DOM;
    // the dragged item itself just rides its transform. Off by default, so the drawer row-builders
    // keep their plain lift-and-snap.
    var showDropIndicator = !!(opts && opts.dropIndicator);
    var dropIndicator = null;
    // Sized to match row's own height (instead of the CSS default, a flat 46px) and slotted into
    // its exact original spot BEFORE floatRow() below pulls row out of flow — so the vacated gap is
    // filled in the very same reflow that creates it. Skipping that meant the indicator didn't exist
    // yet for that first reflow, so every later sibling jumped up to close row's WHOLE gap a frame
    // early; computeAfterEl(startClientY) then measured against those already-shifted siblings while
    // startClientY itself still described the OLD layout, so the indicator could land a sibling or two
    // away from a drag that hadn't actually moved yet — reported as "the drop box shows right under
    // the bar I just grabbed" instead of tracking the group before/after it.
    function initDropIndicator() {
      if (!showDropIndicator || dropIndicator) return;
      var rect = row.getBoundingClientRect();
      dropIndicator = document.createElement('div');
      dropIndicator.className = 'lox-reorder-drop-indicator';
      dropIndicator.style.height = rect.height + 'px';
      container.insertBefore(dropIndicator, row.nextElementSibling);
    }
    function moveDropIndicator(clientY) {
      if (!showDropIndicator || !dropIndicator) return;
      var afterEl = computeAfterEl(clientY);
      if (afterEl == null) container.appendChild(dropIndicator);
      else container.insertBefore(dropIndicator, afterEl);
    }
    function clearDropIndicator() {
      if (dropIndicator && dropIndicator.parentNode) dropIndicator.parentNode.removeChild(dropIndicator);
      dropIndicator = null;
    }

    var startClientY = 0;

    // With the drop indicator on, row is ALSO pulled clean out of normal flow for the drag's
    // duration (position:fixed, sized/positioned to match exactly where it already was) — one
    // single reflow right at drag-start, not per-frame. Without this, row's own original slot stays
    // reserved in the layout the whole time (a transform never removes anything from flow), so the
    // indicator computed a target a few rows away while row's own now-empty-looking gap sat right
    // next to it — reading as two boxes for one drag instead of the one it's supposed to be. The
    // drawer row-builders (no indicator) skip this entirely and keep the simpler, reflow-free
    // transform-only version — that one-time reflow is exactly what the transform rewrite above was
    // introduced to avoid inside the drawer's own compositing layer.
    var floated = false;
    function floatRow() {
      if (!showDropIndicator || floated) return;
      floated = true;
      var rect = row.getBoundingClientRect();
      row.style.position = 'fixed';
      row.style.top = rect.top + 'px';
      row.style.left = rect.left + 'px';
      row.style.width = rect.width + 'px';
      row.style.zIndex = '1000';
    }
    function unfloatRow() {
      if (!floated) return;
      floated = false;
      row.style.position = '';
      row.style.top = '';
      row.style.left = '';
      row.style.width = '';
      row.style.zIndex = '';
    }

    // The picked-up row FOLLOWS the cursor with a transform only (or, with the drop indicator on,
    // by updating its own fixed `top`) — the DOM is never touched while the drag is in flight. The
    // old version re-ran insertBefore on every mousemove; that continuous reflow, inside a
    // position:fixed drawer the compositor keeps as its own layer, is exactly what made the drawer
    // flash translucent ("see through the edit panel") every frame. A transform is resolved on the
    // compositor with no layout/reflow at all, so the drawer stays put and opaque. The real reorder
    // happens once, on drop (onUp), from the final cursor position.
    function onMove(e) {
      if (!dragging) return;
      if (floated) row.style.top = (e.clientY - startClientY + parseFloat(row.dataset.floatStartTop)) + 'px';
      else row.style.transform = 'translateY(' + (e.clientY - startClientY) + 'px)';
      moveDropIndicator(e.clientY);
    }
    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      row.classList.remove('row-dragging');
      document.body.classList.remove('lox-row-reordering');
      row.style.transform = '';
      unfloatRow();
      clearDropIndicator();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('dragstart', blockNativeDrag, true);
      var afterEl = computeAfterEl(e.clientY);
      if (afterEl == null) container.appendChild(row);
      else container.insertBefore(row, afterEl);
      onReorder();
    }

    handle.addEventListener('mousedown', function (e) {
      e.preventDefault(); // no text-selection/native-drag getting a foot in the door
      e.stopPropagation(); // and don't let GridStack (an ancestor grid item) treat this as a panel drag
      dragging = true;
      startClientY = e.clientY;
      // Swallow any dragstart anywhere for the whole reorder, so a native drag can't spin up while a
      // row is in hand — see blockNativeDrag above.
      document.addEventListener('dragstart', blockNativeDrag, true);
      row.classList.add('row-dragging');
      document.body.classList.add('lox-row-reordering');
      if (showDropIndicator) {
        var rect = row.getBoundingClientRect();
        row.dataset.floatStartTop = String(rect.top);
        initDropIndicator();
        floatRow();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Public entry point — dispatches to whichever implementation opts.dropIndicator calls for (see
  // the shared comment at the top of this module).
  function attachRow(row, container, onReorder, opts) {
    if (opts && opts.dropIndicator) attachRowLegacy(row, container, onReorder, opts);
    else attachRowSortable(row, container, onReorder);
  }

  // The counterpart to attachRow — a plain row.remove() covers both implementations' own needs
  // entirely (Sortable operates on live DOM queries, no per-row unregistration needed; the legacy
  // path never had a wrapper shell to clean up either), kept as its own named function anyway so
  // callers don't need to know which implementation is behind it.
  function removeRow(row) {
    row.remove();
  }

  return { attachRow: attachRow, removeRow: removeRow };
})();

// Threshold ladder: value + color + line/band style per row ("<value>=<color>=<style>"). The Style
// column only visibly changes anything on a Chart panel (drawn as either a dashed line or a filled
// band — see makeThresholdPlugin in monitor-chart.js); every other panel type that reuses this same
// builder for value-coloring just ignores it.
(function () {
  function serializeRows(builder) {
    var allowNotify = builder.hasAttribute('data-allow-notify');
    var lines = [];
    builder.querySelectorAll('.threshold-builder-row').forEach(function (row) {
      var value = row.querySelector('.threshold-row-value').value.trim();
      var color = row.querySelector('.threshold-row-color').value;
      var style = row.querySelector('.threshold-row-style').value;
      if (value === '' || !color) return;
      var line = value + '=' + color + '=' + style;
      var notifyBox = allowNotify ? row.querySelector('.threshold-row-notify') : null;
      if (notifyBox && notifyBox.checked) line += '=1';
      lines.push(line);
    });
    builder.querySelector('.threshold-builder-hidden').value = lines.join('\n');
  }

  function addRow(builder, value, color, style, notify) {
    var allowNotify = builder.hasAttribute('data-allow-notify');
    var row = document.createElement('div');
    row.className = 'threshold-builder-row';
    var usedColors = Array.prototype.map.call(builder.querySelectorAll('.threshold-row-color'), function (el) { return el.value; });
    row.innerHTML =
      '<input type="number" class="threshold-row-value" placeholder="Value" step="any">' +
      '<select class="threshold-row-style" title="Line: a dashed line at this value. Band: a filled zone from this value up to the next threshold.">' +
        '<option value="line">Line</option>' +
        '<option value="band">Band</option>' +
      '</select>' +
      (allowNotify ? '<label class="threshold-row-notify-label" title="Send this rung to the Notification Center when a reading enters it"><input type="checkbox" class="threshold-row-notify"> Notify</label>' : '') +
      LoxColorPicker.buildPickerHtml(color || LoxColorPicker.nextAvailableColor(usedColors), 'threshold-row-color') +
      '<button type="button" class="icon-btn icon-btn-danger threshold-row-remove" title="Remove" aria-label="Remove">&times;</button>';
    row.querySelector('.threshold-row-value').value = value == null ? '' : value;
    row.querySelector('.threshold-row-style').value = style === 'band' ? 'band' : 'line';
    var rowsContainer = builder.querySelector('.threshold-builder-rows');
    rowsContainer.appendChild(row);
    LoxRowReorder.attachRow(row, rowsContainer, function () { serializeRows(builder); });

    row.querySelector('.threshold-row-value').addEventListener('input', function () { serializeRows(builder); });
    row.querySelector('.threshold-row-style').addEventListener('change', function () { serializeRows(builder); });
    row.querySelector('.threshold-row-color').addEventListener('change', function () { serializeRows(builder); });
    var notifyBox = row.querySelector('.threshold-row-notify');
    if (notifyBox) {
      notifyBox.checked = !!notify;
      notifyBox.addEventListener('change', function () { serializeRows(builder); });
    }
    row.querySelector('.threshold-row-remove').addEventListener('click', function () {
      LoxRowReorder.removeRow(row);
      serializeRows(builder);
    });
  }

  // Split out so a .threshold-builder created entirely client-side (a per-monitor gauge threshold
  // override — see panel-grid.ejs's gauge-series row builder) can be wired up on demand, the same
  // way every other dynamic row builder in that file already is, instead of only ever running once
  // against whatever .threshold-builder elements happened to exist at this script's own load time.
  function initThresholdBuilder(builder) {
    var hidden = builder.querySelector('.threshold-builder-hidden');
    hidden.value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).forEach(function (line) {
      var parts = line.split('=');
      if (parts.length < 2) return;
      addRow(builder, parts[0], parts[1], parts[2], parts[3] === '1');
    });
    builder.querySelector('.threshold-add-row').addEventListener('click', function () {
      addRow(builder, '', null, 'line', false);
      serializeRows(builder);
    });
  }

  document.querySelectorAll('.threshold-builder').forEach(initThresholdBuilder);
  window.LoxThresholdBuilder = { init: initThresholdBuilder };
})();

// Annotations: a labeled vertical line at a fixed moment in time ("<epoch-ms>=<label>[=<color>]").
(function () {
  function pad(n) { return String(n).padStart(2, '0'); }
  // datetime-local reads/writes in whatever timezone the BROWSER is in, same as the Range field's
  // own absolute-range inputs (see panel-grid.ejs) — the value stored server-side is always a
  // plain epoch ms, so this is purely a display-time conversion.
  function toLocalInputValue(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function serializeRows(builder) {
    var lines = [];
    builder.querySelectorAll('.annotation-row').forEach(function (row) {
      var timeStr = row.querySelector('.annotation-row-time').value;
      var label = row.querySelector('.annotation-row-label').value.trim();
      var color = row.querySelector('.annotation-row-color').value;
      if (!timeStr || !label) return;
      var ms = new Date(timeStr).getTime();
      if (!Number.isFinite(ms)) return;
      lines.push(ms + '=' + label + '=' + color);
    });
    builder.querySelector('.annotation-builder-hidden').value = lines.join('\n');
  }

  function addRow(builder, ms, label, color) {
    var row = document.createElement('div');
    row.className = 'annotation-row';
    var usedColors = Array.prototype.map.call(builder.querySelectorAll('.annotation-row-color'), function (el) { return el.value; });
    row.innerHTML =
      '<input type="datetime-local" class="annotation-row-time">' +
      '<input type="text" class="annotation-row-label" placeholder="Label">' +
      LoxColorPicker.buildPickerHtml(color || LoxColorPicker.nextAvailableColor(usedColors), 'annotation-row-color') +
      '<button type="button" class="icon-btn icon-btn-danger annotation-row-remove" title="Remove" aria-label="Remove">&times;</button>';
    row.querySelector('.annotation-row-time').value = toLocalInputValue(ms != null ? ms : Date.now());
    row.querySelector('.annotation-row-label').value = label == null ? '' : label;
    var rowsContainer = builder.querySelector('.annotation-builder-rows');
    rowsContainer.appendChild(row);
    LoxRowReorder.attachRow(row, rowsContainer, function () { serializeRows(builder); });

    row.querySelector('.annotation-row-time').addEventListener('change', function () { serializeRows(builder); });
    row.querySelector('.annotation-row-label').addEventListener('input', function () { serializeRows(builder); });
    row.querySelector('.annotation-row-color').addEventListener('change', function () { serializeRows(builder); });
    row.querySelector('.annotation-row-remove').addEventListener('click', function () {
      LoxRowReorder.removeRow(row);
      serializeRows(builder);
    });
  }

  document.querySelectorAll('.annotation-builder').forEach(function (builder) {
    var hidden = builder.querySelector('.annotation-builder-hidden');
    hidden.value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).forEach(function (line) {
      var parts = line.split('=');
      if (parts.length < 2) return;
      var ms = Number(parts[0]);
      if (!Number.isFinite(ms)) return;
      var color = parts.length > 2 ? parts.slice(2).join('=').trim() : '';
      addRow(builder, ms, parts[1], color);
    });
    builder.querySelector('.annotation-add-row').addEventListener('click', function () {
      addRow(builder, Date.now(), '', null);
      serializeRows(builder);
    });
  });
})();
