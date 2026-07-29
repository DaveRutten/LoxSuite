const db = require('./db');
const { fetchMiniserver } = require('./loxone');

const LOXONE_POLL_TICK_MS = 5000;
const RETENTION_TICK_MS = 60 * 60 * 1000;

// topic -> array of monitor ids, rebuilt whenever a monitor is added/removed/toggled so the
// per-MQTT-message check in recordMqttValue() stays an O(1) map lookup instead of a DB query.
let mqttTopicMonitors = new Map();
const lastPolledAt = new Map(); // monitor id -> ms epoch
const currentValues = new Map(); // monitor id -> { value, recordedAt }

function reloadMqttMonitors() {
  const rows = db.prepare("SELECT id, mqtt_topic FROM monitors WHERE source_type = 'mqtt' AND enabled = 1").all();
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.mqtt_topic) || [];
    list.push(row.id);
    map.set(row.mqtt_topic, list);
  }
  mqttTopicMonitors = map;
}

function toNumeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function insertHistory(monitorId, value) {
  const recordedAt = new Date().toISOString();
  const numericValue = toNumeric(value);
  db.prepare('INSERT INTO monitor_history (monitor_id, recorded_at, value, numeric_value) VALUES (?, ?, ?, ?)')
    .run(monitorId, recordedAt, String(value), numericValue);
  currentValues.set(monitorId, { value: String(value), recordedAt });
}

function recordMqttValue(topic, rawValue) {
  const monitorIds = mqttTopicMonitors.get(topic);
  if (!monitorIds) return;
  for (const monitorId of monitorIds) insertHistory(monitorId, rawValue);
}

async function pollLoxoneMonitor(monitor) {
  const miniserver = db.prepare('SELECT * FROM miniservers WHERE id = ?').get(monitor.miniserver_id);
  if (!miniserver) return;

  try {
    const res = await fetchMiniserver(miniserver, `/jdev/sps/io/${encodeURIComponent(monitor.loxone_uuid)}`, {
      timeoutMs: 8000,
    });
    if (!res.ok) throw new Error(`Miniserver responded with HTTP ${res.status}`);
    const body = await res.json();
    const value = body?.LL?.value;
    if (value === undefined) throw new Error('Response had no LL.value');
    insertHistory(monitor.id, value);
  } catch (err) {
    console.error(`Failed to poll Loxone monitor ${monitor.id} (${monitor.label}):`, err.message);
  }
}

function pollLoxoneMonitors() {
  const monitors = db.prepare("SELECT * FROM monitors WHERE source_type = 'loxone' AND enabled = 1").all();
  const now = Date.now();

  for (const monitor of monitors) {
    const last = lastPolledAt.get(monitor.id);
    if (last !== undefined && now - last < monitor.poll_interval_ms) continue;
    lastPolledAt.set(monitor.id, now);
    pollLoxoneMonitor(monitor);
  }
}

function purgeOldHistory() {
  const settings = db.prepare('SELECT monitor_retention_days FROM gateway_settings WHERE id = 1').get();
  const days = settings?.monitor_retention_days ?? 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM monitor_history WHERE recorded_at < ?').run(cutoff);
}

function getCurrentValue(monitorId) {
  const cached = currentValues.get(monitorId);
  if (cached) return cached;

  const row = db.prepare('SELECT value, recorded_at AS recordedAt FROM monitor_history WHERE monitor_id = ? ORDER BY recorded_at DESC LIMIT 1').get(monitorId);
  if (!row) return null;
  currentValues.set(monitorId, row);
  return row;
}

function startMonitorCollector() {
  reloadMqttMonitors();
  purgeOldHistory();
  setInterval(pollLoxoneMonitors, LOXONE_POLL_TICK_MS);
  setInterval(purgeOldHistory, RETENTION_TICK_MS);
}

module.exports = {
  startMonitorCollector,
  reloadMqttMonitors,
  recordMqttValue,
  getCurrentValue,
};
