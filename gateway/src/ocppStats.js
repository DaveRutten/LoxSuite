// Charging statistics for an OCPP bridge's Wallbox: the tiles + monthly chart on the bridge page,
// and the retained MQTT topics (loxsuite/ocpp/<id>/...) that make them usable in Monitor and on
// dashboards like any other MQTT value.
//
// Day/week/month/year come straight from the Wallbox block's own counters (totalDay, totalWeek,
// totalMonth, totalYear — Loxone resets them itself). Quarters and the per-month chart are built
// from charging sessions (ocppExport.buildQuarterRows: the bridge's own recorded sessions, else the
// Wallbox's session log), so they reach back as far as that log does (~100 sessions); months older
// than the log are flagged incomplete instead of shown as 0.
const db = require('./db');
const loxoneWebSocket = require('./loxoneWebSocket');
const loxoneStructure = require('./loxoneStructure');
const ocppExport = require('./ocppExport');
const { getDisplayTimezone } = require('./dateFormat');

const COUNTERS = { today: 'totalDay', week: 'totalWeek', month: 'totalMonth', year: 'totalYear' };
const MONTH_LABELS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const round3 = (n) => Math.round(n * 1000) / 1000;

// Local calendar parts of `date` in timeZone.
function localParts(date, timeZone) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(date).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

// Pure: everything except reading Loxone/DB. `live` holds the Wallbox counters (kWh) by state name.
function computeStats({ tracker, recorded, currentTotalKwh, live, timeZone, now = new Date(), months = 12 }) {
  const { y, m } = localParts(now, timeZone);
  const q = Math.floor((m - 1) / 3) + 1;
  const qName = `${y}Q${q}`;
  const prevName = q === 1 ? `${y - 1}Q4` : `${y}Q${q - 1}`;
  const sumRange = (start, end) => {
    const r = ocppExport.buildQuarterRows({ tracker, recorded, currentTotalKwh, start, end });
    return { kwh: round3(r.rows.reduce((s, x) => s + x.energy, 0)), sessions: r.rows.length, incomplete: r.incomplete };
  };
  const qr = ocppExport.quarterRange(qName, timeZone);
  const pr = ocppExport.quarterRange(prevName, timeZone);
  const monthly = [];
  for (let i = months - 1; i >= 0; i--) {
    let mm = m - i; let yy = y;
    while (mm <= 0) { mm += 12; yy -= 1; }
    const start = ocppExport.zonedMidnight(yy, mm, 1, timeZone);
    const end = mm === 12 ? ocppExport.zonedMidnight(yy + 1, 1, 1, timeZone) : ocppExport.zonedMidnight(yy, mm + 1, 1, timeZone);
    monthly.push({ key: `${yy}-${String(mm).padStart(2, '0')}`, label: MONTH_LABELS[mm - 1], ...sumRange(start, end) });
  }
  const counter = (k) => (Number.isFinite(Number(live?.[COUNTERS[k]])) ? round3(Number(live[COUNTERS[k]])) : null);
  return {
    today: counter('today'),
    week: counter('week'),
    month: counter('month'),
    year: counter('year'),
    meterKwh: Number.isFinite(Number(currentTotalKwh)) ? round3(Number(currentTotalKwh)) : null,
    powerKw: Number.isFinite(Number(live?.actual)) ? round3(Number(live.actual)) : null,
    quarter: { name: qName, ...sumRange(qr.start, qr.end) },
    prevQuarter: { name: prevName, ...sumRange(pr.start, pr.end) },
    months: monthly,
  };
}

// Reads the Wallbox's live counters, session log and recorded sessions, then computeStats().
// Returns { stats } or { error } (e.g. live data not in yet).
async function loadStats(bridge) {
  const miniserver = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(bridge.miniserver_id);
  if (!miniserver) return { error: 'Miniserver not found.' };
  let ctl;
  try {
    ctl = (await loxoneStructure.getStructure(miniserver)).controls?.[bridge.control_uuid];
  } catch (err) {
    return { error: `Miniserver structure unavailable: ${err.message}` };
  }
  if (!ctl) return { error: 'Wallbox not found on the Miniserver.' };
  loxoneWebSocket.ensureConnection(miniserver);
  const read = (name) => (ctl.states?.[name] ? loxoneWebSocket.getLiveValue(miniserver.id, ctl.states[name]) : undefined);
  const historyCtl = Object.values(ctl.subControls || {}).find((c) => c.type === 'Tracker');
  const trackerText = historyCtl?.states?.entries ? loxoneWebSocket.getLiveValue(miniserver.id, historyCtl.states.entries) : undefined;
  const total = read('total');
  if (total === undefined) return { error: 'Live Wallbox data not available yet.' };
  const live = { actual: read('actual') };
  for (const name of Object.values(COUNTERS)) live[name] = read(name);
  const recorded = await db.prepare('SELECT * FROM ocpp_bridge_sessions WHERE bridge_id = ?').all(bridge.id);
  const stats = computeStats({
    tracker: ocppExport.parseTrackerEntries(trackerText || ''), recorded, currentTotalKwh: Number(total), live, timeZone: getDisplayTimezone(),
  });
  const last = recorded.filter((r) => r.stopped_at && r.meter_stop_wh != null).sort((a, b) => b.id - a.id)[0];
  stats.lastSession = last ? { stoppedAt: last.stopped_at, kwh: round3((last.meter_stop_wh - last.meter_start_wh) / 1000) } : null;
  return { stats, wallboxName: ctl.name };
}

// MQTT topics (all retained, plain numbers) — stable per bridge id so Monitor entries survive a rename.
function statTopics(bridgeId) {
  const base = `loxsuite/ocpp/${bridgeId}`;
  return {
    today_kwh: `${base}/today_kwh`,
    week_kwh: `${base}/week_kwh`,
    month_kwh: `${base}/month_kwh`,
    quarter_kwh: `${base}/quarter_kwh`,
    prev_quarter_kwh: `${base}/prev_quarter_kwh`,
    year_kwh: `${base}/year_kwh`,
    last_session_kwh: `${base}/last_session_kwh`,
    power_kw: `${base}/power_kw`,
    meter_kwh: `${base}/meter_kwh`,
  };
}

function statValues(stats) {
  return {
    today_kwh: stats.today,
    week_kwh: stats.week,
    month_kwh: stats.month,
    quarter_kwh: stats.quarter?.kwh,
    prev_quarter_kwh: stats.prevQuarter?.kwh,
    year_kwh: stats.year,
    last_session_kwh: stats.lastSession?.kwh,
    power_kw: stats.powerKw,
    meter_kwh: stats.meterKwh,
  };
}

const STAT_LABELS = {
  today_kwh: 'Today (kWh)', week_kwh: 'This week (kWh)', month_kwh: 'This month (kWh)', quarter_kwh: 'This quarter (kWh)',
  prev_quarter_kwh: 'Previous quarter (kWh)', year_kwh: 'This year (kWh)', last_session_kwh: 'Last session (kWh)',
  power_kw: 'Charging power (kW)', meter_kwh: 'Meter reading (kWh)',
};

module.exports = { computeStats, loadStats, statTopics, statValues, STAT_LABELS };

// ------------------------------------------------------------------ MQTT publisher
// Every bridge (enabled or not — the stats don't depend on the OCPP side) gets its numbers
// published retained, only when a value actually changes, so Monitor history stays lean.
const PUBLISH_MS = 60 * 1000;
const lastPublished = new Map(); // topic -> string value

async function publishAllStats() {
  const mqttClient = require('./mqttClient'); // lazy: avoids a require cycle at boot
  const client = mqttClient.getClient();
  if (!client || !mqttClient.state?.connected) return;
  let bridges;
  try { bridges = await db.prepare('SELECT * FROM ocpp_bridges').all(); } catch { return; }
  for (const bridge of bridges) {
    const { stats } = await loadStats(bridge).catch(() => ({}));
    if (!stats) continue;
    const topics = statTopics(bridge.id);
    const values = statValues(stats);
    for (const [key, topic] of Object.entries(topics)) {
      const v = values[key];
      if (v === null || v === undefined || !Number.isFinite(Number(v))) continue;
      const s = String(v);
      if (lastPublished.get(topic) === s) continue;
      lastPublished.set(topic, s);
      client.publish(topic, s, { qos: 0, retain: true });
    }
  }
}

let statsTimer = null;
function startStatsPublisher() {
  if (statsTimer) return;
  statsTimer = setInterval(() => { publishAllStats().catch(() => {}); }, PUBLISH_MS);
  statsTimer.unref?.();
  setTimeout(() => { publishAllStats().catch(() => {}); }, 15000).unref?.();
}

module.exports.publishAllStats = publishAllStats;
module.exports.startStatsPublisher = startStatsPublisher;
module.exports.stopStatsPublisher = () => { if (statsTimer) clearInterval(statsTimer); statsTimer = null; };
