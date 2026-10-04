// Solar forecast for the charging planner. Raw forecast = Open-Meteo's irradiance on the panel plane
// (global_tilted_irradiance for the array's tilt and azimuth) x installed kWp x system efficiency.
// That raw number is then corrected per hour of the day with what the PV meter actually produced
// over the last 28 days versus the day-ahead forecast for the same hours — shading, orientation,
// dirt and inverter limits end up in that factor without anyone having to model them.
const db = require('./db');
const settings = require('./wallboxSettings');

const DEFAULTS = { enabled: true, kwp: null, tilt: 35, azimuth: 0, efficiency: 0.85, learn_days: 28 };

function round3(x) { return Math.round(x * 1000) / 1000; }

// Open-Meteo hourly radiation is the mean over the PRECEDING hour: the value at 10:00 belongs to
// 09:00-10:00. Returns [{hour (start, ISO), raw_kwh}].
function parseOpenMeteo(body, cfg) {
  const times = body?.hourly?.time || [];
  const gti = body?.hourly?.global_tilted_irradiance || body?.hourly?.shortwave_radiation || [];
  const kwp = Number(cfg.kwp) || 0;
  const eff = Number(cfg.efficiency) || 0.85;
  const out = [];
  times.forEach((t, i) => {
    const end = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(t) ? t : `${t}Z`);
    const w = Number(gti[i]);
    if (!Number.isFinite(end) || !Number.isFinite(w)) return;
    out.push({ hour: new Date(end - 3600000).toISOString(), raw_kwh: round3(Math.max(0, w) / 1000 * kwp * eff) });
  });
  return out;
}

// Per hour-of-day correction factors from pairs [{localHour, forecast, actual}].
function correctionFactors(pairs, { min = 0.2, max = 2.0 } = {}) {
  const f = Array.from({ length: 24 }, () => ({ fc: 0, ac: 0, n: 0 }));
  let tf = 0;
  let ta = 0;
  for (const p of pairs) {
    if (!(p.forecast > 0.05) || !Number.isFinite(p.actual)) continue;
    const b = f[p.localHour];
    b.fc += p.forecast; b.ac += p.actual; b.n += 1;
    tf += p.forecast; ta += p.actual;
  }
  const overall = tf > 0.5 ? Math.min(max, Math.max(min, ta / tf)) : 1;
  return {
    overall: round3(overall),
    byHour: f.map((b) => (b.n >= 5 && b.fc > 0.3 ? round3(Math.min(max, Math.max(min, b.ac / b.fc))) : null)),
    samples: pairs.length,
  };
}

function factorFor(factors, localHour) {
  return factors?.byHour?.[localHour] ?? factors?.overall ?? 1;
}

// Error band of daily totals: relative errors -> p10/p90 multipliers and mean absolute error.
function dailyErrorBand(days) {
  const rel = days.filter((d) => d.forecast > 1).map((d) => d.actual / d.forecast).sort((a, b) => a - b);
  if (rel.length < 5) return { low: 0.6, high: 1.25, mape: null, n: rel.length };
  const q = (p) => rel[Math.min(rel.length - 1, Math.max(0, Math.round(p * (rel.length - 1))))];
  const mape = days.filter((d) => d.forecast > 1).reduce((s, d) => s + Math.abs(d.actual - d.forecast) / d.forecast, 0) / rel.length;
  return { low: round3(q(0.1)), high: round3(q(0.9)), mape: round3(mape), n: rel.length };
}

// ------------------------------------------------------------------ config

async function getConfig() { return settings.get('solar', DEFAULTS); }
async function getSite() { return settings.get('site', { lat: null, lon: null }); }

// ------------------------------------------------------------------ fetching & storing

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'LoxSuite' } });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('No answer within 15 s.');
    if (err.message === 'fetch failed') throw new Error(`Cannot reach ${new URL(url).host} (${err.cause?.code || 'network error'}).`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function openMeteoUrl(site, cfg) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${site.lat}&longitude=${site.lon}&hourly=global_tilted_irradiance`
    + `&tilt=${Number(cfg.tilt) || 0}&azimuth=${Number(cfg.azimuth) || 0}&timezone=GMT&forecast_days=3&past_days=1`;
}

async function refreshForecast(nowMs = Date.now(), { fetchImpl = fetchJson } = {}) {
  const cfg = await getConfig();
  const site = await getSite();
  if (!cfg.enabled) return { skipped: 'disabled' };
  if (!Number.isFinite(Number(site.lat)) || !Number.isFinite(Number(site.lon)) || site.lat === null) throw new Error('Set the home location (Wallbox > Planner > Settings) first.');
  if (!(Number(cfg.kwp) > 0)) throw new Error('Set the installed solar power (kWp) first.');
  const rows = parseOpenMeteo(await fetchImpl(openMeteoUrl(site, cfg)), cfg);
  const factors = await learnFactors(nowMs);
  const { localParts } = require('./localTime');
  const now = new Date(nowMs).toISOString();
  for (const r of rows) {
    const existing = await db.prepare('SELECT dayahead_raw_kwh FROM solar_forecast WHERE hour = ?').get(r.hour);
    const isDayAhead = Date.parse(r.hour) - nowMs >= 12 * 3600000;
    const corrected = round3(r.raw_kwh * factorFor(factors, localParts(Date.parse(r.hour)).hour));
    if (Date.parse(r.hour) < nowMs - 3600000 && existing) continue; // past hours: keep what was forecast then
    await db.upsert('solar_forecast', {
      hour: r.hour, raw_kwh: r.raw_kwh, corrected_kwh: corrected, made_at: now,
      dayahead_raw_kwh: existing?.dayahead_raw_kwh ?? (isDayAhead ? r.raw_kwh : null),
    }, ['hour']);
  }
  await settings.set('solar_status', { ok: true, at: now, hours: rows.length, factors });
  return { hours: rows.length, factors };
}

// Pairs of day-ahead forecast vs measured PV over the learning window -> factors (+ daily totals).
async function learningPairs(nowMs = Date.now(), days = 28) {
  const from = new Date(nowMs - days * 86400000).toISOString();
  const to = new Date(nowMs - 3600000).toISOString();
  const rows = await db.prepare(
    `SELECT f.hour AS hour, COALESCE(f.dayahead_raw_kwh, f.raw_kwh) AS fc, e.import_kwh AS ac
       FROM solar_forecast f JOIN energy_hourly e ON e.hour = f.hour AND e.role = 'pv'
      WHERE f.hour >= ? AND f.hour < ?`
  ).all(from, to);
  const { localParts } = require('./localTime');
  return rows.map((r) => ({ hour: r.hour, localHour: localParts(Date.parse(r.hour)).hour, forecast: r.fc, actual: r.ac }));
}

async function learnFactors(nowMs = Date.now()) {
  const cfg = await getConfig();
  return correctionFactors(await learningPairs(nowMs, cfg.learn_days || 28));
}

// Daily totals of the last N days: corrected-at-the-time forecast vs actual, for the history chart.
async function dailyHistory(nowMs = Date.now(), days = 28) {
  const pairs = await learningPairs(nowMs, days);
  const factors = await learnFactors(nowMs);
  const { localMidnight } = require('./localTime');
  const byDay = new Map();
  for (const p of pairs) {
    const day = new Date(localMidnight(Date.parse(p.hour))).toISOString();
    const d = byDay.get(day) || { day, forecast: 0, actual: 0 };
    d.forecast += p.forecast * factorFor(factors, p.localHour);
    d.actual += p.actual;
    byDay.set(day, d);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, forecast: round3(d.forecast), actual: round3(d.actual) }));
}

// Forecast for a local day: hourly kWh (corrected), total, error band.
async function forecastForDay(dayMs = Date.now()) {
  const { localMidnight } = require('./localTime');
  const from = new Date(localMidnight(dayMs)).toISOString();
  const to = new Date(localMidnight(dayMs, undefined, 1)).toISOString();
  const rows = await db.prepare('SELECT hour, raw_kwh, corrected_kwh FROM solar_forecast WHERE hour >= ? AND hour < ? ORDER BY hour').all(from, to);
  const total = round3(rows.reduce((s, r) => s + (r.corrected_kwh || 0), 0));
  const band = dailyErrorBand(await dailyHistory());
  return { from, to, hours: rows, total_kwh: total, low_kwh: round3(total * band.low), high_kwh: round3(total * band.high), band };
}

// Hourly corrected forecast between two instants (planner input): Map hourIso -> kWh.
async function forecastBetween(fromIso, toIso) {
  const rows = await db.prepare('SELECT hour, corrected_kwh FROM solar_forecast WHERE hour >= ? AND hour < ? ORDER BY hour').all(fromIso, toIso);
  return new Map(rows.map((r) => [r.hour, r.corrected_kwh || 0]));
}

let timer = null;
function startSolarForecast() {
  if (timer) return;
  const run = () => refreshForecast().catch(async (err) => {
    await settings.set('solar_status', { ok: false, at: new Date().toISOString(), error: err.message }).catch(() => {});
  });
  timer = setInterval(run, 60 * 60 * 1000);
  timer.unref?.();
  setTimeout(run, 40000).unref?.();
}

module.exports = {
  DEFAULTS, parseOpenMeteo, correctionFactors, factorFor, dailyErrorBand, openMeteoUrl,
  getConfig, getSite, refreshForecast, learnFactors, dailyHistory, forecastForDay, forecastBetween, startSolarForecast,
};
