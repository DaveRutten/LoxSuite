// Drag-to-resize for a .panel-settings-form drawer's width (dashboard panel Edit form, Monitor
// detail's own Chart settings, ...) — one shared handle per drawer, but only the currently-open
// one is ever visible (see .panel-drawer-resize-handle in style.css). The width itself lives in a
// CSS custom property on the root element, so every drawer (whichever one is open next, on
// whichever page) picks up the same value — this is a personal UI preference, not app data, so
// localStorage is enough; no server round-trip needed. Originally inline in panel-grid.ejs (the
// only drawer that existed yet); extracted here once the Monitor detail page's own chart-settings
// drawer became a second consumer.
(function () {
  var STORAGE_KEY = 'panelDrawerWidth';
  var MIN_WIDTH = 340;

  function maxWidth() { return Math.min(1000, window.innerWidth * 0.92); }

  var saved = localStorage.getItem(STORAGE_KEY);
  if (saved) document.documentElement.style.setProperty('--panel-drawer-width', Math.min(Number(saved), maxWidth()) + 'px');

  document.querySelectorAll('.panel-drawer-resize-handle').forEach(function (handle) {
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var drawer = handle.previousElementSibling;
      var startX = e.clientX;
      var startWidth = drawer.getBoundingClientRect().width;
      handle.classList.add('dragging');
      // The handle's own CSS cursor:ew-resize (see style.css) only actually shows while the
      // mouse is hovering that thin 6px strip — which it immediately isn't, the moment a real
      // drag starts moving the mouse away from it. Forcing it on <body> for the drag's duration
      // is what keeps the resize cursor showing everywhere the mouse passes over, not just
      // there; unset again on mouseup, once the drag itself no longer dictates what the cursor
      // means.
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        // Dragging left (clientX decreases) should widen the drawer — its right edge is pinned
        // to the viewport edge, so the left edge (and this handle) are what actually move.
        var width = Math.max(MIN_WIDTH, Math.min(maxWidth(), startWidth + (startX - e.clientX)));
        document.documentElement.style.setProperty('--panel-drawer-width', width + 'px');
        // Only defined on pages with a multi-panel grid to make room in (see panel-grid.ejs's own
        // backdrop script) — guarded since it simply doesn't exist on a single-drawer page like
        // Monitor detail, which has no panel to re-center in the first place.
        if (window.recenterEditingPanel) window.recenterEditingPanel();
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem(STORAGE_KEY, getComputedStyle(document.documentElement).getPropertyValue('--panel-drawer-width').trim().replace('px', ''));
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
})();
