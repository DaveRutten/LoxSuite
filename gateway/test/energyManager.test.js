const { test } = require('node:test');
const assert = require('node:assert/strict');
const em = require('../src/energyManager');

const T0 = Date.parse('2026-10-05T00:00:00Z');
const H = 3600000;
const localOf = (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), hour: new Date(ms).getUTCHours() });
// 24 hours: expensive evening, cheap night, solar 11-15h.
const hours = Array.from({ length: 24 }, (_, i) => ({
  ms: T0 + i * H, hour: new Date(T0 + i * H).toISOString(),
  price: i >= 17 && i <= 20 ? 0.40 : i <= 5 ? 0.18 : 0.26,
  surplusKwh: i >= 11 && i <= 14 ? 3 : 0,
}));

test('toHours averages quarter-hour prices and fills unknown prices with the median', () => {
  const h = em.toHours([
    { start: '2026-10-05T10:00:00Z', end: '2026-10-05T10:15:00Z', price: 0.2, pvKw: 1 },
    { start: '2026-10-05T10:15:00Z', end: '2026-10-05T10:30:00Z', price: 0.3, pvKw: 1 },
    { start: '2026-10-05T11:00:00Z', end: '2026-10-05T12:00:00Z', price: null, pvKw: 0 },
  ]);
  assert.equal(h.length, 2);
  assert.equal(h[0].price, 0.25);
  assert.equal(h[1].estimated, true);
  assert.equal(h[1].price, 0.25);
});

test('tap water goes to the solar block; with a fixed feed-in the surplus is cheapest', () => {
  const plan = em.planLoads({
    hours, nowMs: T0, localOf, feedIn: 'fixed', feedInEur: 0.05,
    loads: [{ id: 1, kind: 'dhw', name: 'Tapwater', priority: 1, settings: { ...em.KINDS.dhw.defaults, kw: 2.5, duration_h: 1, earliest: 0, latest: 24 } }],
  });
  const on = plan.loads[0].hours.filter((h) => h.values.now === 1);
  assert.equal(on.length, 1);
  assert.ok(new Date(on[0].ms).getUTCHours() >= 11 && new Date(on[0].ms).getUTCHours() <= 14);
  assert.equal(on[0].values.setpoint, 58);
  assert.match(on[0].reason, /solar/);
});

test('the car at a higher priority takes the surplus first', () => {
  const carKwh = Object.fromEntries([11, 12, 13, 14].map((h) => [T0 + h * H, 3]));
  const plan = em.planLoads({
    hours, nowMs: T0, localOf, feedIn: 'fixed', feedInEur: 0.05, carKwh, carPriority: 1,
    loads: [{ id: 1, kind: 'dhw', name: 'Tapwater', priority: 2, settings: { ...em.KINDS.dhw.defaults, earliest: 0, latest: 24 } }],
  });
  const on = plan.loads[0].hours.find((h) => h.values.now === 1);
  assert.ok(new Date(on.ms).getUTCHours() <= 5, 'falls back to a cheap night hour');
  assert.match(on.reason, /cheapest/);
});

test('heat pump: released in cheap and solar hours, never blocked longer than max_block_h, eases off in expensive hours', () => {
  const plan = em.planLoads({
    hours, nowMs: T0, localOf, feedIn: 'fixed', feedInEur: 0.05,
    loads: [{ id: 2, kind: 'heatpump', name: 'WP', priority: 3, settings: { ...em.KINDS.heatpump.defaults, release_share: 0.4, max_block_h: 2 } }],
  });
  const rows = plan.loads[0].hours;
  let run = 0; let maxRun = 0;
  for (const r of rows) { run = r.values.release ? 0 : run + 1; maxRun = Math.max(maxRun, run); }
  assert.ok(maxRun <= 2, `longest block ${maxRun}`);
  for (const h of [11, 12, 13, 14]) assert.equal(rows[h].values.release, 1);
  assert.equal(rows[12].values.correction, 1);
  assert.equal(rows[18].values.correction, -0.5);
  assert.equal(rows[2].values.correction, 1); // cheap night: pre-heat
});

test('heat pump in cooling season pre-cools (negative correction) in solar hours', () => {
  const plan = em.planLoads({ hours, nowMs: T0, localOf, loads: [{ id: 2, kind: 'heatpump', name: 'WP', priority: 3, settings: { ...em.KINDS.heatpump.defaults, season: 'cooling' } }] });
  assert.equal(plan.loads[0].hours[12].values.correction, -1);
});

test('appliance request: best start before ready-by', () => {
  const plan = em.planLoads({
    hours, nowMs: T0 + 7 * H, localOf, feedIn: 'fixed', feedInEur: 0.05,
    loads: [{ id: 3, kind: 'appliance', name: 'Wasmachine', priority: 4, settings: { kw: 1 }, requests: [{ id: 9, readyBy: T0 + 17 * H, kwh: 1.2, durationH: 2, label: '40°' }] }],
  });
  const q = plan.loads[0].requests[0];
  assert.ok(q.plannedStart >= T0 + 11 * H && q.plannedStart <= T0 + 13 * H, new Date(q.plannedStart).toISOString());
  assert.equal(plan.loads[0].hours.filter((h) => h.values.start === 1).length, 1);
});

test('shadow signals now: live solar override for tap water', () => {
  const plan = { loads: [{ id: 1, kind: 'dhw', hours: [{ ms: T0, values: { now: 0, setpoint: 52 }, reason: 'x' }] }] };
  const sig = em.currentSignals(plan, T0 + 60000, { exportKw: 4, loadsById: { 1: { settings: { kw: 2.5, buffer_setpoint: 58 } } } });
  assert.equal(sig[0].values.now, 1);
  assert.equal(sig[0].values.setpoint, 58);
  assert.match(sig[0].reason, /solar surplus now/);
});

test('appliance run detection: start, short pause, end after 10 min idle', () => {
  let st = {};
  const feed = [[0, 0.002, 100], [1, 1.8, 100.03], [30, 0.01, 100.6], [33, 0.5, 100.62], [60, 0.005, 101.1], [69, 0.004, 101.1], [71, 0.004, 101.1]];
  let done = null;
  for (const [min, kw, total] of feed) { const r = em.runStep(st, kw, total, min * 60000); st = r.state; if (r.finished) done = r.finished; }
  assert.ok(done);
  assert.equal(done.start, 60000);
  assert.equal(done.end, 3600000);
  assert.equal(done.kwh, 1.07);
});

test('hour cost: grid share at the price, solar share at its value', () => {
  assert.equal(em.hourCost(1, { gridImport: 0.5, houseKwh: 2, price: 0.3, solarValue: 0.05 }), 0.25 * 0.3 + 0.75 * 0.05);
  assert.equal(em.hourCost(1, { price: null }), null);
});

test('learned pattern: tap water hot before its usual use (shower ~07:00 → night block, not the solar block)', () => {
  const patterns = [{ type: 'daily', from: 7, to: 8, probability: 0.9, kwh: 2 }];
  const plan = em.planLoads({
    hours, nowMs: T0, localOf, feedIn: 'fixed', feedInEur: 0.05,
    loads: [{ id: 1, kind: 'dhw', name: 'Tapwater', priority: 1, patterns, settings: { ...em.KINDS.dhw.defaults, kw: 2.5, duration_h: 1, earliest: 0, latest: 24 } }],
  });
  const on = plan.loads[0].hours.filter((h) => h.values.now === 1);
  assert.equal(on.length, 1);
  assert.ok(new Date(on[0].ms).getUTCHours() < 7);
  assert.match(on[0].reason, /hot before the usual use ~07:00/);
  // Switched off in the settings: back to the solar block.
  const off = em.planLoads({ hours, nowMs: T0, localOf, feedIn: 'fixed', feedInEur: 0.05,
    loads: [{ id: 1, kind: 'dhw', name: 'Tapwater', priority: 1, patterns, settings: { ...em.KINDS.dhw.defaults, kw: 2.5, earliest: 0, latest: 24, use_patterns: false } }] });
  assert.ok(new Date(off.loads[0].hours.find((h) => h.values.now === 1).ms).getUTCHours() >= 11);
});

test('learned pattern: an appliance\'s usual run (09:00) gets the best start from then on (solar at 11)', () => {
  const lo = (ms) => ({ ...localOf(ms), minute: new Date(ms).getUTCMinutes(), weekday: (new Date(ms).getUTCDay() + 6) % 7 });
  const plan = em.planLoads({
    hours, nowMs: T0, localOf: lo, feedIn: 'fixed', feedInEur: 0.05,
    loads: [{ id: 3, kind: 'appliance', name: 'Wasmachine', priority: 2, settings: { ...em.KINDS.appliance.defaults, flex_h: 8 },
      patterns: [{ type: 'run', weekday: null, hour: 9, minute: 0, durationH: 2, kwh: 1.2, count: 5, of: 7 }] }],
  });
  const q = plan.loads[0].requests[0];
  assert.equal(q.expected, true);
  assert.equal(new Date(q.usualStart).getUTCHours(), 9);
  assert.equal(new Date(q.plannedStart).getUTCHours(), 11);
  assert.match(plan.loads[0].hours.find((h) => h.values.start === 1).reason, /usual run/);
});
