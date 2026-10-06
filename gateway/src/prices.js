// Electricity prices for the charging planner. Day-ahead market prices come from EnergyZero (free,
// no key) or ENTSO-E (free API key); the all-in price you actually pay is derived either from a
// tariff formula (market + supplier markup, VAT, energy tax) or — when a Loxone Spot Price Optimizer
// exists — by calibrating against the all-in price Loxone shows: LoxSuite samples Loxone's current
// price every 15 minutes and fits all-in = a x market + b over the last two weeks.
//
// Without an internet price source, 'loxone' predicts from the Spot Price Optimizer's own recent
// prices per hour of day (an estimate, shown as such).
const db = require('./db');
const settings = require('./wallboxSettings');
const { encrypt, decrypt } = require('./secretCrypto');

const DEFAULTS = {
  source: 'energyzero',      // 'energyzero' | 'entsoe' | 'loxone' | 'fixed'
  entsoe_token: null,         // encrypted
  entsoe_zone: '10YNL----------L',
  markup_eur_kwh: 0.02,
  energy_tax_eur_kwh: 0.10,
  vat_pct: 21,
  fixed_eur_kwh: 0.30,
  // Fixed contract with a low (dal) tariff: empty = single tariff. Dutch default: low on weekdays
  // 23:00–07:00 and all weekend.
  fixed_low_eur_kwh: null,
  fixed_low_from: '23:00',
  fixed_low_until: '07:00',
  fixed_low_weekend: true,
  // What your dynamic contract bills: 'hour' (average of the four quarters, most suppliers) or
  // 'quarter' (each 15 minutes its own price; ENTSO-E gives quarters, EnergyZero only hours).
  price_interval: 'hour',
  // What the charts show: 'hour', or 'quarter' when the source has quarters (ENTSO-E) — also when
  // the contract bills per hour, so you see the price move within the hour.
  chart_interval: 'hour',
  calibrate_loxone: true,
  loxone_miniserver_id: null,
  loxone_uuid: null,          // SpotPriceOptimizer control
};

// ------------------------------------------------------------------ pure helpers

function round4(x) { return Math.round(x * 10000) / 10000; }

// All-in €/kWh from a market price, by calibration when available, else by the tariff formula.
function allinPrice(market, cfg = DEFAULTS, calib = null) {
  if (market === null || market === undefined || !Number.isFinite(Number(market))) return null;
  const m = Number(market);
  if (calib && Number.isFinite(calib.a) && Number.isFinite(calib.b)) return round4(calib.a * m + calib.b);
  const vat = 1 + (Number(cfg.vat_pct) || 0) / 100;
  return round4((m + (Number(cfg.markup_eur_kwh) || 0)) * vat + (Number(cfg.energy_tax_eur_kwh) || 0));
}

// Least squares y = a*x + b. Null with fewer than `minPairs` pairs or an implausible slope.
function fitLinear(pairs, minPairs = 24) {
  const pts = pairs.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < minPairs) return null;
  const n = pts.length;
  const sx = pts.reduce((s, p) => s + p.x, 0);
  const sy = pts.reduce((s, p) => s + p.y, 0);
  const sxx = pts.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = pts.reduce((s, p) => s + p.x * p.y, 0);
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return null;
  const a = (n * sxy - sx * sy) / den;
  const b = (sy - a * sx) / n;
  if (!(a > 0.7 && a < 2.0)) return null;
  const rmse = Math.sqrt(pts.reduce((s, p) => s + (a * p.x + b - p.y) ** 2, 0) / n);
  return { a: round4(a), b: round4(b), n, rmse: round4(rmse) };
}

// EnergyZero answer -> intervals. Each price holds until the next one (hourly or 15-minute).
function parseEnergyZero(body) {
  const list = (body?.Prices || body?.prices || []).map((p) => ({ start: Date.parse(p.readingDate || p.from), price: Number(p.price) }))
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.price))
    .sort((a, b) => a.start - b.start);
  return toIntervals(list);
}

function toIntervals(list, defaultMs = 3600000) {
  const step = list.length > 1 ? Math.min(...list.slice(1).map((p, i) => p.start - list[i].start).filter((d) => d > 0)) : defaultMs;
  return list.map((p, i) => ({
    start: new Date(p.start).toISOString(),
    end: new Date(list[i + 1] && list[i + 1].start - p.start <= step ? list[i + 1].start : p.start + (Number.isFinite(step) ? step : defaultMs)).toISOString(),
    market: round4(p.price),
  }));
}

// ENTSO-E day-ahead (documentType A44) XML -> intervals, €/MWh -> €/kWh. Positions left out of a
// curve (A03 "variable sized block") repeat the previous price.
function parseEntsoe(xml) {
  const out = [];
  const periods = String(xml).split(/<Period>/).slice(1);
  for (const p of periods) {
    const start = Date.parse((/<start>([^<]+)<\/start>/.exec(p) || [])[1]);
    const end = Date.parse((/<end>([^<]+)<\/end>/.exec(p) || [])[1]);
    const res = (/<resolution>PT(\d+)M<\/resolution>/.exec(p) || [])[1];
    if (!Number.isFinite(start) || !Number.isFinite(end) || !res) continue;
    const stepMs = Number(res) * 60000;
    const points = [...p.matchAll(/<Point>\s*<position>(\d+)<\/position>\s*<price\.amount>([-\d.]+)<\/price\.amount>/g)]
      .map((m) => ({ pos: Number(m[1]), price: Number(m[2]) / 1000 }));
    const count = Math.round((end - start) / stepMs);
    let last = null;
    const byPos = new Map(points.map((x) => [x.pos, x.price]));
    for (let pos = 1; pos <= count; pos++) {
      if (byPos.has(pos)) last = byPos.get(pos);
      if (last === null) continue;
      const s = start + (pos - 1) * stepMs;
      out.push({ start: new Date(s).toISOString(), end: new Date(s + stepMs).toISOString(), market: round4(last) });
    }
  }
  return out;
}

// Pure: quarter (or shorter) intervals -> one per hour with the average price. Hours with only part of
// their quarters keep the average of what is there.
function toHourly(intervals) {
  const byHour = new Map();
  for (const i of intervals) {
    const s = Date.parse(i.start);
    const h = Math.floor(s / 3600000) * 3600000;
    const g = byHour.get(h) || { sum: 0, n: 0 };
    if (i.market !== null && i.market !== undefined) { g.sum += Number(i.market); g.n++; }
    byHour.set(h, g);
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]).filter(([, g]) => g.n)
    .map(([h, g]) => ({ start: new Date(h).toISOString(), end: new Date(h + 3600000).toISOString(), market: round4(g.sum / g.n) }));
}

// Pure: price of a fixed contract at an instant (single, or normal/low by time of day and weekend).
function fixedPrice(ms, cfg, { localParts } = {}) {
  const normal = Number(cfg.fixed_eur_kwh) || 0;
  const low = cfg.fixed_low_eur_kwh === null || cfg.fixed_low_eur_kwh === undefined || cfg.fixed_low_eur_kwh === '' ? null : Number(cfg.fixed_low_eur_kwh);
  if (low === null || !Number.isFinite(low)) return normal;
  const p = (localParts || require('./localTime').localParts)(ms);
  if (cfg.fixed_low_weekend !== false && p.weekday >= 5) return low;
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const from = toMin(cfg.fixed_low_from ?? '23:00');
  const until = toMin(cfg.fixed_low_until ?? '07:00');
  if (from === null || until === null || from === until) return normal;
  const min = p.hour * 60 + p.minute;
  const inLow = from < until ? (min >= from && min < until) : (min >= from || min < until);
  return inLow ? low : normal;
}

function entsoeTime(ms) {
  return new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 12);
}

// Predicted all-in price per hour of day from recent samples [{start, price}] (median per hour).
function hourOfDayProfile(samples, tzHour) {
  const by = Array.from({ length: 24 }, () => []);
  for (const s of samples) by[tzHour(Date.parse(s.start))].push(s.price);
  return by.map((arr) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return round4(a[Math.floor(a.length / 2)]);
  });
}

// Pure: hours of day without data get the median of the hours that have it.
function fillProfile(prof) {
  const known = prof.filter((p) => p !== null).sort((a, b) => a - b);
  if (!known.length) return prof;
  const mid = known[Math.floor(known.length / 2)];
  return prof.map((p) => (p === null ? mid : p));
}

// The Spot Price Optimizer's own price history (statistics, 15-minute values) of the last `days`
// days through the Miniserver's MCP server. [] when that isn't authorized or has nothing.
async function loxoneHistory(nowMs = Date.now(), days = 14, { callTool } = {}) {
  const spo = await findSpotOptimizer();
  if (!spo?.statGroup) return [];
  const call = callTool || ((ms, name, input) => require('./mcpClient').callTool(ms, name, input));
  const res = await call(spo.miniserver, 'control_statistics', {
    uuid: spo.uuid, mode: 'raw', group_id: spo.statGroup,
    from: new Date(nowMs - days * 86400000).toISOString(), to: new Date(nowMs).toISOString(), limit: 10000,
  });
  let obj = res;
  if (res && Array.isArray(res.content)) {
    if (res.isError) return [];
    try { obj = JSON.parse(res.content.find((c) => c.type === 'text')?.text || '{}'); } catch { return []; }
  }
  return (obj?.rows || []).map((r) => ({ start: r.ts, price: Number(r.values?.[0]) })).filter((r) => Number.isFinite(Date.parse(r.start)) && Number.isFinite(r.price));
}

// ------------------------------------------------------------------ config

async function getConfig() {
  return settings.get('prices', DEFAULTS);
}

async function saveConfig(values) {
  const cur = await getConfig();
  const next = { ...cur, ...values };
  if (values.entsoe_token === '') next.entsoe_token = cur.entsoe_token; // blank = keep
  else if (values.entsoe_token) next.entsoe_token = encrypt(values.entsoe_token);
  await settings.set('prices', next);
  return next;
}

function entsoeToken(cfg) {
  try { return cfg.entsoe_token ? decrypt(cfg.entsoe_token) : ''; } catch { return ''; }
}

// ------------------------------------------------------------------ fetching

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'LoxSuite' } });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    return text;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('No answer within 15 s.');
    if (err.message === 'fetch failed') throw new Error(`Cannot reach ${new URL(url).host} (${err.cause?.code || 'network error'}).`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function fetchMarket(cfg, fromMs, toMs, fetchImpl = fetchText) {
  if (cfg.source === 'energyzero') {
    const url = `https://api.energyzero.nl/v1/energyprices?fromDate=${new Date(fromMs).toISOString()}&tillDate=${new Date(toMs - 1).toISOString()}&interval=4&usageType=1&inclBtw=false`;
    return parseEnergyZero(JSON.parse(await fetchImpl(url)));
  }
  if (cfg.source === 'entsoe') {
    const token = entsoeToken(cfg);
    if (!token) throw new Error('ENTSO-E needs an API token.');
    const zone = cfg.entsoe_zone || DEFAULTS.entsoe_zone;
    const url = `https://web-api.tp.entsoe.eu/api?securityToken=${encodeURIComponent(token)}&documentType=A44&in_Domain=${zone}&out_Domain=${zone}&periodStart=${entsoeTime(fromMs)}&periodEnd=${entsoeTime(toMs)}`;
    const xml = await fetchImpl(url);
    if (/<Acknowledgement_MarketDocument/.test(xml)) throw new Error(((/<text>([^<]+)<\/text>/.exec(xml) || [])[1]) || 'ENTSO-E has no data for this period.');
    return parseEntsoe(xml);
  }
  return [];
}

// ------------------------------------------------------------------ Loxone Spot Price Optimizer

async function findSpotOptimizer() {
  const cfg = await getConfig();
  const loxoneStructure = require('./loxoneStructure');
  const miniservers = await db.prepare('SELECT * FROM miniservers ORDER BY id').all();
  for (const ms of miniservers) {
    if (cfg.loxone_miniserver_id && ms.id !== cfg.loxone_miniserver_id) continue;
    let s;
    try { s = await loxoneStructure.getStructure(ms); } catch { continue; }
    for (const [uuid, c] of Object.entries(s?.controls || {})) {
      if (c.type === 'SpotPriceOptimizer' && (!cfg.loxone_uuid || cfg.loxone_uuid === uuid)) {
        const group = (c.statisticV2?.groups || []).find((g) => (g.dataPoints || []).some((d) => d.output === 'current'));
        return { miniserver: ms, uuid, name: c.name, currentState: c.states?.current, statGroup: group ? String(group.id) : null };
      }
    }
  }
  return null;
}

async function loxoneCurrentPrice() {
  const spo = await findSpotOptimizer();
  if (!spo?.currentState) return null;
  const v = require('./loxoneWebSocket').getLiveValue(spo.miniserver.id, spo.currentState);
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? { price: round4(n), name: spo.name } : null;
}

// Every 15 minutes: remember Loxone's all-in price next to the market price of that interval.
async function sampleCalibration(nowMs = Date.now()) {
  const cur = await loxoneCurrentPrice();
  if (!cur) return null;
  const startMs = Math.floor(nowMs / 900000) * 900000;
  const row = await db.prepare('SELECT market_eur_kwh FROM energy_prices WHERE start_at <= ? AND end_at > ? ORDER BY start_at DESC LIMIT 1')
    .get(new Date(startMs).toISOString(), new Date(startMs).toISOString());
  const samples = await settings.get('price_samples', []);
  const list = Array.isArray(samples) ? samples : [];
  const iso = new Date(startMs).toISOString();
  if (!list.some((s) => s.start === iso)) list.push({ start: iso, loxone: cur.price, market: row?.market_eur_kwh ?? null });
  const cutoff = new Date(nowMs - 14 * 86400000).toISOString();
  await settings.set('price_samples', list.filter((s) => s.start >= cutoff).slice(-2000));
  return cur;
}

async function calibration() {
  const samples = await settings.get('price_samples', []);
  return fitLinear((Array.isArray(samples) ? samples : []).filter((s) => s.market !== null).map((s) => ({ x: s.market, y: s.loxone })));
}

// ------------------------------------------------------------------ store & read

async function refreshPrices(nowMs = Date.now(), { fetchImpl } = {}) {
  const cfg = await getConfig();
  const { localMidnight } = require('./localTime');
  const from = localMidnight(nowMs);
  const to = localMidnight(nowMs, undefined, 2);
  const calib = cfg.calibrate_loxone ? await calibration() : null;
  let intervals = [];
  let basis = null;
  if (cfg.source === 'fixed') {
    // quarters, so a low tariff that starts at e.g. 22:45 is exact
    for (let t = from; t < to; t += 900000) intervals.push({ start: new Date(t).toISOString(), end: new Date(t + 900000).toISOString(), market: null, allin: round4(fixedPrice(t, cfg)) });
  } else if (cfg.source === 'loxone') {
    // Loxone's own API gives the current price and its history, not the day-ahead forecast the app
    // shows: an estimate per hour of day from the last two weeks — the Miniserver's own statistics
    // (through its MCP server, when authorized) plus what LoxSuite sampled itself.
    const samples = ((await settings.get('price_samples', [])) || []).map((s) => ({ start: s.start, price: s.loxone }));
    const history = await loxoneHistory(nowMs).catch(() => []);
    const { localParts } = require('./localTime');
    const all = [...history, ...samples].filter((s) => Number.isFinite(s.price) && s.price !== 0);
    if (!all.length) throw new Error('No Loxone prices yet: LoxSuite samples the Spot Price Optimizer every 15 minutes (or authorize its MCP server under Miniservers for its history).');
    const prof = fillProfile(hourOfDayProfile(all, (ms) => localParts(ms).hour));
    // the hours that already passed today: what the price really was
    const actual = new Map(all.map((s) => [Math.floor(Date.parse(s.start) / 3600000) * 3600000, null]));
    for (const s of all) { const h = Math.floor(Date.parse(s.start) / 3600000) * 3600000; const a = actual.get(h); actual.set(h, a ? { sum: a.sum + s.price, n: a.n + 1 } : { sum: s.price, n: 1 }); }
    for (let t = from; t < to; t += 3600000) {
      const a = t + 3600000 <= nowMs ? actual.get(t) : null;
      const p = a ? round4(a.sum / a.n) : prof[localParts(t).hour];
      intervals.push({ start: new Date(t).toISOString(), end: new Date(t + 3600000).toISOString(), market: null, allin: p });
    }
    basis = all.length; // number of Spot Price Optimizer values the estimate is made from
  } else {
    let market = await fetchMarket(cfg, from, to, fetchImpl);
    // the quarters as they came in, for the charts (planning stays on what the contract bills)
    const quarterly = market.some((i) => Date.parse(i.end) - Date.parse(i.start) < 3600000);
    await settings.set('price_quarters', quarterly ? market.map((i) => ({ start: i.start, end: i.end, price: allinPrice(i.market, cfg, calib) })) : []);
    if (cfg.price_interval !== 'quarter') market = toHourly(market);
    intervals = market.map((i) => ({ ...i, allin: allinPrice(i.market, cfg, calib) }));
  }
  const now = new Date().toISOString();
  // Replace what was stored for this stretch: switching between hours and quarters (or to a fixed
  // contract) must not leave the other granularity's rows overlapping.
  if (intervals.length) await db.prepare('DELETE FROM energy_prices WHERE start_at >= ? AND start_at < ?').run(intervals[0].start, intervals[intervals.length - 1].end);
  for (const i of intervals) {
    await db.upsert('energy_prices', { start_at: i.start, end_at: i.end, market_eur_kwh: i.market, allin_eur_kwh: i.allin, source: cfg.source, fetched_at: now }, ['start_at']);
  }
  await settings.set('prices_status', { ok: true, at: now, count: intervals.length, until: intervals.length ? intervals[intervals.length - 1].end : null, calib, basis });
  return { count: intervals.length, calib };
}

// Quarter-hour all-in prices for the charts between two times, or null when the charts show hours
// (setting) or the source has no quarters (EnergyZero, the Loxone estimate).
async function chartQuarters(fromIso, toIso) {
  const cfg = await getConfig();
  if (cfg.chart_interval !== 'quarter' || !['energyzero', 'entsoe'].includes(cfg.source)) return null;
  const a = Date.parse(fromIso), b = Date.parse(toIso);
  const list = ((await settings.get('price_quarters', [])) || []).filter((q) => Date.parse(q.end) > a && Date.parse(q.start) < b);
  return list.length ? list : null;
}

async function getPrices(fromIso, toIso) {
  return db.prepare('SELECT start_at, end_at, market_eur_kwh, allin_eur_kwh, source FROM energy_prices WHERE end_at > ? AND start_at < ? ORDER BY start_at').all(fromIso, toIso);
}

async function currentPrice(nowMs = Date.now()) {
  const lox = await loxoneCurrentPrice().catch(() => null);
  if (lox) return { eur_kwh: lox.price, source: 'loxone' };
  const iso = new Date(nowMs).toISOString();
  const row = await db.prepare('SELECT allin_eur_kwh FROM energy_prices WHERE start_at <= ? AND end_at > ? ORDER BY start_at DESC LIMIT 1').get(iso, iso);
  return row ? { eur_kwh: row.allin_eur_kwh, source: 'table' } : null;
}

// ------------------------------------------------------------------ lifecycle

let timers = [];
function startPrices() {
  if (timers.length) return;
  const refresh = () => refreshPrices().catch(async (err) => {
    console.error(`[prices] ${err.message}`);
    await settings.set('prices_status', { ok: false, at: new Date().toISOString(), error: err.message }).catch(() => {});
  });
  const t1 = setInterval(refresh, 60 * 60 * 1000);
  const t2 = setInterval(() => sampleCalibration().catch(() => {}), 15 * 60 * 1000);
  setTimeout(refresh, 30000).unref?.();
  setTimeout(() => sampleCalibration().catch(() => {}), 45000).unref?.();
  [t1, t2].forEach((t) => t.unref?.());
  timers = [t1, t2];
}

function stopPrices() {
  timers.forEach(clearInterval);
  timers = [];
}

module.exports = {
  DEFAULTS, allinPrice, fitLinear, parseEnergyZero, parseEntsoe, entsoeTime, hourOfDayProfile, fillProfile, loxoneHistory, toIntervals, toHourly, fixedPrice,
  getConfig, saveConfig, fetchMarket, refreshPrices, getPrices, chartQuarters, currentPrice, calibration, sampleCalibration,
  loxoneCurrentPrice, findSpotOptimizer, startPrices, stopPrices,
};
