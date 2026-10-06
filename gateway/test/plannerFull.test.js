// v0.42 "full again before it is needed": the situation of 6 October — plugged in at 15:00 with 15.3 of
// 25.7 kWh, a trip from 15:41 to 17:19 (8.8 kWh) and the usual departure on Wednesday at 05:30. The plan
// stopped at 15:00 and put 10.4 kWh at Wednesday 13:00: too little (the trip uses 8.8 kWh too) and at a
// time the car is away.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePlan, planSplit, withRest, mergeTrips, planWithBuffer, freeOf } = require('../src/planner');

const H = 3600000;
const T = (iso) => Date.parse(iso);
// local = UTC+2. Prices per local hour from Tue 14:00 (the screenshot), solar around Wed 13:00.
const PRICE = { 14: 0.21, 15: 0.26, 16: 0.30, 17: 0.35, 18: 0.40, 19: 0.43, 20: 0.41, 21: 0.37, 22: 0.35, 23: 0.33, 0: 0.32, 1: 0.32, 2: 0.31, 3: 0.32, 4: 0.31, 5: 0.32, 6: 0.34, 7: 0.38, 8: 0.37, 9: 0.34, 10: 0.31, 11: 0.27, 12: 0.22, 13: 0.20, 14.5: 0.21 };
function slotsFrom(startIso, hours) {
  const out = [];
  for (let i = 0; i < hours; i++) {
    const s = T(startIso) + i * H;
    const local = (new Date(s).getUTCHours() + 2) % 24;
    const wed = s >= T('2026-10-06T22:00:00Z');
    const price = wed && local === 14 ? 0.21 : PRICE[local];
    out.push({ start: new Date(s).toISOString(), end: new Date(s + H).toISOString(), price, pvKw: wed && local >= 11 && local <= 15 ? 5 : 0 });
  }
  return out;
}
const slots = slotsFrom('2026-10-06T12:00:00Z', 30); // Tue 14:00 .. Wed 20:00 local
const now = T('2026-10-06T13:00:00Z'); // Tue 15:00
const ready = T('2026-10-06T13:41:00Z'); // 15:41
const back = T('2026-10-06T15:19:00Z'); // 17:19
const wedLeave = T('2026-10-07T03:30:00Z'); // Wed 05:30
const args = { nowMs: now, readyAtMs: ready, slots, mode: 'plan', minKw: 4.16, maxKw: 11, solarTrust: 'expected', priceCap: 0.578, insufficient: 'stop', feedIn: 'saldering', earlyValue: 0.03 };

test('after a trip: full again — the trip\'s own kWh count, and before leaving no more than still fits', () => {
  const split = planSplit({ needKwh: 10.4, batteryKwh: 25.7, soc: 59.5, reservePct: 0, readyAtMs: ready, trip: { kwh: 8.8, leaveMs: ready, backAtMs: back, title: 'Sev' }, energyNowKwh: 15.3 });
  assert.equal(split.mustKwh, 0);
  assert.equal(split.preMaxKwh, 10.4);
  assert.ok(Math.abs(split.energyAfterKwh - 6.5) < 0.01);
  assert.ok(Math.abs(split.restKwh - 19.2) < 0.01, `rest ${split.restKwh}`);
});

test('the rest is ready before the next departure: not on Wednesday 13:00 when it leaves at 05:30, and now is used', () => {
  const split = planSplit({ needKwh: 10.4, batteryKwh: 25.7, soc: 59.5, reservePct: 0, readyAtMs: ready, trip: { kwh: 8.8, leaveMs: ready, backAtMs: back, title: 'Sev' }, energyNowKwh: 15.3 });
  split.restByMs = wedLeave;
  const plan = withRest(makePlan({ ...args, needKwh: split.mustKwh }), { ...args, needKwh: 0 }, slots, split, ready);
  assert.ok(Math.abs(plan.kwh - 19.2) < 0.1, `planned ${plan.kwh}`);
  for (const s of plan.slots) assert.ok(Date.parse(s.end) <= wedLeave, `after the departure: ${s.start}`);
  for (const s of plan.slots) assert.ok(!(Date.parse(s.start) < back && Date.parse(s.end) > ready), `while away: ${s.start}`);
  // 15:00 (€0.26) is cheaper than every night hour (€0.31+): it charges now, before leaving
  const before = plan.slots.filter((s) => Date.parse(s.start) < ready).reduce((a, s) => a + s.kwh, 0);
  assert.ok(before > 5, `charged before leaving ${before}`);
  assert.ok(before <= 10.45, 'no more than fits before leaving');
  assert.equal(plan.split.restBy, new Date(wedLeave).toISOString());
});

test('without a known next departure the rest may use the sun the next day (24 hours after it is back)', () => {
  const split = planSplit({ needKwh: 10.4, batteryKwh: 25.7, soc: 59.5, reservePct: 0, readyAtMs: ready, trip: { kwh: 8.8, leaveMs: ready, backAtMs: back, title: 'Sev' }, energyNowKwh: 15.3 });
  const plan = withRest(makePlan({ ...args, needKwh: 0, earlyValue: 0 }), { ...args, earlyValue: 0 }, slots, split, ready);
  assert.ok(plan.slots.some((s) => s.start.startsWith('2026-10-07T11')), 'Wednesday 13:00 with the sun');
});

test('a little dearer now is worth it: earlyValue takes the earlier hour unless the later one is clearly cheaper', () => {
  const two = [
    { start: '2026-10-06T13:00:00Z', end: '2026-10-06T14:00:00Z', price: 0.26, pvKw: 0 },
    { start: '2026-10-07T09:00:00Z', end: '2026-10-07T10:00:00Z', price: 0.245, pvKw: 0 },
  ];
  const base = { nowMs: now, needKwh: 5, slots: two, mode: 'plan', minKw: 4.16, maxKw: 11, readyAtMs: T('2026-10-07T12:00:00Z') };
  assert.ok(makePlan({ ...base, earlyValue: 0 }).slots[0].start.startsWith('2026-10-07'), 'cheapest when earlier is worth nothing');
  assert.ok(makePlan({ ...base, earlyValue: 0.03 }).slots[0].start.startsWith('2026-10-06'), 'now, 1.5 ct dearer but 20 h earlier');
  assert.ok(makePlan({ ...base, earlyValue: 0.03, slots: [two[0], { ...two[1], price: 0.20 }] }).slots[0].start.startsWith('2026-10-07'), 'later when it is clearly cheaper');
});

test('ready for the unexpected: the buffer comes within a few hours, the rest in the cheapest hours', () => {
  // home at 18:00 with little in the battery, the cheapest hours at night
  const s2 = slotsFrom('2026-10-06T16:00:00Z', 14);
  const plan = planWithBuffer({ args: { ...args, nowMs: T('2026-10-06T16:00:00Z'), readyAtMs: wedLeave, needKwh: 20, slots: s2, earlyValue: 0 }, slots: s2, untilMs: wedLeave, startMs: T('2026-10-06T16:00:00Z'), bufferKwh: 4, bufferH: 3, bufferKm: 40 });
  assert.ok(plan.buffer && Math.abs(plan.buffer.kwh - 4) < 0.05);
  for (const s of plan.buffer.slots) assert.ok(Date.parse(s.end) <= T('2026-10-06T19:00:00Z'), `buffer too late: ${s.start}`);
  assert.ok(Math.abs(plan.kwh - 20) < 0.1, `total ${plan.kwh}`);
  // no interval is used twice
  const used = plan.slots.map((s) => [Date.parse(s.start), Date.parse(s.end)]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < used.length; i++) assert.ok(used[i][0] >= used[i - 1][1] - 1000, 'overlapping intervals');
});

test('freeOf keeps what is left of a partly used hour', () => {
  const s = [{ start: '2026-10-06T13:00:00Z', end: '2026-10-06T14:00:00Z', price: 0.3 }];
  const f = freeOf(s, [{ start: '2026-10-06T13:00:00Z', end: '2026-10-06T13:20:00Z' }]);
  assert.equal(f.length, 1);
  assert.equal(f[0].start, '2026-10-06T13:20:00.000Z');
});

test('appointments right after each other are one trip (no charging at home in between)', () => {
  const first = { kwh: 8.8, leaveMs: ready, backAtMs: back, title: 'Sev' };
  const m = mergeTrips(first, [
    { kwh: 12, leaveMs: T('2026-10-06T15:00:00Z'), backAtMs: T('2026-10-06T17:30:00Z'), title: 'Evening' }, // starts before it is back
    { kwh: 5, leaveMs: T('2026-10-07T05:00:00Z'), backAtMs: T('2026-10-07T06:00:00Z'), title: 'Tomorrow' }, // a day later: separate
  ]);
  assert.equal(m.kwh, 20.8);
  assert.equal(m.backAtMs, T('2026-10-06T17:30:00Z'));
  assert.equal(m.merged, 1);
});
