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

  function openTestDialog(v) {
    testTitle.textContent = 'Test — ' + v.mqttTopic;
    testResult.textContent = '';
    testResult.style.color = '';
    testValueWrap.innerHTML = '';

    var valueInput;
    if (v.translationValues && v.translationValues.length > 0) {
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
