// How good are LoxSuite's predictions? Every plan writes down what it expects — solar and house kWh per
// hour (an hour ahead and the day before), each consumer's kWh per hour, and for the car when it would
// leave and come home — and once the hour (or the event) has passed the real value goes next to it.
//
// From that LoxSuite corrects itself:
//   - house load: the planned house kWh is scaled with what the house really used against the forecast
//     over the last two weeks (between ×0.75 and ×1.33);
//   - consumers: the same per consumer;
//   - departures: when the car left before it was ready more than 1 in 10 times, the learned departure
//     time moves earlier by how early it usually was (at most an hour).
// The solar forecast already corrects itself per hour of the day (solarForecast.js); here it is measured.
const db = require('./db');

const HOUR = 3600000;
const DAY = 86400000;
const r3 = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);

// ------------------------------------------------------------------ recording

async function record(kind, target, horizon, predicted, nowMs = Date.now(), { overwrite = false, note = null } = {}) {
  if (predicted === null || predicted === undefined || !Number.isFinite(Number(predicted))) return false;
  const row = await db.prepare('SELECT id FROM forecast_log WHERE kind = ? AND target = ? AND horizon = ?').get(kind, target, horizon);
  if (row && !overwrite) return false;
  await db.upsert('forecast_log', { kind, target, horizon, predicted: r3(Number(predicted)), actual: null, made_at: new Date(nowMs).toISOString(), note }, ['kind', 'target', 'horizon']);
  return true;
}

async function setActual(kind, target, horizon, actual) {
  await db.prepare('UPDATE forecast_log SET actual = ? WHERE kind = ? AND target = ? AND horizon = ?').run(r3(actual), kind, target, horizon);
}

// Pure: which horizon a prediction for an hour starting at hourMs counts as, made at nowMs.
function horizonFor(hourMs, nowMs) {
  const dt = hourMs - nowMs;
  if (dt >= 0.5 * HOUR && dt < 1.5 * HOUR) return 'h1';
  if (dt >= 18 * HOUR && dt <= 36 * HOUR) return 'd1';
  return null;
}

// The planner's slots: solar and house kWh per hour.
async function recordSlots(slots, nowMs = Date.now()) {
  const byHour = new Map();
  for (const s of slots || []) {
    const ms = Math.floor(Date.parse(s.start) / HOUR) * HOUR;
    if (!byHour.has(ms)) byHour.set(ms, { pv: s.pvKwh, house: s.houseKwh });
  }
  for (const [ms, v] of byHour) {
    const h = horizonFor(ms, nowMs);
    if (!h) continue;
    const target = new Date(ms).toISOString();
    await record('pv', target, h, v.pv, nowMs).catch(() => {});
    await record('house', target, h, v.house, nowMs).catch(() => {});
  }
}

// A consumer's expected kWh per hour: [{ ms, kwh }].
async function recordLoad(loadId, expected, nowMs = Date.now()) {
  for (const x of expected || []) {
    const h = horizonFor(x.ms, nowMs);
    if (h && x.kwh !== null && x.kwh !== undefined) await record(`load:${loadId}`, new Date(x.ms).toISOString(), h, x.kwh, nowMs).catch(() => {});
  }
}

// The car left (or came home): what was expected next to when it happened (both epoch ms).
async function recordEvent(kind, predictedMs, actualMs, note = null) {
  if (!Number.isFinite(predictedMs) || !Number.isFinite(actualMs) || Math.abs(actualMs - predictedMs) > 8 * HOUR) return false;
  const target = new Date(Math.floor(actualMs / 60000) * 60000).toISOString();
  await db.upsert('forecast_log', { kind, target, horizon: 'event', predicted: predictedMs, actual: actualMs, made_at: new Date().toISOString(), note }, ['kind', 'target', 'horizon']);
  return true;
}

// Fill in the real values of the hours that passed (the last three days).
async function fillActuals(nowMs = Date.now()) {
  const rows = await db.prepare("SELECT kind, target, horizon FROM forecast_log WHERE actual IS NULL AND horizon <> 'event' AND target < ? AND target >= ?")
    .all(new Date(nowMs - HOUR).toISOString(), new Date(nowMs - 3 * DAY).toISOString());
  let n = 0;
  for (const r of rows) {
    let v = null;
    if (r.kind === 'pv' || r.kind === 'house') {
      v = (await db.prepare('SELECT import_kwh AS k FROM energy_hourly WHERE role = ? AND hour = ?').get(r.kind, r.target))?.k ?? null;
    } else if (r.kind.startsWith('load:')) {
      // a consumer without kWh in that hour used nothing (rows are only written when it uses something)
      const id = Number(r.kind.slice(5));
      const row = await db.prepare('SELECT kwh FROM load_hourly WHERE load_id = ? AND hour = ?').get(id, r.target);
      const seen = await db.prepare('SELECT COUNT(*) AS c FROM load_hourly WHERE load_id = ? AND hour >= ?').get(id, new Date(Date.parse(r.target) - DAY).toISOString());
      v = row ? row.kwh : (seen?.c > 0 ? 0 : null);
    }
    if (v !== null && v !== undefined) { await setActual(r.kind, r.target, r.horizon, v); n++; }
  }
  return n;
}

// ------------------------------------------------------------------ how good

// Pure: rows [{ predicted, actual, target }] of one kind+horizon -> accuracy.
//   energy kinds: n, mae (kWh), bias (mean predicted − actual), relErr (Σ|err| / Σ actual), factor (Σ actual / Σ predicted)
//   events (ms): n, maeMin, biasMin (+ = later than predicted), onTime (share at or after the predicted time)
function summarize(rows, { event = false, localHourOf = null } = {}) {
  const ok = rows.filter((r) => Number.isFinite(r.predicted) && Number.isFinite(r.actual));
  if (!ok.length) return { n: 0 };
  if (event) {
    const err = ok.map((r) => (r.actual - r.predicted) / 60000);
    return {
      n: ok.length, maeMin: Math.round(err.reduce((a, e) => a + Math.abs(e), 0) / ok.length),
      biasMin: Math.round(err.reduce((a, e) => a + e, 0) / ok.length), onTime: Math.round((err.filter((e) => e >= -1).length / ok.length) * 100) / 100,
      earlyP90Min: Math.round(quantile(err.map((e) => Math.max(0, -e)), 0.9)),
    };
  }
  const sp = ok.reduce((a, r) => a + r.predicted, 0);
  const sa = ok.reduce((a, r) => a + r.actual, 0);
  const out = {
    n: ok.length, mae: r3(ok.reduce((a, r) => a + Math.abs(r.predicted - r.actual), 0) / ok.length),
    bias: r3((sp - sa) / ok.length), relErr: sa > 0 ? r3(ok.reduce((a, r) => a + Math.abs(r.predicted - r.actual), 0) / sa) : null,
    factor: sp > 0.5 ? r3(sa / sp) : null, predicted: r3(sp), actual: r3(sa),
  };
  if (localHourOf) {
    const by = Array.from({ length: 24 }, () => ({ p: 0, a: 0, n: 0 }));
    for (const r of ok) { const b = by[localHourOf(Date.parse(r.target))]; b.p += r.predicted; b.a += r.actual; b.n++; }
    out.byHour = by.map((b) => (b.n >= 3 ? r3((b.p - b.a) / b.n) : null));
  }
  return out;
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  return a[lo] + (a[Math.ceil(pos)] - a[lo]) * (pos - lo);
}

async function rowsOf(kind, horizon, fromIso) {
  return db.prepare('SELECT target, predicted, actual FROM forecast_log WHERE kind = ? AND horizon = ? AND target >= ? AND actual IS NOT NULL ORDER BY target').all(kind, horizon, fromIso);
}

// Everything for the "How good are my predictions?" card.
async function summary(nowMs = Date.now(), days = 28) {
  const { localParts } = require('./localTime');
  const localHourOf = (ms) => localParts(ms).hour;
  const from = new Date(nowMs - days * DAY).toISOString();
  const out = {};
  for (const k of ['pv', 'house']) {
    out[k] = { h1: summarize(await rowsOf(k, 'h1', from), { localHourOf }), d1: summarize(await rowsOf(k, 'd1', from), { localHourOf }) };
  }
  const loads = await db.prepare('SELECT id, name FROM energy_loads ORDER BY priority, id').all().catch(() => []);
  out.loads = [];
  for (const l of loads) {
    const d1 = summarize(await rowsOf(`load:${l.id}`, 'd1', from));
    const h1 = summarize(await rowsOf(`load:${l.id}`, 'h1', from));
    if (d1.n || h1.n) out.loads.push({ id: l.id, name: l.name, d1, h1 });
  }
  out.depart = summarize(await rowsOf('depart', 'event', from), { event: true });
  out.arrive = summarize(await rowsOf('arrive', 'event', from), { event: true });
  out.corrections = await corrections(nowMs, { fresh: true });
  return out;
}

// ------------------------------------------------------------------ corrections

// Pure: the corrections from the accuracy figures.
function correctionsFrom({ house = null, loads = {}, depart = null } = {}) {
  const clampF = (s, minN) => (s && s.n >= minN && s.factor !== null && s.predicted > 2 ? Math.min(1.33, Math.max(0.75, s.factor)) : 1);
  const loadFactors = {};
  for (const [id, s] of Object.entries(loads)) { const f = clampF(s, 48); if (Math.abs(f - 1) > 0.02) loadFactors[id] = r3(f); }
  const houseFactor = r3(clampF(house, 48));
  let departShiftMin = 0;
  if (depart && depart.n >= 8 && depart.onTime < 0.9) departShiftMin = Math.min(60, Math.max(5, Math.round(depart.earlyP90Min / 5) * 5));
  return { houseFactor, loadFactors, departShiftMin };
}

let cache = null;
async function corrections(nowMs = Date.now(), { fresh = false } = {}) {
  if (!fresh && cache && nowMs - cache.at < 30 * 60000) return cache.value;
  const from = new Date(nowMs - 14 * DAY).toISOString();
  let value = { houseFactor: 1, loadFactors: {}, departShiftMin: 0 };
  try {
    const house = summarize([...await rowsOf('house', 'd1', from), ...await rowsOf('house', 'h1', from)]);
    const loads = {};
    for (const l of await db.prepare('SELECT id FROM energy_loads').all().catch(() => [])) loads[l.id] = summarize(await rowsOf(`load:${l.id}`, 'd1', from));
    const depart = summarize(await rowsOf('depart', 'event', new Date(nowMs - 42 * DAY).toISOString()), { event: true });
    value = correctionsFrom({ house, loads, depart });
  } catch { /* no table yet / no data */ }
  cache = { at: nowMs, value };
  return value;
}
function resetCache() { cache = null; }

// Old rows away (kept 120 days).
async function prune(nowMs = Date.now()) {
  await db.prepare('DELETE FROM forecast_log WHERE target < ?').run(new Date(nowMs - 120 * DAY).toISOString()).catch(() => {});
}

module.exports = {
  horizonFor, summarize, correctionsFrom, record, setActual, recordSlots, recordLoad, recordEvent, fillActuals, summary, corrections, resetCache, prune,
};
