// How consumption depends on the weather, and how fast the house (or a boiler) cools down.
//
//   - Outdoor temperature per hour comes with the solar forecast (Open-Meteo), past hours included.
//   - Heating degrees per day: max(0, 18 °C − mean outdoor temperature). A heat pump's (or the house's)
//     kWh per day is fitted as a + b × degrees; when that explains enough (r² ≥ 0.3, at least 7 days) the
//     planner scales the expected use of a day with its forecast: a cold day needs more, a mild one less.
//   - Cooling down: with a room (or tank) temperature signal, the hours in which the consumer was off
//     show how fast the temperature drops for each degree of difference with outside
//     (dT/h = k × (T − T_out)). From that: how long a heat pump may be held off before the room drops
//     half a degree, and how many degrees a boiler loses per hour.
const db = require('./db');

const HOUR = 3600000;
const DAY = 86400000;
const BASE_C = 18;
const r2 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r3 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

const heatingDegrees = (meanC) => (meanC === null || meanC === undefined ? null : Math.max(0, BASE_C - meanC));

// Pure: least squares y = a + b·x -> { a, b, r2, n }.
function fitLinear(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pts.length;
  if (n < 3) return { a: null, b: null, r2: null, n };
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0; let sxy = 0; let syy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  if (sxx === 0) return { a: my, b: 0, r2: 0, n };
  const b = sxy / sxx;
  const a = my - b * mx;
  return { a: r3(a), b: r3(b), r2: syy > 0 ? r3((sxy * sxy) / (sxx * syy)) : 0, n };
}

// Pure: daily kWh against heating degrees -> a model, usable when it explains enough.
//   days: [{ day, kwh, meanC }]
function heatModel(days, { minDays = 7, minR2 = 0.3 } = {}) {
  const pts = days.filter((d) => Number.isFinite(d.kwh) && Number.isFinite(d.meanC));
  const fit = fitLinear(pts.map((d) => heatingDegrees(d.meanC)), pts.map((d) => d.kwh));
  const usable = fit.n >= minDays && fit.r2 !== null && fit.r2 >= minR2 && fit.b > 0;
  const refDeg = pts.length ? pts.reduce((s, d) => s + heatingDegrees(d.meanC), 0) / pts.length : null;
  return { ...fit, usable, refDeg: r2(refDeg), days: pts.length };
}

// Pure: how much more (or less) a day with this mean temperature needs than the average learned day.
function dayFactor(model, meanC, { min = 0.3, max = 3 } = {}) {
  if (!model?.usable || meanC === null || meanC === undefined || model.refDeg === null) return 1;
  const at = (deg) => Math.max(0.05, model.a + model.b * deg);
  return r3(Math.min(max, Math.max(min, at(heatingDegrees(meanC)) / at(model.refDeg))));
}

// Pure: cooling down from hourly averages [{ hour, temp, onMin, outC }] (in order).
//   k per hour = (T_h − T_h+1) / (T_h − T_out) over pairs of hours both off. -> { k, n, perHourAt(deltaC) }
function coolingModel(rows, { minPairs = 6 } = {}) {
  const ks = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (Date.parse(b.hour) - Date.parse(a.hour) !== HOUR) continue;
    if (!(a.onMin <= 1 && b.onMin <= 1)) continue;
    if (![a.temp, b.temp, a.outC].every(Number.isFinite)) continue;
    const diff = a.temp - a.outC;
    if (diff < 3) continue; // too little difference to measure
    const k = (a.temp - b.temp) / diff;
    if (k > -0.01 && k < 0.5) ks.push(Math.max(0, k));
  }
  if (ks.length < minPairs) return { k: null, n: ks.length };
  ks.sort((x, y) => x - y);
  const k = ks[Math.floor(ks.length / 2)];
  return { k: r3(k) || 0.001, n: ks.length };
}

// Pure: hours a heat pump may be held off before the room drops `allowedDropC`, at this indoor and
// outdoor temperature (between 0.5 and 8 hours).
function holdHours(cool, indoorC, outdoorC, allowedDropC = 0.5) {
  if (!cool?.k || !Number.isFinite(indoorC) || !Number.isFinite(outdoorC)) return null;
  const perHour = cool.k * Math.max(1, indoorC - outdoorC);
  return r2(Math.min(8, Math.max(0.5, allowedDropC / perHour)));
}

// ------------------------------------------------------------------ data

async function hourlyTemps(fromIso, toIso) {
  const rows = await db.prepare('SELECT hour, temp_c FROM solar_forecast WHERE hour >= ? AND hour < ? AND temp_c IS NOT NULL ORDER BY hour').all(fromIso, toIso).catch(() => []);
  return new Map(rows.map((r) => [r.hour, r.temp_c]));
}

// Mean outdoor temperature per local day: Map day -> °C.
async function dailyMeans(fromMs, toMs) {
  const { localParts } = require('./localTime');
  const temps = await hourlyTemps(new Date(fromMs).toISOString(), new Date(toMs).toISOString());
  const by = new Map();
  for (const [hour, c] of temps) {
    const p = localParts(Date.parse(hour));
    const day = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    const g = by.get(day) || { s: 0, n: 0 };
    g.s += c; g.n++;
    by.set(day, g);
  }
  return new Map([...by].filter(([, g]) => g.n >= 12).map(([d, g]) => [d, Math.round((g.s / g.n) * 10) / 10]));
}

// Daily kWh from hourly rows [{ hour, kwh }] -> [{ day, kwh }] (local days, complete days only).
function dailyKwh(rows) {
  const { localParts } = require('./localTime');
  const by = new Map();
  for (const r of rows) {
    const p = localParts(Date.parse(r.hour));
    const day = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    const g = by.get(day) || { kwh: 0, n: 0 };
    g.kwh += Number(r.kwh) || 0; g.n++;
    by.set(day, g);
  }
  return [...by].filter(([, g]) => g.n >= 20).map(([day, g]) => ({ day, kwh: g.kwh }));
}

// The weather model of a consumer (its hourly kWh) or of the house.
async function modelFor(hourly, nowMs = Date.now(), days = 42) {
  const means = await dailyMeans(nowMs - days * DAY, nowMs);
  const pts = dailyKwh(hourly).map((d) => ({ ...d, meanC: means.get(d.day) ?? null }));
  return heatModel(pts);
}

async function loadModel(loadId, nowMs = Date.now()) {
  const rows = await db.prepare('SELECT hour, kwh FROM load_hourly WHERE load_id = ? AND hour >= ?').all(loadId, new Date(nowMs - 42 * DAY).toISOString()).catch(() => []);
  return modelFor(rows, nowMs);
}
async function houseModel(nowMs = Date.now()) {
  const rows = await db.prepare("SELECT hour, import_kwh AS kwh FROM energy_hourly WHERE role = 'house' AND hour >= ?").all(new Date(nowMs - 42 * DAY).toISOString()).catch(() => []);
  return modelFor(rows, nowMs);
}

// Forecast mean temperature per local day for the next days: Map day -> °C.
async function forecastMeans(nowMs = Date.now()) {
  return dailyMeans(nowMs - DAY, nowMs + 3 * DAY);
}

// A consumer's cooling down from its temperature signal and the outdoor temperature.
async function loadCooling(loadId, nowMs = Date.now()) {
  const from = new Date(nowMs - 21 * DAY).toISOString();
  const rows = await db.prepare('SELECT hour, temp_sum, temp_n, on_min FROM load_temp_hourly WHERE load_id = ? AND hour >= ? ORDER BY hour').all(loadId, from).catch(() => []);
  if (rows.length < 8) return { k: null, n: 0, hours: rows.length };
  const out = await hourlyTemps(from, new Date(nowMs).toISOString());
  const pts = rows.filter((r) => r.temp_n > 0).map((r) => ({ hour: r.hour, temp: r.temp_sum / r.temp_n, onMin: r.on_min, outC: out.get(r.hour) ?? null }));
  const last = pts[pts.length - 1];
  return { ...coolingModel(pts), hours: rows.length, lastTemp: last ? r2(last.temp) : null };
}

async function addTemp(loadId, hour, tempC, onMin) {
  if (!Number.isFinite(tempC)) return;
  const row = await db.prepare('SELECT temp_sum, temp_n, on_min FROM load_temp_hourly WHERE load_id = ? AND hour = ?').get(loadId, hour);
  await db.upsert('load_temp_hourly', {
    load_id: loadId, hour, temp_sum: Math.round(((row?.temp_sum || 0) + tempC) * 100) / 100, temp_n: (row?.temp_n || 0) + 1, on_min: Math.round(((row?.on_min || 0) + (onMin || 0)) * 100) / 100,
  }, ['load_id', 'hour']);
}

module.exports = { BASE_C, heatingDegrees, fitLinear, heatModel, dayFactor, coolingModel, holdHours, dailyKwh, hourlyTemps, dailyMeans, forecastMeans, modelFor, loadModel, houseModel, loadCooling, addTemp };
