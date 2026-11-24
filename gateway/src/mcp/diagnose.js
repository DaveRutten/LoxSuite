// Read tools of LoxSuite's MCP server: what LoxSuite knows about Miniservers, mappings, the MQTT broker,
// the Loxone commands log, logs, notifications and charts — the middle layer between the Loxone Config
// MCP (how Loxone is programmed) and the Miniserver's own MCP (its live state). `trace` walks one device
// through the whole chain and marks every hop ✓/✗ with the evidence. Each tool checks the token user's
// role for its area, the same way the pages do. Passwords, tokens of logins and keys are never returned.
const db = require('../db');
const mqttClient = require('../mqttClient');
const mosquittoLog = require('../mosquittoLog');
const loxoneWebSocket = require('../loxoneWebSocket');
const loxoneStructure = require('../loxoneStructure');
const modules = require('../modules');
const { udpTopicFor, commandRecognitionString } = require('../loxone');
const { canView } = require('./tokens');
const { version } = require('../../package.json');

const HOUR = 3600000;

class ToolError extends Error {}

function needView(user, area) {
  if (!canView(user, area)) throw new ToolError(`No permission: this token's user can't view "${area}" (Access Roles).`);
}

const clampLimit = (n, def, max) => Math.min(max, Math.max(1, Number(n) || def));
const ageS = (iso, now = Date.now()) => (iso ? Math.round((now - Date.parse(iso)) / 1000) : null);
const lower = (s) => String(s || '').toLowerCase();

// Plain words match as a case-insensitive substring; a pattern with + or # as an MQTT wildcard.
function topicFilter(search) {
  const s = String(search || '').trim();
  if (!s) return () => true;
  if (/[+#]/.test(s)) return (topic) => mqttClient.topicMatches(s, topic);
  const w = s.toLowerCase();
  return (topic) => lower(topic).includes(w);
}

const udpPort = () => Number(process.env.LOXONE_UDP_PORT) || 11885;

// What a Loxone Virtual UDP Input's Command Recognition must say for this MQTT → Loxone mapping (LoxSuite sends "MQTT:<topic>=<value>").
const recognitionFor = (m, topic) => (/[+#]/.test(topic || m.mqtt_topic) ? `MQTT:\\i<actual topic>=\\i\\v (pattern ${m.mqtt_topic})` : commandRecognitionString(udpTopicFor(m, topic || m.mqtt_topic)));

async function miniserverRows() {
  return db.prepare(`SELECT id, name, host, http_port, udp_port, use_https, status, last_checked_at, last_success_at, last_error,
    firmware_version, plc_state, gateway_client_of FROM miniservers ORDER BY sort_order, id`).all();
}

async function loxoneToMqttRows() {
  return db.prepare(`SELECT l.id, l.enabled, l.mqtt_topic, l.transport, l.qos, l.retain, l.value_transform, l.transform_arg, l.token,
    l.miniserver_id, ms.name AS miniserver_name FROM mappings_loxone_to_mqtt l LEFT JOIN miniservers ms ON ms.id = l.miniserver_id ORDER BY l.mqtt_topic`).all();
}

async function mqttToLoxoneRows() {
  return db.prepare(`SELECT m.id, m.enabled, m.mqtt_topic, m.transport, m.target, m.value_transform, m.transform_arg, m.min_interval_ms,
    m.miniserver_id, ms.name AS miniserver_name FROM mappings_mqtt_to_loxone m LEFT JOIN miniservers ms ON ms.id = m.miniserver_id ORDER BY m.mqtt_topic`).all();
}

// ---- tools -------------------------------------------------------------------------------------

async function overview(user) {
  const out = {
    loxsuite: { version, modules: modules.MODULES.filter((m) => modules.isOn(m.key)).map((m) => m.key) },
    mqtt_broker: { connected: mqttClient.state.connected, since: mqttClient.state.since, reconnects: mqttClient.state.reconnects, ...mqttClient.getStats() },
    loxone_udp_listener: { on: modules.isOn('mqtt'), port: udpPort(), message_format: '<token or topic>=<value>' },
  };
  if (canView(user, 'miniservers')) {
    out.miniservers = (await miniserverRows()).map((m) => ({ id: m.id, name: m.name, status: m.status, udp_port: m.udp_port, live: loxoneWebSocket.getStatus(m.id).status }));
  }
  if (canView(user, 'loxone_to_mqtt')) out.loxone_to_mqtt_mappings = (await loxoneToMqttRows()).length;
  if (canView(user, 'mqtt_to_loxone')) out.mqtt_to_loxone_mappings = (await mqttToLoxoneRows()).length;
  out.hint = 'Start with trace(term) for one device (part of its topic or name, e.g. "shellyplug-WERKWcd"), or the specific tools.';
  return out;
}

async function miniservers(user) {
  needView(user, 'miniservers');
  return (await miniserverRows()).map((m) => {
    const live = loxoneWebSocket.getStatus(m.id);
    return {
      ...m,
      use_https: !!m.use_https,
      live_connection: { status: live.status, error: live.error, cached_values: live.valueCount },
      problems: [
        !m.udp_port && 'no UDP port set: MQTT → Loxone mappings over UDP to this Miniserver cannot be sent',
        m.status && m.status !== 'online' && `status ${m.status}${m.last_error ? `: ${m.last_error}` : ''}`,
        live.status !== 'open' && `live connection ${live.status}${live.error ? `: ${live.error}` : ''}`,
      ].filter(Boolean),
    };
  });
}

async function mappings(user, { direction = 'both', search, enabled_only } = {}) {
  const match = topicFilter(search);
  const out = {};
  if (direction === 'both' || direction === 'loxone_to_mqtt') {
    needView(user, 'loxone_to_mqtt');
    out.loxone_to_mqtt = (await loxoneToMqttRows())
      .filter((m) => match(m.mqtt_topic) && (!enabled_only || m.enabled))
      .map((m) => ({ ...m, enabled: !!m.enabled, retain: !!m.retain, loxone_sends: m.transport === 'udp' ? `UDP "${m.token}=<v>" (or "${m.mqtt_topic}=<v>") to port ${udpPort()}` : `HTTP GET /api/loxone-in/${m.token}?value=<v>` }));
  }
  if (direction === 'both' || direction === 'mqtt_to_loxone') {
    needView(user, 'mqtt_to_loxone');
    out.mqtt_to_loxone = (await mqttToLoxoneRows())
      .filter((m) => match(m.mqtt_topic) && (!enabled_only || m.enabled))
      .map((m) => ({ ...m, enabled: !!m.enabled, ...(m.transport === 'udp' ? { loxone_command_recognition: recognitionFor(m) } : {}) }));
  }
  return out;
}

async function mqttClients(user, { search, status } = {}) {
  needView(user, 'logs_mqtt');
  const w = lower(search);
  return {
    note: 'Clients seen in the broker log since the gateway started (disconnected ones are pruned after the retention time).',
    clients: mosquittoLog.getClients()
      .filter((c) => (!w || lower(c.clientId).includes(w) || lower(c.username).includes(w) || lower(c.address).includes(w)) && (!status || c.status === status)),
  };
}

async function mqttTopics(user, { search, limit } = {}) {
  needView(user, 'incoming');
  const match = topicFilter(search);
  const now = Date.now();
  const all = mqttClient.getTopicOverview().filter((t) => match(t.topic));
  const cap = clampLimit(limit, 50, 500);
  return { total: all.length, truncated: all.length > cap, topics: all.slice(0, cap).map((t) => ({ ...t, age_s: ageS(t.lastSeen, now) })) };
}

async function mqttMessages(user, { search, limit } = {}) {
  needView(user, 'incoming');
  const match = topicFilter(search);
  const cap = clampLimit(limit, 50, 200);
  return { note: 'Newest first; only the last 200 messages are kept in memory.', messages: mqttClient.getMessageLog().filter((m) => match(m.topic)).slice(0, cap) };
}

async function loxoneCommands(user, { search, only_rejected, hours, limit } = {}) {
  needView(user, 'logs_loxone_commands');
  const since = new Date(Date.now() - (Number(hours) || 24) * HOUR).toISOString();
  const rows = await db.prepare(`SELECT recorded_at, source_label, line, command_topic, value_from, value_to, transport FROM log_entries
    WHERE source = 'loxone_commands' AND recorded_at >= ? ORDER BY id DESC LIMIT 2000`).all(since);
  const w = lower(search);
  const cap = clampLimit(limit, 50, 500);
  return {
    commands: rows
      .filter((r) => (!w || lower(r.command_topic).includes(w) || lower(r.line).includes(w) || lower(r.source_label).includes(w)) && (!only_rejected || r.line !== 'OK'))
      .slice(0, cap)
      .map((r) => ({ at: r.recorded_at, from: r.source_label, transport: r.transport, topic: r.command_topic, value: r.value_to, previous: r.value_from, result: r.line })),
  };
}

const LOG_AREAS = { system: 'logs_system', mqtt: 'logs_mqtt', loxone: 'logs_loxone' };

async function logs(user, { source = 'system', search, hours, limit } = {}) {
  const area = LOG_AREAS[source];
  if (!area) throw new ToolError('source must be system, mqtt or loxone.');
  needView(user, area);
  const since = new Date(Date.now() - (Number(hours) || 24) * HOUR).toISOString();
  const cap = clampLimit(limit, 100, 1000);
  const rows = await db.prepare('SELECT recorded_at, source_label, line FROM log_entries WHERE source = ? AND recorded_at >= ? ORDER BY id DESC LIMIT 5000').all(source, since);
  const w = lower(search);
  return { lines: rows.filter((r) => !w || lower(r.line).includes(w) || lower(r.source_label).includes(w)).slice(0, cap) };
}

const SEVERITY = ['info', 'warning', 'error', 'critical'];

async function notifications(user, { search, hours, min_severity } = {}) {
  const since = new Date(Date.now() - (Number(hours) || 72) * HOUR).toISOString();
  const minIdx = Math.max(0, SEVERITY.indexOf(min_severity));
  const rows = await db.prepare('SELECT created_at, event_type, severity, title, message, source_label FROM notification_events WHERE created_at >= ? ORDER BY id DESC LIMIT 300').all(since);
  const w = lower(search);
  return {
    notifications: rows.filter((r) => SEVERITY.indexOf(r.severity) >= minIdx && (!w || lower(r.title).includes(w) || lower(r.message).includes(w) || lower(r.source_label).includes(w))),
  };
}

async function loxoneFind(user, { query, room, miniserver_id, limit } = {}) {
  needView(user, 'live_data');
  const words = lower(query).split(/\s+/).filter(Boolean);
  const r = lower(room);
  const cap = clampLimit(limit, 30, 200);
  const list = (await miniserverRows()).filter((m) => !miniserver_id || m.id === Number(miniserver_id));
  const out = [];
  for (const ms of list) {
    const full = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(ms.id);
    let states = [];
    try { states = await loxoneStructure.getMonitorableStates(full); } catch (err) { out.push({ miniserver: ms.name, error: err.message }); continue; }
    for (const s of states) {
      const label = lower(s.label);
      if (r && !lower(s.room).includes(r) && !label.includes(r)) continue;
      if (words.length && !words.every((w) => label.includes(w))) continue;
      const v = loxoneWebSocket.getLiveValue(ms.id, s.uuid);
      out.push({ miniserver_id: ms.id, miniserver: ms.name, uuid: s.uuid, label: s.label, room: s.room, category: s.category, type: s.type, value: v === undefined ? null : v });
    }
  }
  return { total: out.length, truncated: out.length > cap, states: out.slice(0, cap) };
}

async function monitorRows() {
  return db.prepare(`SELECT monitors.id, monitors.source_type, monitors.label, monitors.mqtt_topic, monitors.miniserver_id, monitors.loxone_uuid,
    monitors.diag_field, monitors.enabled, monitors.poll_interval_ms, miniservers.name AS miniserver_name,
    (SELECT MAX(recorded_at) FROM monitor_history WHERE monitor_history.monitor_id = monitors.id) AS last_sample_at,
    (SELECT COUNT(*) FROM dashboard_panel_monitors WHERE dashboard_panel_monitors.monitor_id = monitors.id) AS panel_count
    FROM monitors LEFT JOIN miniservers ON miniservers.id = monitors.miniserver_id ORDER BY monitors.label`).all();
}

const lastSegments = (topic, n = 2) => String(topic || '').split('/').slice(-n).join('/');

// Why a chart stays empty: monitor off, no samples, topic not on the broker any more (renamed device),
// a Loxone state not in the live cache, panels without a series. Suggests live topics with the same end.
async function chartHealth(user, { search } = {}) {
  needView(user, 'monitor');
  const now = Date.now();
  const w = lower(search);
  const live = mqttClient.getTopicOverview();
  const liveSet = new Map(live.map((t) => [t.topic, t]));
  const monitors = (await monitorRows()).filter((m) => !w || lower(m.label).includes(w) || lower(m.mqtt_topic).includes(w));
  const result = monitors.map((m) => {
    const problems = [];
    const age = ageS(m.last_sample_at, now);
    if (!m.enabled) problems.push('monitor is switched off');
    if (!m.last_sample_at) problems.push('no samples recorded at all');
    else if (age > 6 * 3600) problems.push(`last sample ${Math.round(age / 3600)} h ago`);
    let suggestions;
    if (m.source_type === 'mqtt') {
      const seen = liveSet.get(m.mqtt_topic);
      if (!seen) {
        problems.push('topic not seen on the broker since the gateway started');
        const end = lastSegments(m.mqtt_topic);
        suggestions = live.filter((t) => t.topic !== m.mqtt_topic && t.topic.endsWith(end)).slice(0, 5).map((t) => t.topic);
      }
    } else if (m.source_type === 'loxone' && m.enabled && loxoneWebSocket.getLiveValue(m.miniserver_id, m.loxone_uuid) === undefined) {
      problems.push('Loxone state not in the live cache (uuid changed after a program change, or no live connection)');
    }
    return { id: m.id, label: m.label, source: m.source_type, topic: m.mqtt_topic, miniserver: m.miniserver_name, loxone_uuid: m.loxone_uuid, enabled: !!m.enabled, last_sample_at: m.last_sample_at, on_panels: Number(m.panel_count), problems, ...(suggestions && suggestions.length ? { similar_live_topics: suggestions } : {}) };
  });
  const emptyPanels = await db.prepare(`SELECT dashboard_panels.id, dashboard_panels.title, dashboard_panels.panel_type, dashboard_panels.dashboard_id FROM dashboard_panels
    WHERE dashboard_panels.panel_type <> 'group_header' AND NOT EXISTS (SELECT 1 FROM dashboard_panel_monitors WHERE dashboard_panel_monitors.panel_id = dashboard_panels.id)`).all();
  return { monitors_with_problems: result.filter((r) => r.problems.length), healthy: result.filter((r) => !r.problems.length).length, panels_without_series: emptyPanels };
}

async function dashboards(user, { dashboard_id } = {}) {
  const { listAccessibleDashboardIds } = require('../routes/dashboards');
  const ids = await listAccessibleDashboardIds(user.id, user.roleId);
  const rows = (await db.prepare('SELECT id, user_id, name FROM custom_dashboards ORDER BY position, id').all()).filter((d) => ids.has(d.id));
  if (!dashboard_id) return { dashboards: rows.map((d) => ({ id: d.id, name: d.name, shared_home: d.user_id === null, own: d.user_id === user.id })) };
  const d = rows.find((x) => x.id === Number(dashboard_id));
  if (!d) throw new ToolError('Dashboard not found (or not accessible for this user).');
  const panels = await db.prepare('SELECT id, panel_type, title, range, config FROM dashboard_panels WHERE dashboard_id = ? ORDER BY position, id').all(d.id);
  const links = await db.prepare(`SELECT dpm.panel_id, monitors.id, monitors.label, monitors.mqtt_topic, monitors.loxone_uuid FROM dashboard_panel_monitors dpm
    JOIN monitors ON monitors.id = dpm.monitor_id JOIN dashboard_panels ON dashboard_panels.id = dpm.panel_id WHERE dashboard_panels.dashboard_id = ? ORDER BY dpm.position`).all(d.id);
  return { id: d.id, name: d.name, panels: panels.map((p) => ({ id: p.id, type: p.panel_type, title: p.title, range: p.range, monitors: links.filter((l) => l.panel_id === p.id).map(({ panel_id, ...m }) => m) })) };
}

// ---- trace -------------------------------------------------------------------------------------

const isCommandTopic = (t) => /\/(command|set)(\/|$)/i.test(t);

// Pure: turns what was gathered about one device into steps. ok: true ✓, false ✗, null = unknown / not checked.
function traceFrom(d) {
  const now = d.now || Date.now();
  const steps = [];
  const step = (name, ok, detail, evidence) => steps.push({ step: name, ok, detail, ...(evidence !== undefined ? { evidence } : {}) });
  const msName = (id) => d.miniservers.find((m) => m.id === id)?.name || `Miniserver #${id}`;
  const denied = (k) => d.denied.includes(k);

  // 1. Loxone → LoxSuite
  const cmdMaps = (d.l2m || []).filter((m) => m.enabled);
  if (denied('loxone_to_mqtt')) step('Loxone → MQTT mapping', null, 'No permission to view Loxone → MQTT mappings.');
  else if (!d.l2m.length) step('Loxone → MQTT mapping', false, `No Loxone → MQTT mapping with "${d.term}" in its topic: commands from Loxone for this device don't go through this LoxSuite (another broker, or Loxone calls the device directly).`);
  else if (!cmdMaps.length) step('Loxone → MQTT mapping', false, 'Mappings exist but all are switched off.', d.l2m);
  else step('Loxone → MQTT mapping', true, `${cmdMaps.length} enabled (${[...new Set(cmdMaps.map((m) => m.transport))].join('/')}).`, cmdMaps.map((m) => ({ id: m.id, topic: m.mqtt_topic, transport: m.transport, miniserver: m.miniserver_name })));

  if (cmdMaps.some((m) => m.transport === 'udp')) {
    step('LoxSuite UDP listener', d.udp.on, d.udp.on ? `Listening on UDP ${d.udp.port}; Loxone's Virtual Output must point to this LoxSuite's IP and port ${d.udp.port}.` : 'The MQTT bridge module is off, so nothing listens for Loxone UDP commands.');
  }

  // 2. Commands arriving
  if (denied('logs_loxone_commands')) step('Commands from Loxone (24 h)', null, 'No permission to view the Loxone commands log.');
  else {
    const ok = d.commands.filter((c) => c.result === 'OK');
    const bad = d.commands.filter((c) => c.result !== 'OK');
    if (bad.length) step('Commands from Loxone (24 h)', false, `${bad.length} rejected, ${ok.length} accepted.`, bad.slice(0, 5));
    else if (ok.length) step('Commands from Loxone (24 h)', true, `${ok.length} accepted, last ${ok[0].at}.`, ok.slice(0, 3));
    else step('Commands from Loxone (24 h)', null, `None in the last 24 h: nothing was switched, or Loxone sends somewhere else — check the Virtual Output address/port in Loxone Config (LoxSuite listens on UDP ${d.udp.port}).`);
  }

  // 3. Broker
  step('MQTT broker', !!d.broker.connected, d.broker.connected ? 'LoxSuite is connected to its broker.' : 'LoxSuite is not connected to its MQTT broker.');

  // 4. Device on this broker
  if (denied('logs_mqtt')) step('Device connected to this broker', null, 'No permission to view MQTT clients.');
  else {
    const on = d.clients.filter((c) => c.status === 'connected');
    if (on.length) step('Device connected to this broker', true, `${on.map((c) => c.clientId).join(', ')} connected.`, on);
    else if (d.clients.length) step('Device connected to this broker', false, 'Seen before but disconnected now.', d.clients);
    else step('Device connected to this broker', false, `No MQTT client with "${d.term}" in its client id or user has connected to LoxSuite's broker since the gateway started: the device probably uses another broker (check its MQTT server setting).`);
  }

  // 5. State coming back
  const status = (d.topics || []).filter((t) => !isCommandTopic(t.topic));
  if (denied('incoming')) step('Device reports its state', null, 'No permission to view MQTT topics.');
  else if (!status.length) step('Device reports its state', false, `No state topic with "${d.term}" seen on this broker.`);
  else {
    const fresh = status.reduce((a, b) => (a.lastSeen > b.lastSeen ? a : b));
    const age = ageS(fresh.lastSeen, now);
    step('Device reports its state', age < 3 * 3600 ? true : null, `${status.length} topic(s), newest ${fresh.topic} ${age}s ago${fresh.retained ? ' (retained)' : ''}.`, status.slice(0, 8).map((t) => ({ topic: t.topic, value: t.value, lastSeen: t.lastSeen })));
  }

  // 6. LoxSuite → Loxone
  if (denied('mqtt_to_loxone')) step('MQTT → Loxone mapping (state back)', null, 'No permission to view MQTT → Loxone mappings.');
  else if (!d.m2l.length) step('MQTT → Loxone mapping (state back)', false, 'No MQTT → Loxone mapping: Loxone doesn\'t get this device\'s state from LoxSuite (fine if another gateway sends it, or Loxone doesn\'t need it).');
  else {
    for (const m of d.m2l) {
      const ms = d.miniservers.find((x) => x.id === m.miniserver_id);
      const issues = [
        !m.enabled && 'switched off',
        !ms && 'its Miniserver no longer exists',
        ms && m.transport === 'udp' && !ms.udp_port && `${ms.name} has no UDP port set in LoxSuite, so nothing is sent (set it to the port of the Virtual UDP Input)`,
        ms && ms.status && ms.status !== 'online' && `${ms.name} is ${ms.status}${ms.last_error ? `: ${ms.last_error}` : ''}`,
      ].filter(Boolean);
      step(`MQTT → Loxone mapping #${m.id}`, issues.length ? false : true, issues.length ? issues.join('; ') : `${m.mqtt_topic} → ${msName(m.miniserver_id)} over ${m.transport}${m.transport === 'udp' ? ` to ${ms.host}:${ms.udp_port}` : ` (Virtual Input "${m.target}")`}.`, { topic: m.mqtt_topic, transport: m.transport, target: m.target, value_transform: m.value_transform, ...(m.transport === 'udp' ? { loxone_command_recognition: recognitionFor(m) } : {}) });
    }
  }

  // 7. Charts
  if (d.monitors && d.monitors.length) {
    for (const m of d.monitors) {
      const age = ageS(m.last_sample_at, now);
      const ok = !!m.enabled && age !== null && age < 6 * 3600;
      step(`Chart monitor #${m.id}`, ok, !m.enabled ? 'switched off' : (age === null ? 'no samples' : `last sample ${age}s ago`), { label: m.label, topic: m.mqtt_topic });
    }
  }

  const failing = steps.filter((s) => s.ok === false);
  return {
    term: d.term,
    steps,
    summary: failing.length ? `${failing.length} problem(s): ${failing.map((s) => s.step).join(', ')}.` : 'No problems found in what LoxSuite can see. Check the Loxone side (Loxone Config MCP: Virtual Output/Input) and the network.',
    next: 'Compare with Loxone Config (Virtual Output address/port and command, Virtual UDP Input command recognition) and the Miniserver\'s live state.',
  };
}

async function trace(user, { term } = {}) {
  const t = String(term || '').trim();
  if (t.length < 3) throw new ToolError('Give at least 3 characters of the device\'s topic or name, e.g. "shellyplug-WERKWcd".');
  const w = t.toLowerCase();
  const has = (s) => lower(s).includes(w);
  const denied = [];
  const ifView = async (area, fn, empty) => { if (!canView(user, area)) { denied.push(area); return empty; } return fn(); };

  const topics = await ifView('incoming', () => mqttClient.getTopicOverview().filter((x) => has(x.topic)), []);
  const l2m = await ifView('loxone_to_mqtt', async () => (await loxoneToMqttRows()).filter((m) => has(m.mqtt_topic)), []);
  const m2l = await ifView('mqtt_to_loxone', async () => (await mqttToLoxoneRows()).filter((m) => has(m.mqtt_topic) || topics.some((x) => mqttClient.topicMatches(m.mqtt_topic, x.topic))), []);
  const clients = await ifView('logs_mqtt', () => mosquittoLog.getClients().filter((c) => has(c.clientId) || has(c.username)), []);
  const commands = await ifView('logs_loxone_commands', async () => {
    const since = new Date(Date.now() - 24 * HOUR).toISOString();
    const rows = await db.prepare(`SELECT recorded_at, line, command_topic, value_to, transport, source_label FROM log_entries
      WHERE source = 'loxone_commands' AND recorded_at >= ? ORDER BY id DESC LIMIT 2000`).all(since);
    return rows.filter((r) => has(r.command_topic)).map((r) => ({ at: r.recorded_at, result: r.line, topic: r.command_topic, value: r.value_to, transport: r.transport, from: r.source_label }));
  }, []);
  const monitors = await ifView('monitor', async () => (await monitorRows()).filter((m) => m.source_type === 'mqtt' && has(m.mqtt_topic)), []);
  const ms = await miniserverRows();

  return traceFrom({
    term: t, l2m, m2l, topics, clients, commands, monitors, denied,
    miniservers: ms.map((m) => ({ id: m.id, name: m.name, host: m.host, udp_port: m.udp_port, status: m.status, last_error: m.last_error })),
    broker: { connected: mqttClient.state.connected },
    udp: { on: modules.isOn('mqtt'), port: udpPort() },
  });
}

// ---- registry ----------------------------------------------------------------------------------

const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });

const READ_TOOLS = [
  { name: 'overview', description: 'Start here: LoxSuite version, modules, MQTT broker connection, the Loxone UDP listener port, Miniservers and mapping counts.', inputSchema: obj({}), run: overview },
  { name: 'trace', description: 'Diagnose one device end to end: Loxone → MQTT mapping, commands arriving from Loxone, broker, the device connected to this broker, its state topics, the MQTT → Loxone mapping back (incl. Miniserver UDP port) and its charts. Every step ✓/✗ with evidence.', inputSchema: obj({ term: str('Part of the device\'s topic, client id or name, e.g. "shellyplug-WERKWcd". At least 3 characters.') }, ['term']), run: trace },
  { name: 'miniservers', description: 'Miniservers as LoxSuite knows them: host, ports (udp_port is where MQTT → Loxone UDP goes), status, last error, firmware, live connection, and problems.', inputSchema: obj({}), run: miniservers },
  { name: 'mappings', description: 'Loxone → MQTT and MQTT → Loxone mappings (topic, transport, target, transform, enabled, Miniserver). Filter by topic text or an MQTT wildcard pattern.', inputSchema: obj({ direction: { type: 'string', enum: ['both', 'loxone_to_mqtt', 'mqtt_to_loxone'] }, search: str('Topic text or MQTT pattern (+, #).'), enabled_only: bool('Only enabled mappings.') }), run: mappings },
  { name: 'mqtt_clients', description: 'MQTT clients seen on LoxSuite\'s broker (client id, IP:port, user, connected/disconnected, since).', inputSchema: obj({ search: str('Client id, user or IP text.'), status: { type: 'string', enum: ['connected', 'disconnected'] } }), run: mqttClients },
  { name: 'mqtt_topics', description: 'Topics seen on the broker with last value, previous value, last seen, count and retained flag.', inputSchema: obj({ search: str('Topic text or MQTT pattern (+, #).'), limit: int('Max topics, default 50.') }), run: mqttTopics },
  { name: 'mqtt_messages', description: 'The most recent MQTT messages (newest first, last 200 kept).', inputSchema: obj({ search: str('Topic text or MQTT pattern.'), limit: int('Max messages, default 50.') }), run: mqttMessages },
  { name: 'loxone_commands', description: 'Commands Loxone sent to LoxSuite (Virtual Outputs over UDP/HTTP): accepted with the published value, or rejected with the reason (e.g. no matching mapping).', inputSchema: obj({ search: str('Topic, token or Miniserver text.'), only_rejected: bool('Only rejected commands.'), hours: int('Look back this many hours, default 24.'), limit: int('Max rows, default 50.') }), run: loxoneCommands },
  { name: 'logs', description: 'LoxSuite logs: system (gateway events, logins, settings changes), mqtt (broker log) or loxone (Miniserver log).', inputSchema: obj({ source: { type: 'string', enum: ['system', 'mqtt', 'loxone'] }, search: str('Text to look for.'), hours: int('Look back this many hours, default 24.'), limit: int('Max lines, default 100.') }), run: logs },
  { name: 'notifications', description: 'Recent notifications and checks (system checks, energy configuration, Miniserver, monitor alerts).', inputSchema: obj({ search: str('Text to look for.'), hours: int('Look back, default 72.'), min_severity: { type: 'string', enum: SEVERITY } }), run: notifications },
  { name: 'loxone_find', description: 'Find Loxone states (from the Miniserver structure) by words and room, with their live value. Gives miniserver_id + uuid for a Loxone monitor.', inputSchema: obj({ query: str('Words that must all occur in "Room / Control / State".'), room: str('Room name text.'), miniserver_id: int('Only this Miniserver.'), limit: int('Max states, default 30.') }), run: loxoneFind },
  { name: 'chart_health', description: 'Why charts are empty or have gaps: monitors switched off, without samples, whose topic is gone from the broker (with similar live topics), Loxone states not in the live cache, panels without a series.', inputSchema: obj({ search: str('Monitor label or topic text.') }), run: chartHealth },
  { name: 'dashboards', description: 'Dashboards this user can reach; with dashboard_id its panels and the monitors behind them.', inputSchema: obj({ dashboard_id: int('One dashboard in detail.') }), run: dashboards },
];

module.exports = { READ_TOOLS, ToolError, traceFrom, topicFilter, needView, miniserverRows, loxoneToMqttRows, mqttToLoxoneRows };
