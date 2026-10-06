// Regression tests against a real (in-memory) database: repeating appointments and "car needed" for
// the series, calendar names with "&", Smart charging starting now when prices are missing, and the
// Loxone price source giving every hour a price.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb, db } = require('./helpers/testDb');

const H = 3600000;
let calId;

before(async () => {
  await initTestDb();
  const now = new Date().toISOString();
  calId = await db.insertReturningId('INSERT INTO calendars (name, url, color, enabled, created_at) VALUES (?, ?, ?, 1, ?)', ['Dave &amp; Elly', 'x', '#66dd33', now]);
  const base = Date.now() + 2 * 86400000;
  for (let w = 0; w < 3; w++) {
    const s = new Date(base + w * 7 * 86400000);
    await db.upsert('calendar_events', { calendar_id: calId, uid: 'series@test', start_at: s.toISOString(), end_at: new Date(s.getTime() + H).toISOString(), all_day: 0, title: 'Hockey', location: null, car_tag: 0, car_hint: null }, ['calendar_id', 'uid', 'start_at']);
  }
  await db.upsert('calendar_events', { calendar_id: calId, uid: 'single@test', start_at: new Date(base + 3 * H).toISOString(), end_at: new Date(base + 4 * H).toISOString(), all_day: 0, title: 'Dentist', location: null, car_tag: 0, car_hint: null }, ['calendar_id', 'uid', 'start_at']);
});

after(async () => { await db.close(); });

const range = () => [new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString()];

test('calendar names: "&amp;" is shown as "&"', async () => {
  const agenda = require('../src/agenda');
  const cals = await agenda.listCalendars();
  assert.equal(cals.find((c) => c.id === calId).name, 'Dave & Elly');
  const items = await agenda.items(...range());
  assert.ok(items.every((i) => i.calendar !== 'Dave &amp; Elly'));
});

test('repeating appointment: marked as such; car needed for the whole series, a day of its own wins', async () => {
  const agenda = require('../src/agenda');
  let items = (await agenda.items(...range())).filter((i) => i.uid === 'series@test');
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => i.recurring), 'should be marked recurring');
  const single = (await agenda.items(...range())).find((i) => i.uid === 'single@test');
  assert.equal(single.recurring, false);

  await agenda.setOverride({ calendar_id: calId, uid: 'series@test', start_at: items[0].start, needs_car: '1', scope: 'series' });
  items = (await agenda.items(...range())).filter((i) => i.uid === 'series@test');
  assert.deepEqual(items.map((i) => [i.needsCar, i.carSource]), [[true, 'series'], [true, 'series'], [true, 'series']]);

  await agenda.setOverride({ calendar_id: calId, uid: 'series@test', start_at: items[1].start, needs_car: '0' });
  items = (await agenda.items(...range())).filter((i) => i.uid === 'series@test');
  assert.deepEqual(items.map((i) => i.needsCar), [true, false, true]);

  // choosing for the series again clears the day's own choice
  await agenda.setOverride({ calendar_id: calId, uid: 'series@test', start_at: items[0].start, needs_car: '0', scope: 'series' });
  items = (await agenda.items(...range())).filter((i) => i.uid === 'series@test');
  assert.deepEqual(items.map((i) => i.needsCar), [false, false, false]);
});

test('smart charging: with today\'s prices missing the slots still start now, and the gap is reported', async () => {
  const planner = require('../src/planner');
  const now = Math.floor(Date.now() / H) * H + 10 * 60000;
  const h0 = Math.floor(now / H) * H;
  // prices only from 6 hours ahead (like the reported "starts at midnight")
  for (let i = 6; i < 10; i++) {
    await db.upsert('energy_prices', { start_at: new Date(h0 + i * H).toISOString(), end_at: new Date(h0 + (i + 1) * H).toISOString(), market_eur_kwh: 0.1, allin_eur_kwh: 0.3, source: 'test', fetched_at: new Date().toISOString() }, ['start_at']);
  }
  const slots = await planner.buildSlots(now, h0 + 10 * H);
  assert.equal(Date.parse(slots[0].start), h0, 'the first slot is the current hour');
  for (let i = 1; i < slots.length; i++) assert.ok(Date.parse(slots[i].start) >= Date.parse(slots[i - 1].start), 'sorted');
  assert.equal(slots.filter((s) => s.price === null).length, 6);
  assert.equal(slots.priceGapFrom, h0);
});

test('prices from Loxone: every hour gets a price, also hours without samples', async () => {
  const settings = require('../src/wallboxSettings');
  const prices = require('../src/prices');
  await settings.set('prices', { ...prices.DEFAULTS, source: 'loxone' });
  const day = Date.now() - 86400000;
  // samples only for three hours of the day
  await settings.set('price_samples', [0, 1, 2].map((h) => ({ start: new Date(Math.floor(day / H) * H + h * H).toISOString(), loxone: 0.25 + h / 100, market: null })));
  const r = await prices.refreshPrices(Date.now());
  assert.ok(r.count >= 46, `only ${r.count} intervals`);
  const rows = await db.prepare('SELECT allin_eur_kwh FROM energy_prices WHERE source = ?').all('loxone');
  assert.ok(rows.length >= 46);
  assert.ok(rows.every((x) => x.allin_eur_kwh !== null && x.allin_eur_kwh > 0));
});

test('quarter prices: the charts can show quarters while the plan keeps hours', async () => {
  const settings = require('../src/wallboxSettings');
  const prices = require('../src/prices');
  const { localMidnight } = require('../src/localTime');
  const from = localMidnight(Date.now());
  const Q = 900000;
  // a source that delivers quarters (ENTSO-E does; faked here through the EnergyZero parser)
  const body = { Prices: Array.from({ length: 8 }, (_, i) => ({ readingDate: new Date(from + i * Q).toISOString(), price: 0.1 + i / 100 })) };
  const fetchImpl = async () => JSON.stringify(body);
  await settings.set('prices', { ...prices.DEFAULTS, source: 'energyzero', price_interval: 'hour', chart_interval: 'quarter' });
  await prices.refreshPrices(Date.now(), { fetchImpl });
  const rows = await prices.getPrices(new Date(from).toISOString(), new Date(from + 2 * H).toISOString());
  assert.equal(rows.length, 2, 'the plan gets hours (what the contract bills)');
  const qs = await prices.chartQuarters(new Date(from).toISOString(), new Date(from + 2 * H).toISOString());
  assert.equal(qs.length, 8, 'the chart gets the quarters');
  assert.ok(qs[1].price > qs[0].price);
  await settings.set('prices', { ...prices.DEFAULTS, source: 'energyzero', price_interval: 'hour', chart_interval: 'hour' });
  assert.equal(await prices.chartQuarters(new Date(from).toISOString(), new Date(from + 2 * H).toISOString()), null, 'hours chosen: no quarters');
});
