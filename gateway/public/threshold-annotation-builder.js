// Drives every .threshold-builder/.annotation-builder on the page (see thresholdField()/
// annotationField() in chartFieldHelpers.js) — dynamic add/remove-row UIs over a hidden textarea,
// kept in the exact format dashboards.js's parseThresholdLadder/parseAnnotations already expect.
// Originally inline in panel-grid.ejs (the only page with either builder); extracted here once the
// Monitor detail page's own chart settings became a second consumer — both pages just need
// LoxColorPicker (color-picker.js) loaded first, same as panel-grid.ejs already required.

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
    builder.querySelector('.threshold-builder-rows').appendChild(row);

    row.querySelector('.threshold-row-value').addEventListener('input', function () { serializeRows(builder); });
    row.querySelector('.threshold-row-style').addEventListener('change', function () { serializeRows(builder); });
    row.querySelector('.threshold-row-color').addEventListener('change', function () { serializeRows(builder); });
    var notifyBox = row.querySelector('.threshold-row-notify');
    if (notifyBox) {
      notifyBox.checked = !!notify;
      notifyBox.addEventListener('change', function () { serializeRows(builder); });
    }
    row.querySelector('.threshold-row-remove').addEventListener('click', function () {
      row.remove();
      serializeRows(builder);
    });
  }

  document.querySelectorAll('.threshold-builder').forEach(function (builder) {
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
  });
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
    builder.querySelector('.annotation-builder-rows').appendChild(row);

    row.querySelector('.annotation-row-time').addEventListener('change', function () { serializeRows(builder); });
    row.querySelector('.annotation-row-label').addEventListener('input', function () { serializeRows(builder); });
    row.querySelector('.annotation-row-color').addEventListener('change', function () { serializeRows(builder); });
    row.querySelector('.annotation-row-remove').addEventListener('click', function () {
      row.remove();
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
