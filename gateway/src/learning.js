// What LoxSuite learns from your own data (Wallbox > Learned):
//
//   - Departures per weekday: when the car is usually unplugged in the morning (median, early
//     quartile) and the "ready by" time the planner aims for (early quartile minus 15 minutes).
//   - Energy per trip: kWh charged after a trip, grouped by weekday, part of day and time away.
//   - House profile: kWh per hour of the day for workdays and weekends.
//
// Sources: every Wallbox session is copied from the Wallbox's own session log (~100 entries) into
// charging_sessions, so the history keeps growing beyond that log. All times local to the display
// time zone. Manual overrides (per weekday) always win over what was learned.
const db = require('./db');
const settings = require('./wallboxSettings');
const { localParts, localMidnight, localTimeOn, WEEKDAYS } = require('./localTime');

const MORNING = [4 * 60 + 30, 12 * 60 + 30]; // minutes of the day that count as a "departure in the morning"

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function quantile(arr, q) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
// Weighted quantile: newer values count more (weights from recencyWeight).
function weightedQuantile(values, weights, q) {
  const pairs = values.map((v, i) => [v, weights ? weights[i] : 1]).filter(([v, w]) => Number.isFinite(v) && w > 0).sort((a, b) => a[0] - b[0]);
  if (!pairs.length) return null;
  const total = pairs.reduce((a, p) => a + p[1], 0);
  let acc = 0;
  for (const [v, w] of pairs) { acc += w; if (acc >= q * total - 1e-9) return v; }
  return pairs[pairs.length - 1][0];
}
// Half the weight every `halfLifeDays`: a new habit outweighs an old one within a few weeks.
const recencyWeight = (ms, nowMs, halfLifeDays) => Math.pow(0.5, Math.max(0, (nowMs - ms) / 86400000) / halfLifeDays);

// Pure: did the daily use change? daily [{ day (sortable), kwh }] -> the last 7 days against the 21 before.
function detectChange(daily, { minKwh = 0.5, threshold = 0.35 } = {}) {
  const d = [...daily].filter((x) => Number.isFinite(x.kwh)).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  if (d.length < 14) return { changed: false };
  const recent = d.slice(-7);
  const before = d.slice(-28, -7);
  const avg = (a) => a.reduce((s, x) => s + x.kwh, 0) / a.length;
  const r = avg(recent);
  const b = avg(before);
  if (b < minKwh && r < minKwh) return { changed: false, recent: round1(r), before: round1(b) };
  const ratio = b > 0 ? r / b : Infinity;
  return { changed: Math.abs(ratio - 1) > threshold, recent: round1(r), before: round1(b), ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null };
}

const fmtMin = (m) => (m === null || m === undefined ? null : `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`);
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
function confidence(n) { return n >= 12 ? 'high' : n >= 6 ? 'medium' : n > 0 ? 'low' : 'none'; }

// ------------------------------------------------------------------ departures

// The local date of an instant, 'YYYY-MM-DD'.
const dateKeyOf = (ms, tz) => { const p = localParts(ms, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };

// sessions: [{connect (ms), disconnect (ms|null), kwh}]
// certainty: 'safe' = ready before 9 in 10 departures, 'normal' = 3 in 4, 'relaxed' = half of them.
// overrides: per weekday your own ready time ('HH:MM') or 'none' (no usual departure that weekday).
// days: your corrections per date { 'YYYY-MM-DD': { ready: 'HH:MM' | 'none' } } — a corrected day that
// has passed and on which the car didn't leave in the morning counts as a departure at that time (15
// minutes after "ready"), so the learned pattern follows what you tell it; real departures go first.
const CERTAINTY_Q = { safe: 0.1, normal: 0.25, relaxed: 0.5 };
function departureStats(sessions, { tz, nowMs = Date.now(), overrides = {}, days = {}, certainty = 'normal', halfLifeDays = 45 } = {}) {
  const done = sessions.filter((s) => s.disconnect);
  const firstMs = sessions.length ? Math.min(...sessions.map((s) => s.connect)) : nowMs;
  // How many of each weekday the observation window holds (denominator for "usually").
  const weekdayCount = Array(7).fill(0);
  for (let t = localMidnight(firstMs, tz); t < nowMs; t = localMidnight(t, tz, 1)) weekdayCount[localParts(t + 3600000 * 12, tz).weekday]++;
  const out = WEEKDAYS.map((key, wd) => ({ key, weekday: wd, all: [], morning: [], morningW: [], morningDays: new Set(), arrivals: [], kwh: [] }));
  for (const s of done) {
    const p = localParts(s.disconnect, tz);
    const min = p.hour * 60 + p.minute;
    const d = out[p.weekday];
    d.all.push(min);
    if (min >= MORNING[0] && min <= MORNING[1]) {
      const dayKey = `${p.y}-${p.m}-${p.d}`;
      if (!d.morningDays.has(dayKey)) { d.morningDays.add(dayKey); d.morning.push(min); d.morningW.push(recencyWeight(s.disconnect, nowMs, halfLifeDays)); }
    }
  }
  for (const s of sessions) {
    const p = localParts(s.connect, tz);
    const min = p.hour * 60 + p.minute;
    if (min >= 12 * 60) out[p.weekday].arrivals.push(min);
    out[p.weekday].kwh.push(s.kwh || 0);
  }
  // your corrections of days that have passed (see above)
  const today = dateKeyOf(nowMs, tz);
  for (const [date, c] of Object.entries(days || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= today || !c || !/^\d{1,2}:\d{2}$/.test(String(c.ready || ''))) continue;
    const [y, m, dd] = date.split('-').map(Number);
    const noon = localMidnight(Date.UTC(y, m - 1, dd, 12), tz) + 12 * 3600000;
    const wd = localParts(noon, tz).weekday;
    const d = out[wd];
    const dayKey = `${y}-${m}-${dd}`;
    if (d.morningDays.has(dayKey)) continue;
    const min = toMin(c.ready) + 15;
    if (min < MORNING[0] || min > MORNING[1]) continue;
    d.morningDays.add(dayKey); d.morning.push(min); d.morningW.push(recencyWeight(noon, nowMs, halfLifeDays));
    d.corrected = (d.corrected || 0) + 1;
  }
  return out.map((d) => {
    const n = d.morning.length;
    const share = weekdayCount[d.weekday] ? n / weekdayCount[d.weekday] : 0;
    const usual = n >= 3 && share >= 0.4;
    const med = usual ? weightedQuantile(d.morning, d.morningW, 0.5) : null;
    const p25 = usual ? weightedQuantile(d.morning, d.morningW, 0.25) : null;
    const p10 = usual ? weightedQuantile(d.morning, d.morningW, 0.1) : null;
    const pick = usual ? weightedQuantile(d.morning, d.morningW, CERTAINTY_Q[certainty] ?? 0.25) : null;
    const readyMin = pick === null ? null : Math.floor((pick - 15) / 5) * 5;
    const override = overrides[d.key] || null;
    return {
      key: d.key, weekday: d.weekday, n, share: Math.round(share * 100) / 100, usual, corrected: d.corrected || 0,
      departure: fmtMin(med), early: fmtMin(p25), earliest: fmtMin(p10), certainty, ready: override === 'none' ? null : override || fmtMin(readyMin), learnedReady: fmtMin(readyMin), override,
      arrival: fmtMin(median(d.arrivals)), arrivalN: d.arrivals.length, kwh_median: round1(median(d.kwh.filter((k) => k > 0.3))),
      confidence: confidence(n), allUnplugs: d.all.sort((a, b) => a - b), morningUnplugs: d.morning.sort((a, b) => a - b),
    };
  });
}

// The next time the car should be ready, from now: the first weekday "ready" time (learned or
// overridden) that is at least `minLeadMin` ahead. Null when no weekday has one. A day you corrected
// (days, or the stats' own .days) goes first: your time, or no departure that day — also on a day off.
function nextReadyTime(stats, nowMs, { tz, horizonDays = 8, minLeadMin = 30, skip = null, days = null } = {}) {
  const fix = days || stats?.days || {};
  for (let i = 0; i < horizonDays; i++) {
    const dayMs = localMidnight(nowMs, tz, i) + 12 * 3600000;
    const c = fix[dateKeyOf(dayMs, tz)];
    if (c && c.ready === 'none') continue;
    if (c && /^\d{1,2}:\d{2}$/.test(String(c.ready || ''))) {
      const t = localTimeOn(dayMs, c.ready, tz);
      if (t - nowMs >= minLeadMin * 60000) return { at: t, weekday: WEEKDAYS[localParts(dayMs, tz).weekday], source: 'day', confidence: 'set' };
      continue;
    }
    if (skip && skip(dayMs)) continue; // away or a public holiday: no usual departure
    const wd = localParts(dayMs, tz).weekday;
    const st = stats[wd];
    if (!st?.ready) continue;
    const t = localTimeOn(dayMs, st.ready, tz);
    if (t - nowMs >= minLeadMin * 60000) return { at: t, weekday: st.key, source: st.override ? 'override' : 'learned', confidence: st.override ? 'set' : st.confidence };
  }
  return null;
}

// ------------------------------------------------------------------ energy per trip

function slotOf(min) { return min < 12 * 60 ? 'morning' : min < 17 * 60 ? 'afternoon' : 'evening'; }
function durationClass(h) { return h < 2 ? 'short' : h < 6 ? 'medium' : 'long'; }

// The kWh charged when the car comes back belongs to the trip it just made — as long as the car
// was charged before that trip (previous session charged > 0.3 kWh) and wasn't gone for days.
// With the battery size known, a trip that needed (almost) the whole battery is marked "emptied":
// a plug-in hybrid then drove on fuel, so its real need was higher.
function tripStats(sessions, { tz, usableKwh = null } = {}) {
  const s = [...sessions].filter((x) => x.disconnect).sort((a, b) => a.connect - b.connect);
  const trips = [];
  for (let i = 1; i < s.length; i++) {
    const prev = s[i - 1];
    const cur = s[i];
    const awayH = (cur.connect - prev.disconnect) / 3600000;
    if (!(awayH > 0) || awayH > 30 || (prev.kwh || 0) < 0.3) continue;
    const p = localParts(prev.disconnect, tz);
    const min = p.hour * 60 + p.minute;
    trips.push({
      depart: prev.disconnect, back: cur.connect, awayH: Math.round(awayH * 10) / 10, kwh: cur.kwh || 0,
      weekday: WEEKDAYS[p.weekday], slot: slotOf(min), duration: durationClass(awayH),
      emptied: !!(usableKwh && (cur.kwh || 0) >= 0.9 * usableKwh),
    });
  }
  const groups = new Map();
  const generic = new Map();
  for (const t of trips) {
    const k = `${t.weekday}|${t.slot}|${t.duration}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(t);
    (generic.get(t.duration) || generic.set(t.duration, []).get(t.duration)).push(t);
  }
  const summarize = (list) => {
    const vals = list.map((t) => t.kwh);
    return {
      n: list.length, median: round1(median(vals)), safe: round1(quantile(vals, 0.75)), values: vals.map(round1),
      emptied: list.filter((t) => t.emptied).length, awayH: round1(median(list.map((t) => t.awayH))), confidence: confidence(list.length * 1.5),
    };
  };
  const classes = [...groups.entries()].map(([k, list]) => {
    const [weekday, slot, duration] = k.split('|');
    return { weekday, slot, duration, ...summarize(list) };
  }).filter((c) => c.n >= 2).sort((a, b) => WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday) || ['morning', 'afternoon', 'evening'].indexOf(a.slot) - ['morning', 'afternoon', 'evening'].indexOf(b.slot));
  const fallback = Object.fromEntries(['short', 'medium', 'long'].map((d) => [d, generic.has(d) ? summarize(generic.get(d)) : { n: 0, median: null, safe: null, values: [] }]));
  return { trips, classes, fallback };
}

// Expected kWh for a trip leaving at `departMs` for about `awayH` hours (class, else fallback).
function expectedTripKwh(stats, departMs, awayH, { tz, safe = true } = {}) {
  const p = localParts(departMs, tz);
  const key = { weekday: WEEKDAYS[p.weekday], slot: slotOf(p.hour * 60 + p.minute), duration: durationClass(awayH || 8) };
  const c = stats.classes.find((x) => x.weekday === key.weekday && x.slot === key.slot && x.duration === key.duration);
  const f = stats.fallback[key.duration];
  const pick = c || (f && f.n ? f : null);
  if (!pick) return null;
  return { kwh: safe ? (pick.safe ?? pick.median) : pick.median, source: c ? 'learned trip' : 'typical trip', n: pick.n, ...key };
}

// ------------------------------------------------------------------ house profile

// hourly: [{hour (ISO), kwh}] for role 'house'. -> { workday: [24], weekend: [24], dayTotals }
function houseProfile(hourly, { tz, nowMs = Date.now(), halfLifeDays = 10 } = {}) {
  const buckets = { workday: Array.from({ length: 24 }, () => []), weekend: Array.from({ length: 24 }, () => []) };
  const weights = { workday: Array.from({ length: 24 }, () => []), weekend: Array.from({ length: 24 }, () => []) };
  const days = new Map();
  for (const r of hourly) {
    if (r.kwh === null || r.kwh === undefined) continue;
    const ms = Date.parse(r.hour);
    const p = localParts(ms, tz);
    const type = p.weekday >= 5 ? 'weekend' : 'workday';
    buckets[type][p.hour].push(r.kwh);
    weights[type][p.hour].push(recencyWeight(ms, nowMs, halfLifeDays));
    const dk = `${p.y}-${p.m}-${p.d}`;
    const d = days.get(dk) || { type, kwh: 0, hours: 0 };
    d.kwh += r.kwh; d.hours += 1;
    days.set(dk, d);
  }
  const prof = (b, w) => b.map((arr, h) => (arr.length ? Math.round(weightedQuantile(arr, w[h], 0.5) * 1000) / 1000 : null));
  const full = [...days.values()].filter((d) => d.hours >= 22);
  const wp = prof(buckets.workday, weights.workday);
  const we = prof(buckets.weekend, weights.weekend);
  const base = Math.min(...wp.concat(we).filter((x) => x !== null));
  return {
    workday: wp, weekend: we,
    perDay: round1(median(full.map((d) => d.kwh))), days: full.length,
    baseLoadKw: Number.isFinite(base) ? Math.round(base * 100) / 100 : null,
  };
}

// Expected house kWh for one future hour.
// dayType (dayType.js): a holiday is planned like a weekend day, an away day as the base load only.
function expectedHouseKwh(profile, hourMs, { tz, dayType = null } = {}) {
  const p = localParts(hourMs, tz);
  if (dayType === 'away' && profile.baseLoadKw !== null && profile.baseLoadKw !== undefined) return profile.baseLoadKw;
  const arr = p.weekday >= 5 || dayType === 'holiday' ? profile.weekend : profile.workday;
  return arr?.[p.hour] ?? null;
}

// ------------------------------------------------------------------ DB side

async function wallboxControl() {
  const m = await db.prepare("SELECT * FROM energy_meters WHERE role = 'wallbox' AND enabled = 1").get().catch(() => null);
  let ms;
  let uuid;
  if (m?.control_uuid) { ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(m.miniserver_id); uuid = m.control_uuid; }
  if (!ms) {
    const b = await db.prepare('SELECT miniserver_id, control_uuid FROM ocpp_bridges ORDER BY id LIMIT 1').get().catch(() => null);
    if (b) { ms = await db.prepare('SELECT * FROM miniservers WHERE id = ?').get(b.miniserver_id); uuid = b.control_uuid; }
  }
  if (!ms || !uuid) return null;
  let ctl;
  try { ctl = (await require('./loxoneStructure').getStructure(ms)).controls?.[uuid]; } catch { ctl = null; }
  return ctl ? { miniserver: ms, uuid, control: ctl } : null;
}

// Copy the Wallbox's own session log (and the OCPP bridge's recorded sessions) into charging_sessions.
async function syncSessions() {
  const wb = await wallboxControl();
  let added = 0;
  const upsert = async (row) => {
    const exists = await db.prepare('SELECT id, disconnect_at FROM charging_sessions WHERE connect_at = ?').get(row.connect_at);
    if (exists && exists.disconnect_at) return;
    await db.upsert('charging_sessions', row, ['connect_at']);
    if (!exists) added++;
  };
  if (wb) {
    const ws = require('./loxoneWebSocket');
    ws.ensureConnection(wb.miniserver);
    const tracker = Object.values(wb.control.subControls || {}).find((c) => c.type === 'Tracker');
    const text = tracker?.states?.entries ? ws.getLiveValue(wb.miniserver.id, tracker.states.entries) : null;
    const { parseTrackerEntries } = require('./ocppExport');
    for (const e of parseTrackerEntries(text || '')) {
      await upsert({ connect_at: new Date(e.connect * 1000).toISOString(), disconnect_at: e.disconnect ? new Date(e.disconnect * 1000).toISOString() : null, kwh: e.energy, source: 'loxone' });
    }
  }
  const recorded = await db.prepare('SELECT started_at, stopped_at, meter_start_wh, meter_stop_wh, id_tag, vehicle_id FROM ocpp_bridge_sessions WHERE stopped_at IS NOT NULL').all().catch(() => []);
  for (const r of recorded) {
    const near = await db.prepare('SELECT id FROM charging_sessions WHERE connect_at > ? AND connect_at < ?')
      .get(new Date(Date.parse(r.started_at) - 600000).toISOString(), new Date(Date.parse(r.started_at) + 600000).toISOString());
    if (near) continue;
    await upsert({ connect_at: r.started_at, disconnect_at: r.stopped_at, kwh: (r.meter_stop_wh - r.meter_start_wh) / 1000, id_tag: r.id_tag, vehicle_id: r.vehicle_id, source: 'ocpp' });
  }
  return added;
}

async function loadSessions(days = 180, vehicleId = null) {
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await db.prepare('SELECT connect_at, disconnect_at, kwh, vehicle_id FROM charging_sessions WHERE connect_at >= ? ORDER BY connect_at').all(from);
  return rows.filter((r) => !vehicleId || !r.vehicle_id || r.vehicle_id === vehicleId)
    .map((r) => ({ connect: Date.parse(r.connect_at), disconnect: r.disconnect_at ? Date.parse(r.disconnect_at) : null, kwh: r.kwh }));
}

async function getOverrides() { return settings.get('departure_overrides', {}); }
async function setOverrides(o) { return settings.set('departure_overrides', o); }

// Your corrections per date (moved, or no departure that day), kept 120 days: they count for that day
// and, once it has passed, as what really happened (departureStats).
async function getDepartureDays() { return settings.get('departure_days', {}); }
const cleanReady = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'none' || s === '-' || s === 'geen') return 'none';
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};
// date 'YYYY-MM-DD'; ready 'HH:MM' | 'none' | '' / null (back to the weekday's own or learned time)
async function setDepartureDay(date, ready, nowMs = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('Bad date.');
  const days = { ...(await getDepartureDays()) };
  const r = cleanReady(ready);
  if (r) days[date] = { ready: r, at: new Date(nowMs).toISOString() }; else delete days[date];
  const oldest = new Date(nowMs - 120 * 86400000).toISOString().slice(0, 10);
  for (const k of Object.keys(days)) if (k < oldest) delete days[k];
  await settings.set('departure_days', days);
  return days;
}
// key 'mon'…'sun'; ready 'HH:MM' | 'none' | '' / null (learned)
async function setWeekdayDeparture(key, ready) {
  if (!WEEKDAYS.includes(key)) throw new Error('Bad weekday.');
  const o = { ...(await getOverrides()) };
  const r = cleanReady(ready);
  if (r) o[key] = r; else delete o[key];
  await setOverrides(o);
  return o;
}

// Pure: what your corrections of one weekday say over the last 8 weeks — "no departure" twice or
// more, or a time twice or more within half an hour of each other: worth setting for every week.
function correctionHint(days, weekday, { tz, nowMs = Date.now() } = {}) {
  const from = dateKeyOf(nowMs - 56 * 86400000, tz);
  const mine = Object.entries(days || {}).filter(([date, c]) => {
    if (date < from || !c) return false;
    const [y, m, d] = date.split('-').map(Number);
    return localParts(localMidnight(Date.UTC(y, m - 1, d, 12), tz) + 12 * 3600000, tz).weekday === weekday;
  }).map(([, c]) => c.ready);
  const none = mine.filter((r) => r === 'none').length;
  const times = mine.filter((r) => r && r !== 'none').map(toMin).sort((a, b) => a - b);
  if (none >= 2 && none >= times.length) return { ready: 'none', n: none };
  if (times.length >= 2 && times[times.length - 1] - times[0] <= 30) return { ready: fmtMin(Math.round(median(times) / 5) * 5), n: times.length };
  return null;
}

async function learnedDepartures(vehicleId = null) {
  const { displayTz } = require('./localTime');
  const certainty = (await settings.get('planner', {}))?.depart_certainty || 'normal';
  const days = await getDepartureDays();
  const stats = departureStats(await loadSessions(180, vehicleId), { tz: displayTz(), overrides: await getOverrides(), days, certainty });
  stats.days = days; // the corrections per date go along (nextReadyTime)
  return stats;
}

async function learnedTrips(vehicle = null) {
  const { displayTz } = require('./localTime');
  const usable = vehicle?.battery_kwh ? vehicle.battery_kwh * ((vehicle.charge_limit_pct || 100) / 100) : null;
  return tripStats(await loadSessions(180, vehicle?.id || null), { tz: displayTz(), usableKwh: usable });
}

async function learnedHouse(days = 28) {
  const { displayTz } = require('./localTime');
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const away = await require('./dayType').awayDays(Date.now(), days).catch(() => new Set());
  const dayKey = (iso) => { const p = localParts(Date.parse(iso), displayTz()); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
  const rows = (await db.prepare("SELECT hour, import_kwh AS kwh FROM energy_hourly WHERE role = 'house' AND hour >= ? ORDER BY hour").all(from)).filter((r) => !away.has(dayKey(r.hour)));
  // a clear change in daily use (new appliance, other season): learn from the last week only
  const byDay = new Map();
  for (const r of rows) { const k = r.hour.slice(0, 10); byDay.set(k, (byDay.get(k) || 0) + (r.kwh || 0)); }
  const change = detectChange([...byDay.entries()].slice(0, -1).map(([day, kwh]) => ({ day, kwh })));
  const use = change.changed ? rows.filter((r) => r.hour >= new Date(Date.now() - 8 * 86400000).toISOString()) : rows;
  return { ...houseProfile(use, { tz: displayTz() }), change };
}

let timer = null;
function startLearning() {
  if (timer) return;
  const run = () => syncSessions().catch((err) => console.error(`[learning] ${err.message}`));
  timer = setInterval(run, 10 * 60 * 1000);
  timer.unref?.();
  setTimeout(run, 60000).unref?.();
}

function stopLearning() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  weightedQuantile, recencyWeight, detectChange, CERTAINTY_Q,
  median, quantile, fmtMin, toMin, departureStats, nextReadyTime, tripStats, expectedTripKwh, houseProfile, expectedHouseKwh,
  slotOf, durationClass, syncSessions, loadSessions, getOverrides, setOverrides, learnedDepartures, learnedTrips, learnedHouse,
  getDepartureDays, setDepartureDay, setWeekdayDeparture, correctionHint, cleanReady, dateKeyOf,
  startLearning, stopLearning, wallboxControl,
};
