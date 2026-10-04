// Fuel price for the plug-in hybrid trade-off (charge vs. drive on fuel). Manual by default; with
// "automatic" LoxSuite reads the national average pump price of Euro95 from CBS open data once a
// day (dataset 80416ned, "Pompprijzen motorbrandstoffen"). The automatic value is a nationwide
// average — your own station may differ — and the manual price is used whenever it can't be read.
const settings = require('./wallboxSettings');

const CBS_URL = 'https://opendata.cbs.nl/ODataApi/odata/80416ned/TypedDataSet?$orderby=Perioden%20desc&$top=7';

// CBS rows -> { eur_l, date } from the newest row with a Euro95/benzine column.
function parseCbs(body) {
  const rows = body?.value || [];
  for (const r of rows) {
    const key = Object.keys(r).find((k) => /euro\s*95|benzine/i.test(k) && Number.isFinite(Number(r[k])) && Number(r[k]) > 0.5 && Number(r[k]) < 5);
    if (key) {
      const p = String(r.Perioden || '');
      const date = /^\d{8}$/.test(p) ? `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}` : p;
      return { eur_l: Math.round(Number(r[key]) * 1000) / 1000, date, field: key };
    }
  }
  return null;
}

async function refreshFuelPrice({ fetchImpl } = {}) {
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
  const parsed = parseCbs(await get(CBS_URL));
  if (!parsed) throw new Error('No Euro95 price found in the CBS data.');
  await settings.set('fuel_auto', { ...parsed, fetched_at: new Date().toISOString() });
  return parsed;
}

// { eur_l, source: 'auto' | 'manual', date }
async function currentFuelPrice() {
  const cfg = await settings.get('planner', {});
  if (cfg.fuel_auto) {
    const auto = await settings.get('fuel_auto', null);
    if (auto?.eur_l) return { eur_l: auto.eur_l, source: 'auto', date: auto.date };
  }
  return { eur_l: Number(cfg.fuel_eur_l) || 2.1, source: 'manual' };
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

module.exports = { parseCbs, refreshFuelPrice, currentFuelPrice, startFuelPrice, CBS_URL };
