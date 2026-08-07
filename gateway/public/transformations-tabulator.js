// Transformations page — two independent, plain read-only Tabulator tables (MQTT→Loxone and
// Loxone→MQTT mappings that use a translation table), each driven by the shared
// gateway/public/tabulator-table.js. First Wave 1 conversion — no dataTree, no row-actions
// popover (each row has exactly one "Manage" link, nothing to collapse). Status/Transport/etc.
// are the underlying mapping's own fields, not shown on the original plain-<table> version of
// this page — added here as default-hidden columns (same "every DB field worth seeing, hidden
// by default" sweep already applied to Miniservers).
(function () {
  function topicFormatter(cell) {
    var value = cell.getValue();
    var code = document.createElement('code');
    code.className = 'truncate';
    code.title = value;
    code.textContent = value;
    return code;
  }

  function boolFormatter(cell) { return cell.getValue() ? 'yes' : 'no'; }

  function statusFormatter(cell) {
    var v = cell.getValue();
    var span = document.createElement('span');
    span.className = 'badge badge-live ' + (v ? 'badge-ok' : 'badge-neutral');
    span.textContent = v ? 'Active' : 'Off';
    return span;
  }

  function manageLinkFormatter(path) {
    return function (cell) {
      var v = cell.getRow().getData();
      var link = document.createElement('a');
      link.className = 'inline';
      link.href = path + v.id + '/translations';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-edit';
      btn.innerHTML = '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg> Manage';
      link.appendChild(btn);
      return link;
    };
  }

  initTabulatorTable({
    container: 'tf-m2l-tabulator',
    tableKey: '/transformations:mqtt-to-loxone',
    columns: [
      { title: 'Status', field: 'enabled', formatter: statusFormatter, headerSort: true, sorter: 'boolean' },
      { title: 'Topic', field: 'mqttTopic', formatter: topicFormatter, headerSort: true, sorter: 'string', minWidth: 200 },
      { title: 'Miniserver', field: 'miniserverName', headerSort: true, sorter: 'string' },
      { title: 'Target', field: 'target' },
      { title: 'Transport', field: 'transport', headerSort: true, sorter: 'string' },
      { title: 'Min. interval', field: 'minIntervalMs', formatter: function (cell) { return cell.getValue() ? cell.getValue() + ' ms' : '-'; }, headerSort: true, sorter: 'number' },
      { title: 'Translations', field: 'translationCount', hozAlign: 'left' },
      { title: 'Actions', field: 'actions', formatter: manageLinkFormatter('/mappings/mqtt-to-loxone/'), headerSort: false, resizable: false, width: 130 },
    ],
    ajaxURL: '/transformations/data/mqtt-to-loxone.json',
    placeholder: 'No MQTT → Loxone mappings use a translation table yet.',
    defaultHidden: ['enabled', 'transport', 'minIntervalMs'],
    noControls: ['actions'],
    columnsBtn: 'tf-m2l-columns-btn',
    columnsPanel: 'tf-m2l-columns-panel',
  });

  initTabulatorTable({
    container: 'tf-l2m-tabulator',
    tableKey: '/transformations:loxone-to-mqtt',
    columns: [
      { title: 'Status', field: 'enabled', formatter: statusFormatter, headerSort: true, sorter: 'boolean' },
      { title: 'Topic', field: 'mqttTopic', formatter: topicFormatter, headerSort: true, sorter: 'string', minWidth: 200 },
      { title: 'Miniserver', field: 'miniserverName', formatter: function (cell) { return cell.getValue() || '-'; }, headerSort: true, sorter: 'string' },
      { title: 'Token', field: 'token', formatter: function (cell) { var c = document.createElement('code'); c.textContent = cell.getValue(); return c; } },
      { title: 'Transport', field: 'transport', headerSort: true, sorter: 'string' },
      { title: 'QoS', field: 'qos', hozAlign: 'left' },
      { title: 'Retain', field: 'retain', formatter: boolFormatter },
      { title: 'Translations', field: 'translationCount', hozAlign: 'left' },
      { title: 'Actions', field: 'actions', formatter: manageLinkFormatter('/mappings/loxone-to-mqtt/'), headerSort: false, resizable: false, width: 130 },
    ],
    ajaxURL: '/transformations/data/loxone-to-mqtt.json',
    placeholder: 'No Loxone → MQTT mappings use a translation table yet.',
    defaultHidden: ['enabled', 'token', 'transport', 'qos', 'retain'],
    noControls: ['actions'],
    columnsBtn: 'tf-l2m-columns-btn',
    columnsPanel: 'tf-l2m-columns-panel',
  });
})();
