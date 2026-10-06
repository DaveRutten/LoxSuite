// The learning loop: predictions written down next to what happened, corrections from that, newer
// data counting more, a change in use noticed, departures with a chosen certainty, and patterns you
// marked as "not right".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb, db } = require('./helpers/testDb');
const flog = require('../src/forecastLog');
const learning = require('../src/learning');
const ep = require('../src/energyPatterns');

const H = 3600000;

test('horizon: an hour ahead, the day before, or nothing', () => {
  const now = Date.parse('2026-10-06T10:10:00Z');
  assert.equal(flog.horizonFor(Date.parse('2026-10-06T11:00:00Z'), now), 'h1');
  assert.equal(flog.horizonFor(Date.parse('2026-10-07T08:00:00Z'), now), 'd1');
  assert.equal(flog.horizonFor(Date.parse('2026-10-06T15:00:00Z'), now), null);
});

test('accuracy: average error, share, direction and the factor', () => {
  const s = flog.summarize([{ predicted: 1, actual: 1.2 }, { predicted: 2, actual: 2.4 }, { predicted: 0, actual: 0 }]);
  assert.equal(s.n, 3);
  assert.equal(s.factor, 1.2);
  assert.ok(s.bias < 0, 'predicted too low');
  const e = flog.summarize([{ predicted: 0, actual: -10 * 60000 }, { predicted: 0, actual: 5 * 60000 }, { predicted: 0, actual: 0 }], { event: true });
  assert.equal(e.onTime, 0.67);
  assert.equal(e.maeMin, 5);
});

test('corrections: house and consumers scaled within limits, departures earlier when it often left too early', () => {
  const c = flog.correctionsFrom({
    house: { n: 100, factor: 1.6, predicted: 50 }, loads: { 3: { n: 60, factor: 0.9, predicted: 20 }, 4: { n: 10, factor: 2, predicted: 5 } },
    depart: { n: 10, onTime: 0.7, earlyP90Min: 23 },
  });
  assert.equal(c.houseFactor, 1.33);
  assert.deepEqual(c.loadFactors, { 3: 0.9 });
  assert.equal(c.departShiftMin, 25);
  assert.deepEqual(flog.correctionsFrom({}), { houseFactor: 1, loadFactors: {}, departShiftMin: 0 });
});

test('newer data counts more: weighted quantile and recency weight', () => {
  assert.equal(learning.weightedQuantile([1, 2, 3], [1, 1, 1], 0.5), 2);
  assert.equal(learning.weightedQuantile([1, 2, 10], [0.1, 0.1, 5], 0.5), 10);
  const now = Date.parse('2026-10-06T00:00:00Z');
  assert.equal(learning.recencyWeight(now - 10 * 86400000, now, 10), 0.5);
});

test('a change in daily use is noticed (last week against the three before)', () => {
  const days = (n, kwh, start) => Array.from({ length: n }, (_, i) => ({ day: `2026-09-${String(start + i).padStart(2, '0')}`, kwh }));
  assert.equal(learning.detectChange([...days(21, 10, 1), ...days(7, 14, 22)]).changed, true);
  assert.equal(learning.detectChange([...days(21, 10, 1), ...days(7, 11, 22)]).changed, false);
  assert.equal(learning.detectChange(days(10, 10, 1)).changed, false);
});

test('departures: the chosen certainty decides how early the car is ready', () => {
  // ten Mondays: leaving between 07:00 and 07:45
  const tz = 'UTC';
  const base = Date.parse('2026-06-01T00:00:00Z'); // a Monday
  const sessions = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45].map((m, i) => ({ connect: base + i * 7 * 86400000 - 10 * H, disconnect: base + i * 7 * 86400000 + (7 * 60 + m) * 60000, kwh: 5 }));
  const now = base + 70 * 86400000;
  const safe = learning.departureStats(sessions, { tz, nowMs: now, certainty: 'safe', halfLifeDays: 1e6 })[0];
  const normal = learning.departureStats(sessions, { tz, nowMs: now, certainty: 'normal', halfLifeDays: 1e6 })[0];
  const relaxed = learning.departureStats(sessions, { tz, nowMs: now, certainty: 'relaxed', halfLifeDays: 1e6 })[0];
  const m = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  assert.ok(m(safe.ready) < m(normal.ready) && m(normal.ready) < m(relaxed.ready), `${safe.ready} ${normal.ready} ${relaxed.ready}`);
});

test('patterns have a stable key (for "not right")', () => {
  assert.equal(ep.patternKey({ type: 'daily', from: 7 }), 'daily:*:7');
  assert.equal(ep.patternKey({ type: 'run', weekday: 2, hour: 10 }), 'run:2:10');
});

// ------------------------------------------------------------------ against a real database

before(async () => { await initTestDb(); });
after(async () => { await db.close(); });

test('recording and filling in: house predictions next to the meters, and the correction that follows', async () => {
  const now = Date.parse('2026-10-06T12:10:00Z');
  // 60 hours in the past, predicted 0.5 kWh, really 0.6 kWh
  for (let i = 2; i < 62; i++) {
    const hour = new Date(Math.floor(now / H) * H - i * H).toISOString();
    await db.upsert('forecast_log', { kind: 'house', target: hour, horizon: 'd1', predicted: 0.5, actual: null, made_at: new Date(now - (i + 24) * H).toISOString(), note: null }, ['kind', 'target', 'horizon']);
    await db.upsert('energy_hourly', { role: 'house', hour, import_kwh: 0.6, export_kwh: 0, source: 'live' }, ['role', 'hour']);
  }
  const filled = await flog.fillActuals(now);
  assert.ok(filled >= 60, `filled ${filled}`);
  flog.resetCache();
  const c = await flog.corrections(now, { fresh: true });
  assert.equal(c.houseFactor, 1.2);
  const s = await flog.summary(now);
  assert.equal(s.house.d1.factor, 1.2);
  // the planner's slots are written down once per hour and horizon
  const slots = [{ start: new Date(Math.floor(now / H) * H + H).toISOString(), pvKwh: 1.1, houseKwh: 0.4 }];
  await flog.recordSlots(slots, now);
  await flog.recordSlots([{ ...slots[0], pvKwh: 9 }], now + 60000);
  const pv = await db.prepare("SELECT predicted FROM forecast_log WHERE kind = 'pv' AND horizon = 'h1'").all();
  assert.deepEqual(pv.map((r) => r.predicted), [1.1]);
});

test('the car: departures and homecomings recorded as events', async () => {
  const t = Date.parse('2026-10-06T06:30:00Z');
  assert.equal(await flog.recordEvent('depart', t, t - 12 * 60000), true);
  assert.equal(await flog.recordEvent('depart', t, t + 9 * H), false, 'too far apart to be the same departure');
  const rows = await db.prepare("SELECT predicted, actual FROM forecast_log WHERE kind = 'depart'").all();
  assert.equal(rows.length, 1);
  assert.equal((rows[0].actual - rows[0].predicted) / 60000, -12);
});
