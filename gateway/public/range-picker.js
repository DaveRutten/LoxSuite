// Shared sync behavior for every rangeField() (see chartFieldHelpers.js) on the page — the
// Dashboard panel Range field, Monitor detail's own range picker, the Home/My Dashboards time
// filter, and each Logs page's own filter form all render the identical
// select+custom-input+absolute-From/To markup and rely on this one script to make it work. Only
// ONE of select/custom-input/absolute-hidden-input ever carries a `name` at a time, so the field
// submits exactly one "range" value regardless of which mode is active. Loaded once sitewide (see
// partials/foot.ejs), not per-page, since every consumer needs the identical behavior.
(function () {
  document.querySelectorAll('.range-select').forEach(function (select) {
    var customInput = select.nextElementSibling;
    var absWrap = customInput.nextElementSibling;
    var startInput = absWrap.querySelector('.range-absolute-start');
    var endInput = absWrap.querySelector('.range-absolute-end');
    var hiddenInput = absWrap.querySelector('.range-absolute-hidden');
    var name = select.dataset.rangeName;
    // A page that opts into autoSubmit already navigates the instant a plain preset is picked —
    // its own "Go" button (if it has one at all; the dashboard panel Range field doesn't) is only
    // ever meaningful for Custom/Absolute, which both need more input first. Hidden the rest of
    // the time instead of sitting there as a do-nothing button once a preset already took effect.
    var wrapper = select.closest('.range-field-inline');
    var goBtn = wrapper && wrapper.nextElementSibling && wrapper.nextElementSibling.classList.contains('range-go-btn')
      ? wrapper.nextElementSibling : null;

    function pad(n) { return String(n).padStart(2, '0'); }
    function toLocalInputValue(ms) {
      var d = new Date(ms);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    // Pre-fills once from the server-supplied raw epoch ms (see rangeField() in chartFieldHelpers.js)
    // — done here in the browser specifically so these show in ITS local timezone, not whatever
    // timezone the Node process happens to be running in. First time Absolute range is ever picked
    // (nothing saved yet), default to a ready-to-go "last 2 hours" window instead of two blank
    // inputs someone has to fill in from scratch before Go even does anything useful.
    if (absWrap.dataset.startMs) {
      startInput.value = toLocalInputValue(Number(absWrap.dataset.startMs));
    } else {
      startInput.value = toLocalInputValue(Date.now() - 2 * 60 * 60 * 1000);
    }
    if (absWrap.dataset.endMs) {
      endInput.value = toLocalInputValue(Number(absWrap.dataset.endMs));
    } else {
      endInput.value = toLocalInputValue(Date.now());
    }

    function updateHidden() {
      if (!startInput.value || !endInput.value) return;
      hiddenInput.value = 'abs_' + new Date(startInput.value).getTime() + '_' + new Date(endInput.value).getTime();
    }
    updateHidden();

    function sync() {
      var mode = select.value;
      select.removeAttribute('name');
      customInput.removeAttribute('name');
      hiddenInput.removeAttribute('name');
      customInput.style.display = 'none';
      absWrap.style.display = 'none';
      if (mode === '__custom__') {
        customInput.name = name;
        customInput.style.display = '';
      } else if (mode === '__absolute__') {
        hiddenInput.name = name;
        absWrap.style.display = 'flex';
        updateHidden();
      } else {
        select.name = name;
      }
      if (goBtn) goBtn.style.display = (mode === '__custom__' || mode === '__absolute__') ? '' : 'none';
    }
    select.addEventListener('change', function () {
      sync();
      if (select.value === '__custom__') {
        customInput.focus();
      } else if (select.dataset.autoSubmit === '1' && select.value !== '__absolute__') {
        // A plain preset pick is immediately meaningful on its own (unlike Custom/Absolute, which
        // both need more input first) — read-only "filter this page" consumers opt into this via
        // rangeField()'s own autoSubmit option so picking one just navigates right away, matching
        // how a plain preset link/tab used to behave before this became a shared dropdown.
        var form = select.closest('form');
        if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
      }
    });
    // Re-picking "Absolute range…" while it's already the select's own value fires no 'change'
    // event at all (the value didn't change) — needed so the box can be reopened after an outside
    // click dismissed it (see the document-level listener below) without first switching to some
    // other option and back.
    select.addEventListener('mousedown', function () {
      if (select.value === '__absolute__' && absWrap.style.display === 'none') absWrap.style.display = 'flex';
    });
    startInput.addEventListener('change', updateHidden);
    endInput.addEventListener('change', updateHidden);
    sync();
  });

  // The absolute-range box dismisses on an outside click, same as every other floating panel in
  // this app (.columns-menu-panel, .confirm-bar-popover, ...) — left out originally since this one
  // opens from a <select> value rather than a dedicated toggle button, but it still needs a way to
  // go away again besides picking an entirely different range first.
  document.addEventListener('click', function (e) {
    document.querySelectorAll('.range-absolute-wrap').forEach(function (wrap) {
      if (wrap.style.display === 'none') return;
      var wrapper = wrap.closest('.range-field-inline');
      if (wrapper && !wrapper.contains(e.target)) wrap.style.display = 'none';
    });
  });
})();
