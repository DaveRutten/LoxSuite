// Fuel price for the plug-in hybrid trade-off (charge vs. drive on fuel). Manual by default; with
// "automatic" LoxSuite reads the national average pump price from CBS open data twice a day
// (dataset 80416ned, "Pompprijzen motorbrandstoffen": Euro95 — at Dutch pumps that is E10 —, diesel
// and LPG). You choose what you tank; a surcharge per litre covers e.g. Super 98 / E5 or a dearer
// station. The automatic value is a nationwide average; the manual price is used whenever it
// can't be read.
const settings = require('./wallboxSettings');

const CBS_BASE = 'https://opendata.cbs.nl/ODataApi/odata/80416ned/TypedDataSet';
// The dataset runs from 2006, oldest first, and the API ignores $orderby: ask for the last weeks only.
function cbsUrl(nowMs = Date.now()) {
  const d = new Date(nowMs - 30 * 86400000);
  const from = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${CBS_BASE}?$filter=${encodeURIComponent(`Perioden ge '${from}'`)}`;
}
const CBS_URL = cbsUrl();

const FUEL_TYPES = {
  euro95: { label: 'Euro95 (E10)', re: /euro\s*95|benzine/i },
  diesel: { label: 'Diesel', re: /diesel/i },
  lpg: { label: 'LPG', re: /lpg/i },
};
const MAX_AGE_DAYS = 14;

// CBS rows -> { date, prices: { euro95, diesel, lpg } } from the NEWEST row (by Perioden).
function parseCbs(body) {
  const rows = [...(body?.value || [])].sort((x, y) => String(y.Perioden || '').localeCompare(String(x.Perioden || '')));
  for (const r of rows) {
    const prices = {};
    for (const [type, def] of Object.entries(FUEL_TYPES)) {
      const key = Object.keys(r).find((k) => def.re.test(k));
      const v = key ? Number(r[key]) : NaN;
      if (Number.isFinite(v) && v > 0.3 && v < 5) prices[type] = Math.round(v * 1000) / 1000;
    }
    if (!prices.euro95 && !prices.diesel && !prices.lpg) continue;
    const p = String(r.Perioden || '');
    const date = /^\d{8}$/.test(p) ? `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}` : p;
    return { date, prices, eur_l: prices.euro95 ?? null };
  }
  return null;
}

async function refreshFuelPrice({ fetchImpl, nowMs = Date.now() } = {}) {
  const get = fetchImpl || (async (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.message === 'fetch failed') throw new Error(`Cannot reach opendata.cbs.nl (${err.cause?.code || 'network error'}).`);
      throw err;
    } finally {
      clearTimeout(t);
    }
  });
  const parsed = parseCbs(await get(cbsUrl(nowMs)));
  if (!parsed) throw new Error('No fuel prices found in the CBS data.');
  await settings.set('fuel_auto', { ...parsed, fetched_at: new Date(nowMs).toISOString() });
  await settings.set('fuel_auto_error', null);
  return { ...parsed, ...(await currentFuelPrice()) };
}

// Pure: the price for what you tank. cfg: planner settings; auto: stored CBS reading.
function pickPrice(cfg, auto, nowMs = Date.now()) {
  const type = FUEL_TYPES[cfg.fuel_type] ? cfg.fuel_type : 'euro95';
  const markup = Number(cfg.fuel_markup_eur_l) || 0;
  const label = FUEL_TYPES[type].label;
  if (cfg.fuel_auto && auto) {
    // older stored readings had only eur_l (Euro95)
    const base = auto.prices ? auto.prices[type] : (type === 'euro95' ? auto.eur_l : null);
    const ageDays = auto.date ? (nowMs - Date.parse(auto.date)) / 86400000 : null;
    if (base && (ageDays === null || ageDays <= MAX_AGE_DAYS)) {
      return { eur_l: Math.round((base + markup) * 1000) / 1000, source: 'auto', date: auto.date, type, label, base, markup };
    }
  }
  return { eur_l: Number(cfg.fuel_eur_l) || 2.1, source: 'manual', type, label, markup: 0 };
}

// { eur_l, source: 'auto' | 'manual', date, type, label }
async function currentFuelPrice() {
  const cfg = await settings.get('planner', {});
  return pickPrice(cfg, cfg.fuel_auto ? await settings.get('fuel_auto', null) : null);
}

let timer = null;
function startFuelPrice() {
  if (timer) return;
  const run = async () => {
    const cfg = await settings.get('planner', {});
    if (cfg.fuel_auto) await refreshFuelPrice().catch(async (err) => settings.set('fuel_auto_error', { error: err.message, at: new Date().toISOString() }));
  };
  timer = setInterval(run, 12 * 3600 * 1000);
  timer.unref?.();
  setTimeout(run, 70000).unref?.();
}

function stopFuelPrice() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { parseCbs, pickPrice, cbsUrl, refreshFuelPrice, currentFuelPrice, startFuelPrice, stopFuelPrice, CBS_URL, FUEL_TYPES };
