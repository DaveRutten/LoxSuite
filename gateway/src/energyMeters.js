// Energy meters: which Loxone controls measure the grid connection, the PV, the Wallbox and an
// optional home battery (migration 022). Values come from the Loxone websocket LoxSuite already
// keeps open (loxoneWebSocket.getLiveValue), so nothing extra is polled on the Miniserver.
//
//   - live(): current power per role plus the derived house load (grid + pv - wallbox - battery).
//   - Every minute: one energy_samples row per role, and the meter-total differences are added to
//     energy_hourly (kWh per role per UTC hour). Role 'house' is derived per hour from the others.
//   - importHistory(): fills energy_hourly from the Miniserver's own statistics through its MCP
//     server (control_statistics, hourly differences) so learning doesn't start from zero.
//   - Health per role: 'failing' when no live value has arrived for 10 minutes (notification
//     trigger energy_meter_status), published like everything else as MQTT topics
//     loxsuite/energy/<role>/power_kw for Monitor and dashboards.
//
// Sign convention everywhere: grid + = import, pv + = production, wallbox + = charging the car,
// battery + = charging the battery. `invert` on a meter flips a meter that counts the other way.
const db = require('./db');
const loxoneWebSocket = require('./loxoneWebSocket');
const loxoneStructure = require('./loxoneStructure');

const ROLES = [
  { key: 'grid', label: 'Grid', bidirectional: true, importLabel: 'import', exportLabel: 'export' },
  { key: 'pv', label: 'Solar (PV)', bidirectional: false },
  { key: 'wallbox', label: 'Wallbox', bidirectional: false },
  { key: 'battery', label: 'Home battery', bidirectional: true, importLabel: 'charge', exportLabel: 'discharge' },
];
const ROLE_KEYS = ROLES.map((r) => r.key);
const METER_TYPES = ['Meter', 'Wallbox2', 'EFM'];

// ------------------------------------------------------------------ pure helpers

// Which meter states a control exposes (Meter: actual/total/totalNeg; Wallbox2: actual/total).
function meterStateUuids(control) {
  const s = control?.states || {};
  return { actual: s.actual || null, total: s.total || null, totalNeg: s.totalNeg || null };
}

// Statistics group (V2) that holds the meter total, and the column order of its outputs.
function totalStatGroup(control) {
  const groups = control?.statisticV2?.groups || [];
  const g = groups.find((x) => (x.dataPoints || []).some((d) => d.output === 'total'));
  return g ? { id: String(g.id), outputs: g.dataPoints.map((d) => d.output) } : null;
}

// Candidate meter controls in a structure, with a suggested role from type/name.
function meterCandidates(structure, miniserver) {
  const out = [];
  for (const [uuid, c] of Object.entries(structure?.controls || {})) {
    if (!METER_TYPES.includes(c.type)) continue;
    const st = meterStateUuids(c);
    if (!st.actual && !st.total) continue;
    const name = c.name || uuid;
    const bidirectional = c.details?.type === 'bidirectional' || !!st.totalNeg;
    let suggest = null;
    if (c.type === 'Wallbox2') suggest = 'wallbox';
    else if (/grid|net\b|netmeter|aansluiting|p1/i.test(name) && bidirectional) suggest = 'grid';
    else if (/\bpv\b|solar|zon|omvormer|inverter/i.test(name)) suggest = 'pv';
    else if (/batter|accu|storage|opslag/i.test(name)) suggest = 'battery';
    out.push({ miniserverId: miniserver?.id ?? null, miniserverName: miniserver?.name ?? '', uuid, name, type: c.type, bidirectional, suggest });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// One role's live reading from raw state values. Import/export totals are swapped by `invert`.
function readingFromValues(role, values, invert) {
  const actual = num(values.actual);
  const total = num(values.total);
  const totalNeg = num(values.totalNeg);
  const sign = invert ? -1 : 1;
  return {
    role,
    power_kw: actual === null ? null : Math.round(actual * sign * 1000) / 1000,
    import_kwh: invert ? (totalNeg ?? null) : total,
    export_kwh: invert ? total : (totalNeg ?? null),
  };
}

// House load from the role readings (kW). Null when the grid meter isn't known — without it there
// is nothing to balance against.
function housePower(byRole) {
  const g = byRole.grid?.power_kw;
  if (g === null || g === undefined) return null;
  const pv = byRole.pv?.power_kw || 0;
  const wb = byRole.wallbox?.power_kw || 0;
  const bat = byRole.battery?.power_kw || 0;
  return Math.round((g + pv - wb - bat) * 1000) / 1000;
}

// kWh consumed by the house in one hour from that hour's role rows ({role: {import_kwh, export_kwh}}).
function houseHourKwh(rows) {
  const grid = rows.grid;
  if (!grid || grid.import_kwh === null || grid.import_kwh === undefined) return null;
  const v = (grid.import_kwh || 0) - (grid.export_kwh || 0) + (rows.pv?.import_kwh || 0)
    - (rows.wallbox?.import_kwh || 0) - (rows.battery?.import_kwh || 0) + (rows.battery?.export_kwh || 0);
  return Math.max(0, Math.round(v * 1000) / 1000);
}

// Meter total difference that is safe to book: negative (meter reset / swapped meter) or
// impossibly large (more than maxKw over the elapsed time) differences are dropped.
function safeDelta(prev, cur, elapsedMs, maxKw = 100) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return 0;
  const d = cur - prev;
  if (!Number.isFinite(d) || d < 0) return 0;
  const hours = Math.max(elapsedMs, 1000) / 3600000;
  if (d > maxKw * hours + 0.01) return 0;
  return d;
}

function hourStart(ms) {
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

// control_statistics (MCP) result -> [{hour, total, totalNeg}]. Accepts the tool's raw MCP result
// ({content:[{type:'text', text: JSON}]}) or the parsed object.
function parseStatisticsResult(result) {
  let obj = result;
  if (result && Array.isArray(result.content)) {
    const text = result.content.find((c) => c.type === 'text')?.text;
    if (result.isError) throw new Error(text || 'The Miniserver returned an error.');
    try { obj = JSON.parse(text); } catch { throw new Error(`Unexpected statistics answer: ${String(text).slice(0, 120)}`); }
  }
  const cols = (obj?.header || []).map((h) => h.output);
  return (obj?.rows || []).map((r) => {
    const row = { hour: hourStart(Date.parse(r.ts)) };
    cols.forEach((c, i) => { row[c] = num(r.values?.[i]); });
    return row;
  }).filter((r) => r.hour && !r.hour.startsWith('Invalid'));
}

// ------------------------------------------------------------------ config & live state

async function loadMeters() {
  try {
    return await db.prepare('SELECT * FROM energy_meters').all();
  } catch {
    return [];
  }
}

const cache = { structures: new Map(), at: 0 }; // miniserver id -> structure
async function structureFor(miniserver) {
  const now = Date.now();
  if (now - cache.at > 10 * 60 * 1000) { cache.structures.clear(); cache.at = now; }
  if (!cache.structures.has(miniserver.id)) cache.structures.set(miniserver.id, await loadSafe(miniserver));
  return cache.structures.get(miniserver.id);
}
async function loadSafe(miniserver) {
  try { return await loxoneStructure.getStructure(miniserver); } catch { return null; }
}

async function candidateMeters() {
  const miniservers = await db.prepare('SELECT * FROM miniservers ORDER BY name').all();
  const all = [];
  for (const ms of miniservers) {
    const s = await structureFor(ms);
    if (s) all.push(...meterCandidates(s, ms));
  }
  return all;
}

// role -> { meter row, miniserver, control, states } for configured, enabled roles.
async function resolveMeters({ connect = true } = {}) {
  const meters = await loadMeters();
  const out = {};
  for (const m of meters) {
    if (!m.enabled || !m.miniserver_id || !m.control_uuid) continue;
    const ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(m.miniserver_id);
    if (!ms) continue;
    if (connect) loxoneWebSocket.ensureConnection(ms);
    const s = await structureFor(ms);
    const control = s?.controls?.[m.control_uuid] || null;
    out[m.role] = { meter: m, miniserver: ms, control, states: meterStateUuids(control) };
  }
  return out;
}

const runtime = {
  live: {},         // role -> reading + at
  lastSeen: {},     // role -> ms of the last live value
  prevTotals: {},   // role -> { import_kwh, export_kwh, at }
  health: {},       // role -> 'ok' | 'failing'
};

async function readLive() {
  const resolved = await resolveMeters();
  const byRole = {};
  for (const [role, r] of Object.entries(resolved)) {
    const values = {};
    for (const [k, uuid] of Object.entries(r.states)) {
      if (uuid) values[k] = loxoneWebSocket.getLiveValue(r.miniserver.id, uuid);
    }
    const reading = readingFromValues(role, values, !!r.meter.invert);
    reading.name = r.control?.name || r.meter.control_uuid;
    reading.miniserver = r.miniserver.name;
    reading.found = !!r.control;
    if (reading.power_kw !== null || reading.import_kwh !== null) runtime.lastSeen[role] = Date.now();
    byRole[role] = reading;
  }
  return byRole;
}

async function live() {
  const byRole = await readLive();
  return { roles: byRole, house_kw: housePower(byRole), health: { ...runtime.health }, lastSeen: { ...runtime.lastSeen } };
}

// ------------------------------------------------------------------ sampling & hourly roll-up

async function addHourly(role, hour, importKwh, exportKwh) {
  if (!importKwh && !exportKwh) return;
  const row = await db.prepare('SELECT import_kwh, export_kwh, source FROM energy_hourly WHERE role = ? AND hour = ?').get(role, hour);
  if (row && row.source === 'loxone') {
    // Imported from the Miniserver for an hour LoxSuite also measured: live data wins from here on.
    await db.prepare("UPDATE energy_hourly SET import_kwh = ?, export_kwh = ?, source = 'live' WHERE role = ? AND hour = ?")
      .run(importKwh || 0, exportKwh || 0, role, hour);
    return;
  }
  await db.upsert('energy_hourly', {
    role, hour, source: 'live',
    import_kwh: Math.round(((row?.import_kwh || 0) + (importKwh || 0)) * 10000) / 10000,
    export_kwh: Math.round(((row?.export_kwh || 0) + (exportKwh || 0)) * 10000) / 10000,
  }, ['role', 'hour']);
}

async function deriveHouse(hours) {
  for (const hour of hours) {
    const rows = await db.prepare("SELECT role, import_kwh, export_kwh FROM energy_hourly WHERE hour = ? AND role <> 'house'").all(hour);
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r]));
    const kwh = houseHourKwh(byRole);
    if (kwh === null) continue;
    await db.upsert('energy_hourly', { role: 'house', hour, import_kwh: kwh, export_kwh: 0, source: 'derived' }, ['role', 'hour']);
  }
}

const TOPIC_PREFIX = 'loxsuite/energy';
const lastPublished = new Map();
function publish(topic, value) {
  let mqttClient;
  try { mqttClient = require('./mqttClient'); } catch { return; }
  const client = mqttClient.getClient();
  if (!client || !mqttClient.state?.connected || value === null || value === undefined) return;
  const s = String(value);
  if (lastPublished.get(topic) === s) return;
  lastPublished.set(topic, s);
  client.publish(topic, s, { qos: 0, retain: true });
}

function energyTopics() {
  const t = {};
  for (const r of [...ROLE_KEYS, 'house']) {
    t[`${r}_power_kw`] = `${TOPIC_PREFIX}/${r}/power_kw`;
    t[`${r}_today_kwh`] = `${TOPIC_PREFIX}/${r}/today_kwh`;
  }
  return t;
}

async function sample(nowMs = Date.now()) {
  const byRole = await readLive();
  const ts = new Date(nowMs).toISOString();
  const hour = hourStart(nowMs);
  const touched = new Set();
  for (const [role, r] of Object.entries(byRole)) {
    if (r.power_kw === null && r.import_kwh === null) continue;
    await db.prepare('INSERT INTO energy_samples (ts, role, power_kw, import_kwh, export_kwh) VALUES (?, ?, ?, ?, ?)')
      .run(ts, role, r.power_kw, r.import_kwh, r.export_kwh);
    const prev = runtime.prevTotals[role];
    if (prev) {
      const dImp = safeDelta(prev.import_kwh, r.import_kwh, nowMs - prev.at);
      const dExp = safeDelta(prev.export_kwh, r.export_kwh, nowMs - prev.at);
      if (dImp || dExp) { await addHourly(role, hour, dImp, dExp); touched.add(hour); }
    }
    runtime.prevTotals[role] = { import_kwh: r.import_kwh, export_kwh: r.export_kwh, at: nowMs };
    publish(`${TOPIC_PREFIX}/${role}/power_kw`, r.power_kw);
  }
  if (touched.size) await deriveHouse([...touched]);
  publish(`${TOPIC_PREFIX}/house/power_kw`, housePower(byRole));
  await publishToday(nowMs).catch(() => {});
  await checkHealth(nowMs).catch(() => {});
  return byRole;
}

// Local midnight in the display time zone, so "today" matches what Loxone shows.
async function todayStartIso(nowMs) {
  const { localMidnight } = require('./localTime');
  return new Date(localMidnight(nowMs)).toISOString();
}

async function todayTotals(nowMs = Date.now()) {
  const from = await todayStartIso(nowMs);
  const rows = await db.prepare('SELECT role, SUM(import_kwh) AS imp, SUM(export_kwh) AS exp FROM energy_hourly WHERE hour >= ? GROUP BY role').all(from);
  const out = {};
  for (const r of rows) out[r.role] = { import_kwh: Math.round((r.imp || 0) * 100) / 100, export_kwh: Math.round((r.exp || 0) * 100) / 100 };
  return out;
}

async function publishToday(nowMs) {
  const t = await todayTotals(nowMs);
  for (const [role, v] of Object.entries(t)) publish(`${TOPIC_PREFIX}/${role}/today_kwh`, v.import_kwh);
}

// Hourly series for a range (for the charts): { hours: [...], series: {role: [kWh...]}, exported: {...} }
async function hourlySeries(fromIso, toIso) {
  const rows = await db.prepare('SELECT hour, role, import_kwh, export_kwh, source FROM energy_hourly WHERE hour >= ? AND hour < ? ORDER BY hour').all(fromIso, toIso);
  const hours = [];
  for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += 3600000) hours.push(new Date(t).toISOString());
  const idx = new Map(hours.map((h, i) => [h, i]));
  const series = {};
  const exported = {};
  for (const r of rows) {
    const i = idx.get(r.hour);
    if (i === undefined) continue;
    (series[r.role] ||= hours.map(() => null))[i] = r.import_kwh;
    if (r.export_kwh) (exported[r.role] ||= hours.map(() => null))[i] = r.export_kwh;
  }
  return { hours, series, exported };
}

// ------------------------------------------------------------------ health

const STALE_MS = 10 * 60 * 1000;
function roleHealth(lastSeenMs, nowMs, startedMs) {
  if (lastSeenMs && nowMs - lastSeenMs <= STALE_MS) return 'ok';
  if (!lastSeenMs && nowMs - startedMs < STALE_MS) return 'unknown';
  return 'failing';
}

let startedAt = Date.now();
async function checkHealth(nowMs) {
  const meters = (await loadMeters()).filter((m) => m.enabled && m.control_uuid);
  for (const m of meters) {
    const status = roleHealth(runtime.lastSeen[m.role], nowMs, startedAt);
    if (status === 'unknown' || runtime.health[m.role] === status) { if (status !== 'unknown') runtime.health[m.role] = status; continue; }
    const previous = runtime.health[m.role];
    runtime.health[m.role] = status;
    if (previous === undefined && status === 'ok') continue;
    try {
      const { checkEnergyMeterStatus } = require('./notifications');
      const label = (ROLES.find((r) => r.key === m.role) || {}).label || m.role;
      await checkEnergyMeterStatus(m.role, label, status, status === 'failing' ? 'no value from the Miniserver for over 10 minutes' : null);
    } catch (err) {
      console.error(`[energy] notification failed: ${err.message}`);
    }
  }
}

// ------------------------------------------------------------------ history import (MCP)

// Hourly kWh per configured role from the Miniserver's statistics, for the last `days` days.
// Hours LoxSuite already measured itself are left alone. Needs the Miniserver's MCP server to be
// authorized in LoxSuite (Miniservers > edit > AI Assistant) since the statistics come through it.
async function importHistory(days = 60, { callTool } = {}) {
  const mcp = callTool || ((ms, name, input) => require('./mcpClient').callTool(ms, name, input));
  const resolved = await resolveMeters({ connect: false });
  const to = new Date();
  to.setUTCMinutes(0, 0, 0);
  const from = new Date(to.getTime() - Math.max(1, Math.min(400, days)) * 86400000);
  const report = [];
  const hours = new Set();
  for (const [role, r] of Object.entries(resolved)) {
    const group = totalStatGroup(r.control);
    if (!group) { report.push({ role, ok: false, message: 'This control has no meter statistics.' }); continue; }
    try {
      const rows = [];
      // In chunks of 90 days, the tool returns at most 10000 rows.
      for (let start = from.getTime(); start < to.getTime(); start += 90 * 86400000) {
        const end = Math.min(to.getTime(), start + 90 * 86400000);
        const res = await mcp(r.miniserver, 'control_statistics', {
          uuid: r.meter.control_uuid, mode: 'diff', group_id: group.id, dp_unit: 'hour',
          from: new Date(start).toISOString(), to: new Date(end).toISOString(), limit: 10000,
        });
        rows.push(...parseStatisticsResult(res));
      }
      let added = 0;
      for (const row of rows) {
        let imp = row.total ?? 0;
        let exp = row.totalNeg ?? 0;
        if (r.meter.invert) [imp, exp] = [exp, imp];
        if (row.hour >= to.toISOString()) continue;
        const existing = await db.prepare('SELECT source FROM energy_hourly WHERE role = ? AND hour = ?').get(role, row.hour);
        if (existing && existing.source === 'live') continue;
        await db.upsert('energy_hourly', { role, hour: row.hour, import_kwh: imp, export_kwh: exp, source: 'loxone' }, ['role', 'hour']);
        hours.add(row.hour);
        added++;
      }
      report.push({ role, ok: true, hours: added });
    } catch (err) {
      const msg = /not authorized|unauthor|401|No MCP|mcp/i.test(err.message)
        ? `${err.message} — authorize the Loxone MCP server for "${r.miniserver.name}" first (Miniservers > edit > AI Assistant).`
        : err.message;
      report.push({ role, ok: false, message: msg });
    }
  }
  await deriveHouse([...hours]);
  return report;
}

// ------------------------------------------------------------------ lifecycle

const SAMPLE_MS = 60 * 1000;
let timer = null;
let pruneTimer = null;
function startEnergyMeters() {
  if (timer) return;
  startedAt = Date.now();
  const run = () => sample().catch((err) => console.error(`[energy] sample failed: ${err.message}`));
  timer = setInterval(run, SAMPLE_MS);
  timer.unref?.();
  setTimeout(run, 20000).unref?.();
  pruneTimer = setInterval(() => { pruneSamples().catch(() => {}); }, 6 * 3600 * 1000);
  pruneTimer.unref?.();
}

function stopEnergyMeters() {
  if (timer) clearInterval(timer);
  if (pruneTimer) clearInterval(pruneTimer);
  timer = null;
  pruneTimer = null;
}

async function pruneSamples() {
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  await db.prepare('DELETE FROM energy_samples WHERE ts < ?').run(cutoff);
}

function resetRuntime() {
  runtime.prevTotals = {};
  cache.structures.clear();
}

module.exports = {
  ROLES, ROLE_KEYS, meterStateUuids, totalStatGroup, meterCandidates, readingFromValues, housePower, houseHourKwh,
  safeDelta, hourStart, parseStatisticsResult, roleHealth,
  candidateMeters, loadMeters, live, sample, importHistory, hourlySeries, todayTotals, energyTopics,
  startEnergyMeters, stopEnergyMeters, resetRuntime, deriveHouse,
};
