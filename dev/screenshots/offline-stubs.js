// Preloaded into the app for the screenshot run (node -r ./offline-stubs.js): answers the outside
// services LoxSuite calls — day-ahead prices, the solar forecast, the CBS fuel price, address
// lookups, GitHub release checks — with synthetic data, so the screenshots look the same every
// time and need no internet. Everything else (the fake Miniserver, the car and calendar feeds on
// localhost) goes through untouched.
const realFetch = globalThis.fetch;

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const HOUR = 3600000;

// A typical autumn day-ahead curve (€/kWh, excl. VAT): cheap at night and midday, peaks morning/evening.
function marketAt(ms) {
  const h = new Date(ms).getUTCHours() + 2; // ~ Dutch local time
  const base = 0.085 + 0.045 * Math.sin(((h - 3) / 24) * 2 * Math.PI);
  const evening = h >= 17 && h <= 21 ? 0.07 : 0;
  const morning = h >= 7 && h <= 9 ? 0.04 : 0;
  const solarDip = h >= 11 && h <= 15 ? -0.05 : 0;
  return Math.round((base + evening + morning + solarDip) * 10000) / 10000;
}

function energyZero(url) {
  const from = Date.parse(url.searchParams.get('fromDate'));
  const till = Date.parse(url.searchParams.get('tillDate'));
  const Prices = [];
  for (let t = Math.floor(from / HOUR) * HOUR; t <= till; t += HOUR) Prices.push({ readingDate: new Date(t).toISOString(), price: marketAt(t) });
  return json({ Prices, intervalType: 4 });
}

// EnergyZero's public API: `date` (dd-mm-yyyy, local) answers the day before, that day and the day after.
function energyZeroPublic(url) {
  const [d, m, y] = String(url.searchParams.get('date') || '').split('-').map(Number);
  const day = Date.UTC(y, m - 1, d) - 2 * HOUR; // ~ Dutch local midnight
  const Q = HOUR / 4;
  const base = [];
  for (let t = day - 24 * HOUR; t < day + 48 * HOUR; t += Q) base.push({ start: new Date(t).toISOString(), end: new Date(t + Q).toISOString(), price: { value: String(marketAt(t)) } });
  return json({ interval: 'RESPONSE_INTERVAL_QUARTER', range: { start: base[0].start, end: base[base.length - 1].end }, base });
}

// Global tilted irradiance (W/m²) per hour: a bell around 13:00 UTC+2, a little cloud on day 2.
function openMeteo() {
  const start = Math.floor(Date.now() / 86400000) * 86400000 - 86400000;
  const time = [];
  const gti = [];
  const temp = [];
  for (let t = start; t < start + 5 * 86400000; t += HOUR) {
    const h = new Date(t).getUTCHours() + 2;
    const day = Math.floor((t - start) / 86400000);
    const sun = Math.max(0, Math.sin(((h - 7.5) / 11) * Math.PI));
    const cloud = day === 2 ? 0.55 : day === 3 ? 0.8 : 1;
    time.push(new Date(t + HOUR).toISOString().slice(0, 16));
    gti.push(Math.round(620 * sun * cloud));
    temp.push(Math.round((9 + 5 * Math.sin(((h - 9) / 24) * 2 * Math.PI) - day) * 10) / 10);
  }
  return json({ hourly: { time, global_tilted_irradiance: gti, temperature_2m: temp } });
}

function cbs() {
  const d = new Date(Date.now() - 2 * 86400000);
  const p = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return json({ value: [{ Perioden: p, BenzineEuro95_1: 2.069, Diesel_2: 1.812, Lpg_3: 0.846 }] });
}

globalThis.fetch = async (input, init) => {
  let url;
  try { url = new URL(typeof input === 'string' ? input : input.url); } catch { return realFetch(input, init); }
  const host = url.host;
  if (host === 'api.energyzero.nl') return energyZero(url);
  if (host === 'public.api.energyzero.nl') return energyZeroPublic(url);
  if (host === 'api.open-meteo.com') return openMeteo();
  if (host === 'opendata.cbs.nl') return cbs();
  if (host === 'nominatim.openstreetmap.org') return json([{ lat: '52.156', lon: '5.387' }]);
  if (host === 'router.project-osrm.org') return json({ routes: [{ distance: 46800, duration: 2460 }] });
  if (host === 'api.github.com' || host === 'raw.githubusercontent.com') return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return realFetch(input, init);
  return new Response('offline (screenshot run)', { status: 503 });
};
