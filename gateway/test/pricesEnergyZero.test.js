// EnergyZero's public API (v0.45.1): the old api.energyzero.nl/v1/energyprices stopped getting the
// next day's prices (reported: Wednesday 17:00 still nothing for Thursday, while Loxone and the
// public API had them). One call asks a local day and gets the day before, that day and the day
// after as far as known; 404 = that day isn't out yet.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb, db } = require('./helpers/testDb');
const prices = require('../src/prices');
const { localMidnight, localParts } = require('../src/localTime');
const { encrypt } = require('../src/secretCrypto');

const H = 3600000;
const Q = 900000;

before(async () => { await initTestDb(); });
after(async () => { await db.close(); });

// quarters from a to b in the public API's shape
function body(a, b, price = (t) => 0.1 + ((t / Q) % 7) / 100) {
  const base = [];
  for (let t = a; t < b; t += Q) base.push({ start: new Date(t).toISOString().replace('.000', ''), end: new Date(t + Q).toISOString().replace('.000', ''), price: { value: String(price(t)) } });
  return { interval: 'RESPONSE_INTERVAL_QUARTER', range: { start: new Date(a).toISOString(), end: new Date(b).toISOString() }, base, base_with_vat: [], all_in: [] };
}
const notFound = () => { throw new Error('HTTP 404: not found'); };
const dateOf = (url) => (/[?&]date=([\d-]+)/.exec(url) || [])[1];

test('parseEnergyZeroPublic: the "base" list (market excl. VAT) with its own start and end', () => {
  const list = prices.parseEnergyZeroPublic({
    base: [
      { start: '2026-10-07T22:15:00Z', end: '2026-10-07T22:30:00Z', price: { value: '0.20153' } },
      { start: '2026-10-07T22:00:00Z', end: '2026-10-07T22:15:00Z', price: { value: '0.20971' } },
      { start: 'nonsense', end: '2026-10-07T22:15:00Z', price: { value: '0.1' } },
      { start: '2026-10-07T23:00:00Z', end: '2026-10-07T23:15:00Z', price: {} },
    ],
    all_in: [{ start: '2026-10-07T22:00:00Z', end: '2026-10-07T22:15:00Z', price: { value: '0.30132' } }],
  });
  assert.deepEqual(list, [
    { start: '2026-10-07T22:00:00.000Z', end: '2026-10-07T22:15:00.000Z', market: 0.2097 },
    { start: '2026-10-07T22:15:00.000Z', end: '2026-10-07T22:30:00.000Z', market: 0.2015 },
  ]);
  assert.deepEqual(prices.parseEnergyZeroPublic({}), []);
  assert.deepEqual(prices.parseEnergyZeroPublic(null), []);
});

test('ezDate: the local day as dd-mm-yyyy', () => {
  assert.equal(prices.ezDate(0, () => ({ y: 2026, m: 10, d: 8 })), '08-10-2026');
  assert.equal(prices.ezDate(0, () => ({ y: 2026, m: 12, d: 31 })), '31-12-2026');
});

test('fetchEnergyZero: one call brings today and tomorrow — tomorrow\'s prices are no longer missing', async () => {
  const now = Date.now();
  const from = localMidnight(now);
  const to = localMidnight(now, undefined, 2);
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (!url.startsWith('https://public.api.energyzero.nl/public/v1/prices?')) throw new Error('old API asked');
    return JSON.stringify(body(localMidnight(now, undefined, -1), to)); // yesterday, today, tomorrow
  };
  const list = await prices.fetchEnergyZero(from, to, fetchImpl);
  assert.equal(urls.length, 1, 'one request');
  assert.match(urls[0], /energyType=ENERGY_TYPE_ELECTRICITY/);
  assert.match(urls[0], /interval=INTERVAL_QUARTER/);
  assert.equal(dateOf(urls[0]), prices.ezDate(from, localParts));
  assert.equal(list.length, (to - from) / Q, 'today and tomorrow, per quarter');
  assert.equal(list[0].start, new Date(from).toISOString(), 'yesterday is left out');
  assert.equal(list[list.length - 1].end, new Date(to).toISOString());
});

test('fetchEnergyZero: tomorrow not out yet (404) — today only, no error, no old API', async () => {
  const now = Date.now();
  const from = localMidnight(now);
  const tomorrow = localMidnight(now, undefined, 1);
  const to = localMidnight(now, undefined, 2);
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (!url.includes('public.api')) throw new Error('old API asked');
    // a server that answers one day per call
    return dateOf(url) === prices.ezDate(from, localParts) ? JSON.stringify(body(from, tomorrow)) : notFound();
  };
  const list = await prices.fetchEnergyZero(from, to, fetchImpl);
  assert.equal(list.length, (tomorrow - from) / Q);
  assert.deepEqual(urls.map(dateOf), [prices.ezDate(from, localParts), prices.ezDate(tomorrow, localParts)], 'tomorrow asked on its own');
});

test('fetchEnergyZero: one day per answer — tomorrow is asked for on its own and joined', async () => {
  const now = Date.now();
  const from = localMidnight(now);
  const tomorrow = localMidnight(now, undefined, 1);
  const to = localMidnight(now, undefined, 2);
  const fetchImpl = async (url) => (dateOf(url) === prices.ezDate(from, localParts) ? JSON.stringify(body(from, tomorrow)) : JSON.stringify(body(tomorrow, to)));
  const list = await prices.fetchEnergyZero(from, to, fetchImpl);
  assert.equal(list.length, (to - from) / Q);
  assert.ok(list.every((x, i) => i === 0 || x.start === list[i - 1].end), 'no holes, no doubles');
});

test('fetchEnergyZero: public API down — the old API still gives today; both down — the first error', async () => {
  const now = Date.now();
  const from = localMidnight(now);
  const to = localMidnight(now, undefined, 2);
  const old = { Prices: Array.from({ length: 24 }, (_, i) => ({ readingDate: new Date(from + i * H).toISOString(), price: 0.12 })) };
  const list = await prices.fetchEnergyZero(from, to, async (url) => {
    if (url.includes('public.api')) throw new Error('HTTP 503: down');
    return JSON.stringify(old);
  });
  assert.equal(list.length, 24);
  await assert.rejects(prices.fetchEnergyZero(from, to, async (url) => { throw new Error(url.includes('public.api') ? 'HTTP 503: down' : 'old gone'); }), /HTTP 503/);
});

test('refreshPrices (EnergyZero): tomorrow stored, per hour for the plan and per quarter for the chart', async () => {
  const settings = require('../src/wallboxSettings');
  const now = Date.now();
  const from = localMidnight(now);
  const to = localMidnight(now, undefined, 2);
  await settings.set('prices', { ...prices.DEFAULTS, source: 'energyzero', price_interval: 'hour', chart_interval: 'quarter', calibrate_loxone: false });
  await prices.refreshPrices(now, { fetchImpl: async () => JSON.stringify(body(localMidnight(now, undefined, -1), to)) });
  const rows = await prices.getPrices(new Date(from).toISOString(), new Date(to).toISOString());
  assert.equal(rows.length, (to - from) / H, 'every hour of today and tomorrow');
  assert.equal(rows[rows.length - 1].end_at, new Date(to).toISOString());
  assert.ok(rows.every((r) => r.allin_eur_kwh > 0));
  const qs = await prices.chartQuarters(new Date(to - 2 * H).toISOString(), new Date(to).toISOString());
  assert.equal(qs.length, 8, 'EnergyZero now gives the charts quarters too');
  const status = await settings.get('prices_status');
  assert.equal(status.ok, true);
  assert.equal(status.until, new Date(to).toISOString());
  assert.equal(await prices.pricesBehind(localMidnight(now, undefined, 0) + 14 * H), false, 'nothing missing: no extra checks');
});

test('pricesBehind: after 13:00 without tomorrow\'s prices — check every 15 minutes', async () => {
  const settings = require('../src/wallboxSettings');
  const now = Date.now();
  const from = localMidnight(now);
  const tomorrow = localMidnight(now, undefined, 1);
  await db.prepare('DELETE FROM energy_prices').run();
  await settings.set('prices', { ...prices.DEFAULTS, source: 'energyzero', calibrate_loxone: false });
  await prices.refreshPrices(now, { fetchImpl: async (url) => (url.includes('public.api') && dateOf(url) === prices.ezDate(from, localParts) ? JSON.stringify(body(from, tomorrow)) : notFound()) });
  assert.equal(await prices.pricesBehind(from + 10 * H), false, 'before 13:00 nothing is late');
  assert.equal(await prices.pricesBehind(from + 14 * H), true, 'after 13:00 tomorrow is late');
  await settings.set('prices', { ...prices.DEFAULTS, source: 'loxone' });
  assert.equal(await prices.pricesBehind(from + 14 * H), false, 'an estimate never waits for prices');
});

test('ENTSO-E without tomorrow (or failing): filled from EnergyZero, the problem stays visible', async () => {
  const now = Date.now();
  const from = localMidnight(now);
  const tomorrow = localMidnight(now, undefined, 1);
  const to = localMidnight(now, undefined, 2);
  const iso = (ms) => new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
  const pts = Array.from({ length: (tomorrow - from) / Q }, (_, i) => `<Point><position>${i + 1}</position><price.amount>${100 + i}</price.amount></Point>`).join('');
  const xml = `<Publication_MarketDocument><TimeSeries><Period><timeInterval><start>${iso(from)}</start><end>${iso(tomorrow)}</end></timeInterval><resolution>PT15M</resolution>${pts}</Period></TimeSeries></Publication_MarketDocument>`;
  const cfg = { ...prices.DEFAULTS, source: 'entsoe', entsoe_token: encrypt('test-token') };
  const ez = async (url) => {
    if (url.includes('entsoe')) return xml;
    return JSON.stringify(body(localMidnight(now, undefined, -1), to, () => 0.05));
  };
  const got = await prices.fetchMarketFilled(cfg, from, to, ez);
  assert.equal(got.market.length, (to - from) / Q);
  assert.equal(got.filled, 'energyzero');
  assert.equal(got.warning, null);
  assert.equal(got.market[0].market, 0.1, 'today from ENTSO-E');
  assert.equal(got.market[got.market.length - 1].market, 0.05, 'tomorrow from EnergyZero');
  // ENTSO-E refuses: everything from EnergyZero, with the reason
  const down = await prices.fetchMarketFilled(cfg, from, to, async (url) => (url.includes('entsoe') ? '<Acknowledgement_MarketDocument><text>Invalid token</text></Acknowledgement_MarketDocument>' : ez(url)));
  assert.equal(down.market.length, (to - from) / Q);
  assert.match(down.warning, /ENTSO-E: Invalid token/);
  // both down: the ENTSO-E error
  await assert.rejects(prices.fetchMarketFilled(cfg, from, to, async (url) => { throw new Error(url.includes('entsoe') ? 'HTTP 401: entsoe' : 'HTTP 503: ez'); }), /HTTP 401: entsoe/);
});
