// Any <select data-auto-submit-form> immediately submits its own enclosing <form> when its value
// changes — used by the Logs pages' Level/Severity/Miniserver filters (see logs-mqtt.ejs etc.),
// which no longer have a separate "Apply" button: each pick is its own complete, immediately
// meaningful choice, same reasoning as the Range field's own autoSubmit option (see
// range-picker.js) just for a plain select with no Custom/Absolute sub-modes to gate on first.
(function () {
  document.querySelectorAll('select[data-auto-submit-form]').forEach(function (select) {
    select.addEventListener('change', function () {
      var form = select.closest('form');
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    });
  });
})();
