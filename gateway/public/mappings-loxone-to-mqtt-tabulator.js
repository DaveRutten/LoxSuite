// Loxone → MQTT mappings table, driven by the shared gateway/public/tabulator-table.js.
// The old page's own inline "Test" expand-row (value input + autocomplete suggestions or a
// translation-values dropdown, Send, result text) becomes a dialog opened from the kebab menu —
// the same treatment Miniservers' own Diagnostics dialog already got, for the same reason
// (Tabulator has no first-class "expand this row taller" the way a plain <table> row does).
(function () {
  var container = document.getElementById('l2m-tabulator');
  if (!container) return;

  var ICONS = {
    edit: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>',
    power: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>',
    list: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    copy: '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  };

  function statusFormatter(cell) {
    var v = cell.getRow().getData();
    var span = document.createElement('span');
    span.className = 'badge badge-live ' + (v.enabled ? 'badge-ok' : 'badge-neutral');
    span.textContent = v.enabled ? 'Active' : 'Off';
    return span;
  }

  // Same copy-btn markup/classes the page's own generic, already-existing document-level
  // delegated click handler (see mappings-loxone-to-mqtt.ejs) already knows how to wire up —
  // nothing Tabulator-specific needed here beyond building the button itself.
  function copyRow(codeText, copyValue, title) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:0.35rem;';
    var code = document.createElement('code');
    code.className = 'truncate';
    code.style.cssText = 'flex:1; min-width:0; max-width:none;';
    code.title = title;
    code.textContent = codeText;
    wrap.appendChild(code);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn btn-soft';
    btn.style.flexShrink = '0';
    btn.setAttribute('data-copy', copyValue);
    btn.title = title;
    btn.innerHTML = ICONS.copy + ' <span class="btn-label">Copy</span>';
    wrap.appendChild(btn);
    return wrap;
  }

  function topicFormatter(cell) {
    var v = cell.getRow().getData();
    return copyRow(v.mqttTopic, v.mqttTopic, 'Copy the MQTT topic');
  }

  function tokenFormatter(cell) {
    var v = cell.getRow().getData();
    var box = document.createElement('div');
    var code = document.createElement('code');
    code.className = 'truncate';
    code.title = v.token;
    code.textContent = v.token;
    box.appendChild(code);
    if (v.transport === 'udp') {
      var msgRow = copyRow('UDP message: ' + v.udpMessage, v.udpMessage, 'Copy the exact "<token>=<value>" message a Virtual UDP Output should send');
      msgRow.className = 'hint';
      msgRow.style.marginTop = '0.3rem';
      box.appendChild(msgRow);
    }
    return box;
  }

  function connectionInfoFormatter(cell) {
    var v = cell.getRow().getData();
    var row = copyRow('Loxone Command: ' + v.mqttTopic + ' \\v', v.mqttTopic + ' \\v', "Copy for a native MQTT Virtual Output's Command Recognition field (Loxone Config 12+) — bypasses this HTTP/UDP bridge entirely");
    row.className = 'hint';
    return row;
  }

  // ---- Test dialog ----
  var testDialog = document.getElementById('l2m-test-dialog');
  var testTitle = document.getElementById('l2m-test-dialog-title');
  var testValueWrap = document.getElementById('l2m-test-value-wrap');
  var testSendBtn = document.getElementById('l2m-test-send-btn');
  var testResult = document.getElementById('l2m-test-result');
  document.getElementById('l2m-test-dialog-close').addEventListener('click', function () { testDialog.close(); });

  // Inverse of loxone.js's own loxoneHsvToRgb (H 0-359, S/V 0-100) — standard RGB->HSV conversion,
  // kept in lockstep with that function's own hue-sextant math so a color picked here round-trips
  // back through the real transform on the server to (rounding aside) the same RGB the swatch shows.
  function rgbToLoxoneHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    var s = max === 0 ? 0 : d / max;
    return { h: Math.round(h), s: Math.round(s * 100), v: Math.round(max * 100) };
  }

  // Inverse of loxone.js's own decodePackedRgbPercent (red% + green%*1000 + blue%*1000000, each
  // channel 0-100) — Loxone's "Analoge ingang RGB" packed format, a completely different
  // convention from the H,S,V one above (see that function's own comment).
  function rgbToPackedPercent(r, g, b) {
    var toPct = function (c) { return Math.round(c / 255 * 100); };
    return toPct(b) * 1000000 + toPct(g) * 1000 + toPct(r);
  }

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // The same shared color-picker control every threshold/value-mapping/annotation/chart-series row
  // already uses (window.LoxColorPicker, see color-picker.js) — a swatch button opening a palette
  // grid plus a custom-hex fallback — rather than a bare native <input type="color">, for the same
  // look everywhere else in the app already has one. Its own hidden `.color-picker-value` input
  // only ever carries a hex color though; a second, separate hidden input here carries the actual
  // raw value Loxone's own HSV or packed-RGB convention needs (what testSendBtn.onclick posts),
  // recomputed from that hex on every change — a live readout shows exactly what will be sent, same
  // as typing it into the plain text input by hand would show once typed.
  // Escape hatch shared by every shelly_rgbw picker variant below: testing an exact payload the
  // picker itself can't produce (a shape the real device also accepts but this transform never
  // generates, e.g. extra fields, or checking how the device reacts to a deliberately malformed
  // body) — sent completely as typed, with no HSV/packed-percent/brightness conversion at all.
  // Safe to reuse the exact same test endpoint for this: applyLoxoneToMqttTransform's own HSV/
  // packed-percent/white parsing already falls back to publishing the raw value verbatim, unchanged,
  // whenever it can't parse as its own expected shape (see applyShellyRgbwTransform in loxone.js) —
  // real JSON always fails that parse (`{`/`"`/`:` are never valid numbers), so it always takes that
  // fallback path rather than being reinterpreted as something else. primaryRow is hidden while JSON
  // mode is active; onBackToPrimary re-derives hiddenValue/readout from the primary control's own
  // current state when switching back off it.
  function attachJsonToggle(outer, primaryRow, hiddenValue, readout, onBackToPrimary) {
    var jsonToggle = document.createElement('button');
    jsonToggle.type = 'button';
    jsonToggle.style.cssText = 'font-size:0.78rem; background:none; border:none; padding:0; margin-top:0.5rem; color:var(--accent); cursor:pointer; text-decoration:underline;';
    jsonToggle.textContent = 'Paste JSON instead';
    outer.appendChild(jsonToggle);

    var jsonRow = document.createElement('div');
    jsonRow.hidden = true;
    jsonRow.style.cssText = 'margin-top:0.5rem;';
    var jsonTextarea = document.createElement('textarea');
    jsonTextarea.rows = 3;
    jsonTextarea.placeholder = '{"red":255,"green":0,"blue":128,"turn":"on"}';
    jsonTextarea.style.cssText = 'width:100%; max-width:28rem; font-family:"SF Mono", Consolas, monospace; font-size:0.82rem; padding:0.5rem 0.6rem; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--text);';
    jsonRow.appendChild(jsonTextarea);
    var jsonHint = document.createElement('p');
    jsonHint.className = 'hint';
    jsonHint.style.marginTop = '0.3rem';
    jsonHint.textContent = 'Sent exactly as typed — not run through the transform at all.';
    jsonRow.appendChild(jsonHint);
    outer.appendChild(jsonRow);

    function updateFromTextarea() {
      var v = jsonTextarea.value.trim();
      hiddenValue.value = v;
      readout.textContent = v ? 'sends "' + v + '"' : '';
    }

    var inJsonMode = false;
    jsonToggle.addEventListener('click', function () {
      inJsonMode = !inJsonMode;
      primaryRow.hidden = inJsonMode;
      jsonRow.hidden = !inJsonMode;
      jsonToggle.textContent = inJsonMode ? 'Back to picker' : 'Paste JSON instead';
      if (inJsonMode) { updateFromTextarea(); jsonTextarea.focus(); } else { onBackToPrimary(); }
    });
    jsonTextarea.addEventListener('input', updateFromTextarea);
  }

  function buildColorPicker(mode) {
    var outer = document.createElement('div');

    var pickerRow = document.createElement('div');
    pickerRow.style.cssText = 'display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;';
    outer.appendChild(pickerRow);

    var pickerHost = document.createElement('div');
    pickerHost.innerHTML = window.LoxColorPicker.buildPickerHtml('#ff0000', 'l2m-test-color-hex');
    var pickerEl = pickerHost.firstElementChild;
    pickerRow.appendChild(pickerEl);
    var colorValueInput = pickerEl.querySelector('.color-picker-value');
    // Opens on LoxColorPicker's own "Vivid" palette by default here (rather than "Default") —
    // testing an RGBW light wants obviously different, easy-to-tell-apart colors to click through,
    // which is exactly what that palette is for (see color-picker.js's own comment); the other
    // palettes stay the default everywhere else, unaffected by this. renderGrid() (color-picker.js,
    // not exported) reads this select's live value fresh each time the popover opens, so setting it
    // here is enough — no need to also fire a synthetic change event.
    pickerEl.querySelector('.color-picker-palette-select').value = 'vivid';

    // Off button BEFORE the readout, not after — the readout's own text length changes with every
    // color (e.g. `sends "331,97,40"` vs `sends "0" (off)`), which used to shift the Off button
    // left/right along with it since it sat right after in the same flex row. Its position now only
    // depends on the swatch's own fixed width, never on how long the readout text next to it is.
    var offBtn = document.createElement('button');
    offBtn.type = 'button';
    offBtn.className = 'btn-soft';
    offBtn.textContent = 'Off';
    pickerRow.appendChild(offBtn);

    var readout = document.createElement('code');
    readout.className = 'hint';
    pickerRow.appendChild(readout);

    // A plain, hidden <input> is what testSendBtn.onclick actually reads (see its own
    // `valueInput.value` below) — keeps that one code path working unchanged for every value
    // picker variant (plain text, translation dropdown, color picker, or raw JSON) instead of
    // special-casing it.
    var hiddenValue = document.createElement('input');
    hiddenValue.type = 'hidden';
    outer.appendChild(hiddenValue);

    // Off/On is a genuine toggle, not a one-way "turn it off" button: clicking it while showing a
    // color remembers that color and switches to Off; clicking it again while off restores exactly
    // that same color instead of leaving you to re-pick it from scratch. Picking a NEW color while
    // off (palette grid, native picker, hex field) exits the off state on its own too, same as
    // physically turning a dimmer's knob does more than flipping its switch.
    var isOff = false;
    var lastActiveHex = colorValueInput.value;

    function applyHex(hex) {
      isOff = false;
      offBtn.textContent = 'Off';
      lastActiveHex = hex;
      var rgb = hexToRgb(hex);
      var raw = mode === 'rgb-percent'
        ? String(rgbToPackedPercent(rgb.r, rgb.g, rgb.b))
        : (function () { var hsv = rgbToLoxoneHsv(rgb.r, rgb.g, rgb.b); return hsv.h + ',' + hsv.s + ',' + hsv.v; })();
      hiddenValue.value = raw;
      readout.textContent = 'sends "' + raw + '"';
    }

    // color-picker.js dispatches this on the value input for every kind of pick (palette-grid
    // click, the native picker while dragging, or typing a hex) — one listener covers all three.
    colorValueInput.addEventListener('change', function () { applyHex(colorValueInput.value); });
    offBtn.addEventListener('click', function () {
      if (isOff) {
        applyHex(lastActiveHex);
        return;
      }
      isOff = true;
      offBtn.textContent = 'On';
      // Bare "0" (no comma) is applyShellyRgbwTransform's own dedicated all-channels-off shorthand
      // for "rgb" mode — NOT hue 0 (pure red) — see that function's own comment. rgb-percent has no
      // such shorthand; 0 there decodes as red%=0 (still valid, still off since every channel's 0).
      hiddenValue.value = '0';
      readout.textContent = 'sends "0" (off)';
    });

    attachJsonToggle(outer, pickerRow, hiddenValue, readout, function () { applyHex(colorValueInput.value); });
    applyHex(colorValueInput.value);

    return { element: outer, input: hiddenValue };
  }

  // shelly_rgbw's "white" sub-mode: Loxone sends a plain 0-100 brightness number (see
  // applyShellyRgbwTransform's own 'white' branch in loxone.js) — no color to pick, just how bright,
  // so a slider fits this shape better than the color popover the "rgb"/"rgb-percent" modes get.
  function buildWhitePicker() {
    var outer = document.createElement('div');

    var sliderRow = document.createElement('div');
    sliderRow.style.cssText = 'display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;';
    outer.appendChild(sliderRow);

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = '100';
    slider.style.width = '10rem';
    sliderRow.appendChild(slider);

    // Off button BEFORE the readout, not after — same reasoning as buildColorPicker's own Off
    // button: the readout's own text length changes with every value (e.g. `100% — sends "100"` vs
    // `0% — sends "0" (off)`), which used to shift the Off button along with it. Its position now
    // only depends on the slider's own fixed width, never on the readout text next to it.
    var offBtn = document.createElement('button');
    offBtn.type = 'button';
    offBtn.className = 'btn-soft';
    offBtn.textContent = 'Off';
    sliderRow.appendChild(offBtn);

    var readout = document.createElement('code');
    readout.className = 'hint';
    sliderRow.appendChild(readout);

    var hiddenValue = document.createElement('input');
    hiddenValue.type = 'hidden';
    outer.appendChild(hiddenValue);

    // Off/On is a genuine toggle, not a one-way "turn it off" button — same reasoning as
    // buildColorPicker's own Off button: clicking it while at some brightness remembers that level
    // and switches to Off; clicking it again while off restores exactly that same level instead of
    // leaving you to drag the slider back up from scratch. Dragging the slider itself (to any value,
    // 0 included) exits the off state on its own too.
    var isOff = false;
    var lastActivePct = Number(slider.value);

    function applyPct(pct) {
      isOff = false;
      offBtn.textContent = 'Off';
      lastActivePct = pct;
      hiddenValue.value = String(pct);
      readout.textContent = pct + '% — sends "' + pct + '"';
    }

    slider.addEventListener('input', function () { applyPct(Number(slider.value)); });
    offBtn.addEventListener('click', function () {
      if (isOff) {
        slider.value = String(lastActivePct);
        applyPct(lastActivePct);
        return;
      }
      isOff = true;
      offBtn.textContent = 'On';
      slider.value = '0';
      hiddenValue.value = '0';
      readout.textContent = '0% — sends "0" (off)';
    });

    attachJsonToggle(outer, sliderRow, hiddenValue, readout, function () { applyPct(Number(slider.value)); });
    applyPct(Number(slider.value));

    return { element: outer, input: hiddenValue };
  }

  function openTestDialog(v) {
    testTitle.textContent = 'Test — ' + v.mqttTopic;
    testResult.textContent = '';
    testResult.style.color = '';
    testValueWrap.innerHTML = '';

    var valueInput;
    if (v.valueTransform === 'shelly_rgbw' && (v.transformArg === 'rgb' || v.transformArg === 'rgb-percent')) {
      var picker = buildColorPicker(v.transformArg);
      testValueWrap.appendChild(picker.element);
      valueInput = picker.input;
    } else if (v.valueTransform === 'dimmer' || (v.valueTransform === 'shelly_rgbw' && v.transformArg === 'white')) {
      var whitePicker = buildWhitePicker();
      testValueWrap.appendChild(whitePicker.element);
      valueInput = whitePicker.input;
    } else if (v.translationValues && v.translationValues.length > 0) {
      valueInput = document.createElement('select');
      valueInput.style.maxWidth = '12rem';
      v.translationValues.forEach(function (val) {
        var opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val;
        valueInput.appendChild(opt);
      });
      testValueWrap.appendChild(valueInput);
    } else {
      var wrap = document.createElement('div');
      wrap.className = 'value-suggest-wrap';
      valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.className = 'value-suggest-input';
      valueInput.autocomplete = 'off';
      valueInput.placeholder = 'e.g. on';
      valueInput.style.maxWidth = '12rem';
      wrap.appendChild(valueInput);
      var list = document.createElement('div');
      list.className = 'value-suggest-list';
      list.hidden = true;
      ['1', '0', 'on', 'off', 'true', 'false'].forEach(function (val) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = val;
        btn.addEventListener('mousedown', function (e) {
          e.preventDefault();
          valueInput.value = val;
          list.hidden = true;
        });
        list.appendChild(btn);
      });
      wrap.appendChild(list);
      testValueWrap.appendChild(wrap);
      valueInput.addEventListener('focus', function () { list.hidden = false; });
      valueInput.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; }, 150); });
    }

    testSendBtn.onclick = function () {
      var value = (valueInput.value || '').trim();
      if (!value) {
        testResult.textContent = 'Enter a value first.';
        testResult.style.color = 'var(--danger)';
        return;
      }
      testResult.textContent = 'Sending...';
      testResult.style.color = '';
      fetch('/mappings/loxone-to-mqtt/' + v.id + '/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: value }),
      })
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
        .then(function (res) {
          if (res.ok && res.data.ok) {
            testResult.textContent = 'Published "' + res.data.sentValue + '" to ' + res.data.topic + ' (via ' + res.data.via + ')';
            testResult.style.color = 'var(--accent)';
          } else {
            testResult.textContent = res.data.error || 'Failed to send.';
            testResult.style.color = 'var(--danger)';
          }
        })
        .catch(function () {
          testResult.textContent = 'Failed to send.';
          testResult.style.color = 'var(--danger)';
        });
    };

    testDialog.showModal();
  }

  // ---- Kebab row actions ----
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
    var editLink = document.createElement('a');
    editLink.className = 'inline';
    editLink.href = '/mappings/loxone-to-mqtt/' + v.id + '/edit';
    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-edit';
    editBtn.innerHTML = ICONS.edit + ' Edit';
    editLink.appendChild(editBtn);
    actions.appendChild(editLink);

    if (v.valueTransform === 'translation_table') {
      var transLink = document.createElement('a');
      transLink.className = 'inline';
      transLink.href = '/mappings/loxone-to-mqtt/' + v.id + '/translations';
      var transBtn = document.createElement('button');
      transBtn.type = 'button';
      transBtn.className = 'btn-edit';
      transBtn.innerHTML = ICONS.list + ' Translations';
      transLink.appendChild(transBtn);
      actions.appendChild(transLink);
    }

    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn-edit';
    toggleBtn.innerHTML = ICONS.power + ' ' + (v.enabled ? 'Disable' : 'Enable');
    toggleBtn.addEventListener('click', function () {
      // Full reload, not table.replaceData() — the toolbar's own "Enable all (N)/Disable all (N)"
      // counts are server-rendered from the same underlying data and would otherwise go stale.
      fetch('/mappings/loxone-to-mqtt/' + v.id + '/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { window.location.reload(); });
    });
    actions.appendChild(toggleBtn);

    var testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'btn-test';
    testBtn.innerHTML = ICONS.power + ' Test';
    testBtn.addEventListener('click', function () { closePopover(); openTestDialog(v); });
    actions.appendChild(testBtn);

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger';
    delBtn.innerHTML = ICONS.trash + ' Delete';
    delBtn.addEventListener('click', function () {
      confirmInPopover(ctx, 'Delete this mapping?', function () {
        fetch('/mappings/loxone-to-mqtt/' + v.id + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function () { window.location.reload(); });
      });
    });
    actions.appendChild(delBtn);
  }

  initTabulatorTable({
    container: container,
    tableKey: '/mappings/loxone-to-mqtt',
    columns: [
      { title: 'Status', field: 'enabled', formatter: statusFormatter, headerSort: true, sorter: 'boolean' },
      { title: 'MQTT topic', field: 'mqttTopic', formatter: topicFormatter, headerSort: true, sorter: 'string', minWidth: 220 },
      { title: 'Miniserver', field: 'miniserverName', formatter: function (cell) { return cell.getValue() || '-'; }, headerSort: true, sorter: 'string' },
      { title: 'Transport', field: 'transport', headerSort: true, sorter: 'string' },
      { title: 'Transform', field: 'valueTransform', headerSort: true, sorter: 'string' },
      { title: 'QoS', field: 'qos', hozAlign: 'left' },
      { title: 'Retain', field: 'retain', formatter: function (cell) { return cell.getValue() ? 'yes' : 'no'; } },
      { title: 'Token', field: 'token', formatter: tokenFormatter },
      { title: 'UDP port', field: 'udpPort', formatter: function (cell) { var v = cell.getRow().getData(); return v.transport === 'udp' ? cell.getValue() : '-'; } },
      { title: 'Connection info', field: 'mqttTopic2', formatter: connectionInfoFormatter, headerSort: false },
      { title: 'Actions', field: 'actions', formatter: actionsFormatter, headerSort: false, resizable: false, width: 90 },
    ],
    ajaxURL: '/mappings/loxone-to-mqtt/data.json',
    placeholder: 'No mappings yet.',
    defaultHidden: ['token', 'udpPort'],
    noControls: ['actions', 'mqttTopic2'],
    columnsBtn: 'l2m-columns-btn',
    columnsPanel: 'l2m-columns-panel',
    searchInput: 'l2m-search',
    searchClear: 'l2m-search-clear',
    searchFields: ['mqttTopic', 'miniserverName', 'transport', 'valueTransform', 'token'],
  });
})();
