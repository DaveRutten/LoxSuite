const db = require('./db');
const { fetchMiniserver } = require('./loxone');
const { ensureConnection, getLiveValue, resetConnection } = require('./loxoneWebSocket');
const { checkMonitorThreshold, checkThresholdLadderNotify } = require('./notifications');
const { parseHeapStatus } = require('./format');

// Shared between the Add-monitor form, the Miniservers page's "Add to Dashboard"/"Add to Monitor"
// buttons, and this file's own findOrCreateDiagMonitor below — kept as one map so the label text
// never drifts between those. "Heap value" (not "free"/"used") for the same reason as everywhere
// else this data shows up: Loxone doesn't document which one that first number actually is.
const DIAG_FIELD_LABELS = {
  cpu_load: 'CPU load',
  heap_value_kb: 'Heap value',
  heap_total_kb: 'Heap total',
  num_tasks: 'Task count',
};

const LOXONE_POLL_TICK_MS = 5000;
const RETENTION_TICK_MS = 60 * 60 * 1000;

// Defensive, not a fix for any confirmed incident: a Miniserver's live websocket connection
// (loxoneWebSocket.js) gets its whole current-value cache from ONE initial burst right after
// connecting — verified directly against a real Miniserver, a fresh connection has every state
// within ~10s. IF that initial burst were ever incomplete for a given UUID, there'd be no other
// channel to backfill just that one value: the HTTP /jdev/sps/io/<uuid> fallback below only
// answers for ~8% of states (see loxoneWebSocket.js's own header comment), so a state outside
// that slice could get silently stuck until its own next organic push. This was the leading
// theory for a real "monitor values stopped updating" report — investigated at length, including
// live tracing — but the actual cause turned out to be unrelated: a corrupted SQLite index on
// monitor_history (idx_monitor_history_monitor_time), fixed with a one-off REINDEX; inserts were
// succeeding the whole time; only monitor_id-filtered reads were silently missing rows. Kept
// anyway as cheap, real insurance against the scenario the investigation was originally chasing —
// high-frequency states self-heal via the next organic push regardless; this only covers ones
// that wouldn't.
const LOXONE_STALE_MS = 10 * 60 * 1000; // no recorded value in 10min despite polling every 5s = stuck, not just quiet
const LOXONE_AUTO_RECONNECT_COOLDOWN_MS = 5 * 60 * 1000; // one reconnect attempt per miniserver per window, not a storm
const lastAutoReconnectAt = new Map(); // miniserver id -> ms epoch

// topic -> array of monitor ids, rebuilt whenever a monitor is added/removed/toggled so the
// per-MQTT-message check in recordMqttValue() stays an O(1) map lookup instead of a DB query.
let mqttTopicMonitors = new Map();
const lastPolledAt = new Map(); // monitor id -> ms epoch
const currentValues = new Map(); // monitor id -> { value, recordedAt }
const lastWrittenAt = new Map(); // monitor id -> ms epoch of the last actual monitor_history INSERT

// insertHistory() below only writes a new row when the value actually changed, or — for a NUMERIC
// value only — when it's been at least this long since the last row for that monitor. Without a
// floor like this, change-only storage would mean a chart/stat_delta panel's own range-bounded
// query (dashboards.js, both filter on numeric_value) comes up completely empty for a monitor
// that's been constant for longer than the panel's own range, and any plain arithmetic mean/min/max
// computed over stored rows stops being roughly time-weighted (two rows — one at 0 for 23 hours,
// one at 100 for the last 1 — average to 50, not the ~4.2 dense sampling would have given).
// Non-numeric values (Loxone/MQTT text or discrete state strings) skip the heartbeat entirely and
// go pure change-only: a chart can't plot them anyway (both queries above filter to
// Number.isFinite(numeric_value)), and state_bar — the panel type that actually visualizes this
// kind of value as a timeline — already carries the last-seen segment forward to "now" regardless
// of how old its underlying row is (see its endMs comment in dashboards.js), so a heartbeat row
// would just be wasted storage for exactly the monitors most likely to sit unchanged for a long
// time. 30 minutes was picked as a balance for the numeric case: still cheap for a monitor that
// never changes (48 rows/day instead of 8640 at a 10s poll interval), while keeping any "last hour"
// view populated with at least one point.
const HISTORY_HEARTBEAT_MS = 30 * 60 * 1000;

async function reloadMqttMonitors() {
  const rows = await db.prepare("SELECT id, mqtt_topic FROM monitors WHERE source_type = 'mqtt' AND enabled = 1").all();
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

async function insertHistory(monitorId, value) {
  const recordedAt = new Date().toISOString();
  const numericValue = toNumeric(value);
  const stringValue = String(value);
  // Captured before overwriting currentValues below — this is "what did we already know before
  // THIS poll", the thing the dedup check below needs to compare against.
  const previous = currentValues.get(monitorId);
  // Unconditional, regardless of whether this poll ends up skipping the DB write below: the
  // in-memory "current value" cache (getCurrentValue(), the stale-connection check in
  // maybeAutoReconnect) needs to reflect that this monitor was just successfully read, not just
  // that its value last changed — otherwise a monitor sitting on a genuinely constant reading would
  // look stuck/stale and trigger a needless reconnect every LOXONE_STALE_MS, even on a perfectly
  // healthy connection.
  currentValues.set(monitorId, { value: stringValue, recordedAt, numericValue });

  if (previous && previous.value === stringValue) {
    const lastWrite = lastWrittenAt.get(monitorId);
    if (numericValue === null || (lastWrite !== undefined && Date.now() - lastWrite < HISTORY_HEARTBEAT_MS)) return;
  }

  await db.prepare('INSERT INTO monitor_history (monitor_id, recorded_at, value, numeric_value) VALUES (?, ?, ?, ?)')
    .run(monitorId, recordedAt, stringValue, numericValue);
  lastWrittenAt.set(monitorId, Date.now());
  if (numericValue !== null) {
    await checkMonitorThreshold(monitorId, numericValue);
    await checkThresholdLadderNotify(monitorId, numericValue);
  }
}

async function recordMqttValue(topic, rawValue) {
  const monitorIds = mqttTopicMonitors.get(topic);
  if (!monitorIds) return;
  for (const monitorId of monitorIds) await insertHistory(monitorId, rawValue);
}

// Fed by healthcheck.js's own polling cycle, not polled independently here — see the
// 'miniserver_diag' source_type comment in db.js for why. No in-memory topic-style index like
// mqttTopicMonitors above (that one exists purely so a fast MQTT message stream doesn't hit the DB
// per message; a diagnostics update only happens once per healthcheck interval, typically 60s, so
// a plain query every time is nowhere near worth the added bookkeeping of keeping an index in sync
// as monitors are added/removed/toggled).
async function recordMiniserverDiagValue(miniserverId, field, rawValue) {
  if (rawValue === null || rawValue === undefined) return;
  const monitors = await db.prepare(
    "SELECT id FROM monitors WHERE source_type = 'miniserver_diag' AND miniserver_id = ? AND diag_field = ? AND enabled = 1"
  ).all(miniserverId, field);
  for (const monitor of monitors) await insertHistory(monitor.id, rawValue);
}

// Shared by the manual Add-monitor form (routes/monitor.js) and the Miniservers page's "Add to
// Dashboard"/"Add to Monitor" quick-add buttons (routes/dashboards.js, routes/monitor.js) — same
// find-or-create-then-seed operation either way, so it only lives once. Seeds an immediate reading
// from whatever healthcheck.js already has on hand for a brand-new monitor, same "don't show an
// empty panel/chart until the next tick" reasoning used elsewhere for freshly-created monitors.
async function findOrCreateDiagMonitor(miniserver, diagField, labelOverride) {
  const existing = await db.prepare(
    "SELECT id FROM monitors WHERE source_type = 'miniserver_diag' AND miniserver_id = ? AND diag_field = ?"
  ).get(miniserver.id, diagField);
  if (existing) return existing.id;

  const label = labelOverride || `${miniserver.name} - ${DIAG_FIELD_LABELS[diagField]}`;
  const monitorId = await db.insertReturningId(
    // config is passed explicitly ('{}') rather than left to the column's own schema default —
    // MySQL/MariaDB can't declare a DEFAULT on a TEXT column at all (see 001_baseline.js's own
    // comment on this), so every INSERT into monitors needs to supply it itself.
    "INSERT INTO monitors (source_type, label, miniserver_id, diag_field, enabled, created_at, config) VALUES ('miniserver_diag', ?, ?, ?, 1, ?, '{}')",
    [label, miniserver.id, diagField, new Date().toISOString()]
  );

  if (diagField === 'cpu_load' && miniserver.cpu_load !== null) {
    await recordMiniserverDiagValue(miniserver.id, 'cpu_load', parseFloat(miniserver.cpu_load));
  } else if (diagField === 'num_tasks' && miniserver.num_tasks !== null) {
    await recordMiniserverDiagValue(miniserver.id, 'num_tasks', miniserver.num_tasks);
  } else if (diagField === 'heap_value_kb' || diagField === 'heap_total_kb') {
    const heap = parseHeapStatus(miniserver.heap_status);
    if (heap) await recordMiniserverDiagValue(miniserver.id, diagField, diagField === 'heap_value_kb' ? heap.firstKb : heap.totalKb);
  }
  return monitorId;
}

async function pollLoxoneMonitor(monitor) {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(monitor.miniserver_id);
  if (!miniserver) return;

  // The live websocket cache (loxoneWebSocket.js) is checked first and is right almost all of the
  // time — it's not just faster than an HTTP round trip, it's the ONLY way most states are
  // readable at all: /jdev/sps/io/<uuid> only answers for a small slice of a control's states
  // (measured ~8% on a real installation), so a monitor tracking anything else — active,
  // numOpen, tempActual, activeMoodsNum, position, ... — would otherwise get exactly one reading
  // (whatever was seeded when it was created) and then silently never update again.
  ensureConnection(miniserver);
  const liveValue = getLiveValue(miniserver.id, monitor.loxone_uuid);
  if (liveValue !== undefined) {
    if (liveValue !== null) await insertHistory(monitor.id, liveValue);
    return;
  }

  try {
    const res = await fetchMiniserver(miniserver, `/jdev/sps/io/${encodeURIComponent(monitor.loxone_uuid)}`, {
      timeoutMs: 8000,
    });
    if (!res.ok) throw new Error(`Miniserver responded with HTTP ${res.status}`);
    const body = await res.json();
    const value = body?.LL?.value;
    if (value === undefined) throw new Error('Response had no LL.value');
    await insertHistory(monitor.id, value);
  } catch (err) {
    console.error(`Failed to poll Loxone monitor ${monitor.id} (${monitor.label}):`, err.message);
    await maybeAutoReconnect(miniserver, monitor);
  }
}

// See the LOXONE_STALE_MS comment above for the incident this is for. Only reachable once neither
// the live cache nor the HTTP fallback produced a value this tick — cheap to check every time that
// happens (a single Map read plus, at most once per monitor, getCurrentValue's own history query),
// since a monitor with a genuinely healthy connection never reaches here at all.
async function maybeAutoReconnect(miniserver, monitor) {
  const current = await getCurrentValue(monitor.id);
  // A monitor that's never recorded anything yet (current === null) uses its own creation time as
  // the reference instead of "always stale" — a brand new monitor's connection may just still be
  // in the middle of its normal handshake, not actually stuck.
  const referenceIso = current ? current.recordedAt : monitor.created_at;
  const referenceMs = referenceIso ? new Date(referenceIso).getTime() : 0;
  if (Date.now() - referenceMs < LOXONE_STALE_MS) return;

  const lastReconnect = lastAutoReconnectAt.get(miniserver.id) || 0;
  if (Date.now() - lastReconnect < LOXONE_AUTO_RECONNECT_COOLDOWN_MS) return;
  lastAutoReconnectAt.set(miniserver.id, Date.now());

  console.warn(
    `Loxone monitor ${monitor.id} (${monitor.label}) on miniserver ${miniserver.id} hasn't recorded a ` +
    `value in over ${Math.round(LOXONE_STALE_MS / 60000)} minutes — forcing a live connection reconnect to refresh its value cache.`
  );
  resetConnection(miniserver.id);
}

async function pollLoxoneMonitors() {
  const monitors = await db.prepare("SELECT * FROM monitors WHERE source_type = 'loxone' AND enabled = 1").all();
  const now = Date.now();

  for (const monitor of monitors) {
    const last = lastPolledAt.get(monitor.id);
    if (last !== undefined && now - last < monitor.poll_interval_ms) continue;
    lastPolledAt.set(monitor.id, now);
    // Not awaited on purpose — each monitor's own HTTP round trip (or live-cache read) should not
    // block the others; this tick just needs to have kicked every due monitor off before the next
    // setInterval fire, same "fire and forget per item" shape as before this conversion.
    pollLoxoneMonitor(monitor).catch((err) => console.error(`pollLoxoneMonitor(${monitor.id}) failed:`, err.message));
  }
}

async function purgeOldHistory() {
  const settings = await db.prepare('SELECT monitor_retention_days FROM gateway_settings WHERE id = 1').get();
  const days = settings?.monitor_retention_days ?? 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare('DELETE FROM monitor_history WHERE recorded_at < ?').run(cutoff);
}

async function getCurrentValue(monitorId) {
  const cached = currentValues.get(monitorId);
  if (cached) return cached;

  const row = await db.prepare('SELECT value, recorded_at AS recordedAt, numeric_value AS numericValue FROM monitor_history WHERE monitor_id = ? ORDER BY recorded_at DESC LIMIT 1').get(monitorId);
  if (!row) return null;
  currentValues.set(monitorId, row);
  return row;
}

// Called after wiping a monitor's history from the DB directly (routes/monitor.js's clear-history)
// — otherwise this in-memory "last known value" would keep showing the old reading until the next
// poll/message happens to come in and overwrite it, which for an MQTT topic could be a long wait.
function clearCurrentValue(monitorId) {
  currentValues.delete(monitorId);
  // Not strictly required — insertHistory()'s dedup check above only reads this once `previous`
  // (currentValues) is also truthy again, and that was just deleted too — but leaving a stale
  // timestamp behind for a monitor id that a NEW monitor could later reuse is the kind of thing
  // that's cheap to avoid now and confusing to debug later.
  lastWrittenAt.delete(monitorId);
}

async function startMonitorCollector() {
  await reloadMqttMonitors();
  await purgeOldHistory();
  setInterval(pollLoxoneMonitors, LOXONE_POLL_TICK_MS);
  setInterval(purgeOldHistory, RETENTION_TICK_MS);
}

module.exports = {
  startMonitorCollector,
  reloadMqttMonitors,
  recordMqttValue,
  recordMiniserverDiagValue,
  findOrCreateDiagMonitor,
  DIAG_FIELD_LABELS,
  getCurrentValue,
  clearCurrentValue,
};
