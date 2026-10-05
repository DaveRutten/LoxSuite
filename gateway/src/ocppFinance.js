// OCPP costs and reimbursement: per bridge, what the charged kWh cost you and what you get back for
// them (e.g. from an employer via Laadloon), and the balance — per session, month, quarter and year.
//
// Cost per session, by `cost_mode`:
//   'hourly'  the session's energy spread over the hours it charged (Wallbox meter, energy_hourly):
//             the grid part at that hour's all-in price, the solar part at its value ('saldering' =
//             the price of that hour, 'fixed' = solar_eur_kwh, 'free' = 0). Without hourly meter data
//             for the session: the average price over the session window. Without prices: no cost.
//   'fixed'   energy × fixed_eur_kwh.
// Reimbursement: energy × the tariff in force on the session's start date (ocpp_tariffs, several
// rows with a valid_from date). No tariff = no reimbursement shown (blank by default).
// VAT: energy prices are all-in (incl. VAT); a tariff entered excl. VAT is raised by vat_pct, and
// `show_vat: 'excl'` shows every amount without VAT.
const db = require('./db');
const { localParts } = require('./localTime');

const DEFAULTS = { cost_mode: 'hourly', fixed_eur_kwh: null, solar_value: 'saldering', solar_eur_kwh: 0.05, tariff_vat: 'incl', show_vat: 'incl', vat_pct: 21 };
const r2 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const r4 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10000) / 10000);

function parseSettings(raw) {
  let s = {};
  try { s = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { s = {}; }
  return { ...DEFAULTS, ...s };
}

// Local date (YYYY-MM-DD) of an epoch-seconds moment.
function localDate(epochS, tz) {
  const p = localParts(epochS * 1000, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// The tariff (€/kWh as entered) in force on a local date: the latest valid_from on or before it.
function tariffOn(tariffs, date) {
  let best = null;
  for (const t of tariffs || []) if (t.valid_from <= date && (!best || t.valid_from > best.valid_from)) best = t;
  return best;
}

// Pure. rows: [{ start, end, energy }] (epoch s, kWh) from ocppExport.buildQuarterRows.
// hours: Map hourISO -> { wallboxKwh, gridImportKwh }. prices: [{ s, e, v }] (ms, €/kWh all-in).
function costSessions({ rows, tariffs, settings, hours, prices, timeZone }) {
  const cfg = parseSettings(settings);
  const vat = 1 + (Number(cfg.vat_pct) || 0) / 100;
  const show = cfg.show_vat === 'excl' ? 1 / vat : 1;
  const priceAt = (ms) => {
    const inHour = (prices || []).filter((p) => p.s < ms + 3600000 && p.e > ms);
    return inHour.length ? inHour.reduce((a, p) => a + p.v, 0) / inHour.length : null;
  };
  return (rows || []).map((r) => {
    const kwh = Number(r.energy) || 0;
    let cost = null; let source = null; let solarShare = null;
    if (cfg.cost_mode === 'fixed') {
      if (Number.isFinite(Number(cfg.fixed_eur_kwh)) && cfg.fixed_eur_kwh !== null && cfg.fixed_eur_kwh !== '') { cost = kwh * Number(cfg.fixed_eur_kwh); source = 'vast'; }
    } else {
      // Hours this session charged in (by the Wallbox meter), each weighted by its kWh.
      const first = Math.floor((r.start * 1000) / 3600000) * 3600000;
      const last = (r.end || r.start) * 1000;
      let wSum = 0; let eurPerKwh = 0; let solarKwh = 0; let total = 0;
      for (let t = first; t <= last; t += 3600000) {
        const h = hours?.get(new Date(t).toISOString());
        const wb = Number(h?.wallboxKwh) || 0;
        if (wb <= 0.01) continue;
        const price = priceAt(t);
        if (price === null) continue;
        const grid = Math.min(wb, Math.max(0, Number(h.gridImportKwh) || 0));
        const solar = wb - grid;
        const solarValue = cfg.solar_value === 'free' ? 0 : cfg.solar_value === 'fixed' ? Number(cfg.solar_eur_kwh) || 0 : price;
        eurPerKwh += grid * price + solar * solarValue; wSum += wb; solarKwh += solar; total += wb;
      }
      if (wSum > 0) { cost = kwh * (eurPerKwh / wSum); source = 'uur'; solarShare = Math.round((solarKwh / total) * 100); } else {
        const ps = [];
        for (let t = first; t <= last; t += 3600000) { const p = priceAt(t); if (p !== null) ps.push(p); }
        if (ps.length) { cost = kwh * (ps.reduce((a, b) => a + b, 0) / ps.length); source = 'gem'; }
      }
    }
    const t = tariffOn(tariffs, localDate(r.start, timeZone));
    const tariff = t ? Number(t.eur_per_kwh) * (cfg.tariff_vat === 'excl' ? vat : 1) : null;
    const reimbursement = tariff === null ? null : kwh * tariff;
    return {
      ...r,
      tariff: r4(tariff === null ? null : tariff * show),
      reimbursement: r2(reimbursement === null ? null : reimbursement * show),
      cost: r2(cost === null ? null : cost * show),
      saldo: r2(reimbursement === null || cost === null ? null : (reimbursement - cost) * show),
      costSource: source,
      solarShare,
    };
  });
}

// Pure. Totals of costed rows per local month key 'YYYY-MM', and for the current month/quarter/year.
function summarize(costed, timeZone, now = new Date()) {
  const add = (o, r) => {
    o.kwh += r.energy || 0; o.sessions += 1;
    if (r.cost !== null) { o.cost += r.cost; o.costed += 1; }
    if (r.reimbursement !== null) { o.reimbursement += r.reimbursement; o.reimbursed += 1; }
    return o;
  };
  const empty = () => ({ kwh: 0, sessions: 0, cost: 0, costed: 0, reimbursement: 0, reimbursed: 0 });
  const fin = (o) => ({
    kwh: Math.round(o.kwh * 1000) / 1000, sessions: o.sessions,
    cost: o.costed ? r2(o.cost) : null, reimbursement: o.reimbursed ? r2(o.reimbursement) : null,
    saldo: o.costed && o.reimbursed ? r2(o.reimbursement - o.cost) : null,
    eurPerKwh: o.costed && o.kwh ? r4(o.cost / o.kwh) : null,
  });
  const p = localParts(now.getTime(), timeZone);
  const q = Math.floor((p.m - 1) / 3);
  const months = new Map(); const month = empty(); const quarter = empty(); const year = empty();
  for (const r of costed) {
    const lp = localParts(r.start * 1000, timeZone);
    const key = `${lp.y}-${String(lp.m).padStart(2, '0')}`;
    add(months.get(key) || months.set(key, empty()).get(key), r);
    if (lp.y === p.y) { add(year, r); if (Math.floor((lp.m - 1) / 3) === q) add(quarter, r); if (lp.m === p.m) add(month, r); }
  }
  return {
    month: fin(month), quarter: fin(quarter), year: fin(year),
    months: Object.fromEntries([...months.entries()].map(([k, v]) => [k, fin(v)])),
  };
}

// ------------------------------------------------------------------------------- DB

async function listTariffs(bridgeId) {
  try { return await db.prepare('SELECT * FROM ocpp_tariffs WHERE bridge_id = ? ORDER BY valid_from DESC, id DESC').all(bridgeId); } catch { return []; }
}

// Hourly Wallbox/grid energy and prices for a window (epoch s). Empty when the Energy module has no data.
async function loadHoursAndPrices(fromS, toS) {
  const from = new Date(Math.floor((fromS * 1000) / 3600000) * 3600000).toISOString();
  const to = new Date(toS * 1000 + 3600000).toISOString();
  const hours = new Map();
  let prices = [];
  try {
    const rows = await db.prepare("SELECT hour, role, import_kwh FROM energy_hourly WHERE hour >= ? AND hour <= ? AND role IN ('wallbox', 'grid')").all(from, to);
    for (const r of rows) {
      const k = new Date(Date.parse(r.hour)).toISOString();
      const h = hours.get(k) || { wallboxKwh: 0, gridImportKwh: 0 };
      if (r.role === 'wallbox') h.wallboxKwh = r.import_kwh || 0; else h.gridImportKwh = r.import_kwh || 0;
      hours.set(k, h);
    }
  } catch { /* no energy tables/data */ }
  try {
    prices = (await db.prepare('SELECT start_at, end_at, allin_eur_kwh FROM energy_prices WHERE end_at >= ? AND start_at <= ?').all(from, to))
      .map((p) => ({ s: Date.parse(p.start_at), e: Date.parse(p.end_at), v: p.allin_eur_kwh })).filter((p) => p.v !== null && p.v !== undefined);
  } catch { prices = []; }
  return { hours, prices };
}

// Costs the given session rows for a bridge (settings + tariffs + hourly data from the DB).
async function costRows(bridge, rows, timeZone) {
  if (!rows.length) return [];
  const fromS = Math.min(...rows.map((r) => r.start));
  const toS = Math.max(...rows.map((r) => r.end || r.start));
  const { hours, prices } = await loadHoursAndPrices(fromS, toS);
  return costSessions({ rows, tariffs: await listTariffs(bridge.id), settings: bridge.finance, hours, prices, timeZone });
}

function isConfigured(bridge, tariffs) {
  const s = parseSettings(bridge.finance);
  return !!(tariffs?.length || bridge.finance || s.cost_mode === 'fixed');
}

module.exports = { DEFAULTS, parseSettings, tariffOn, localDate, costSessions, summarize, listTariffs, loadHoursAndPrices, costRows, isConfigured };
