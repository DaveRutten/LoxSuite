const test = require('node:test');
const assert = require('node:assert');
const { makePlan, withRest } = require('../src/planner');

const H = 3600000;
const t0 = Date.parse('2026-10-05T16:00:00Z'); // 18:00 local
const slots = [];
for (let i = 0; i < 36; i++) {
  const s = t0 + i * H;
  const hUtc = new Date(s).getUTCHours();
  const night = hUtc >= 0 && hUtc < 3;
  const sun = hUtc >= 9 && hUtc < 13;
  slots.push({ start: new Date(s).toISOString(), end: new Date(s + H).toISOString(), price: night ? 0.30 : sun ? 0.22 : 0.38, pvKw: sun ? 6 : 0 });
}

test('only the trip + reserve before leaving; the rest with the sun after it is back, never while away again', () => {
  const ready = Date.parse('2026-10-06T04:26:00Z');
  const back = Date.parse('2026-10-06T06:19:00Z');
  const args = { nowMs: t0, readyAtMs: ready, needKwh: 11.7, slots, mode: 'plan', minKw: 4.16, maxKw: 11, solarTrust: 'expected', priceCap: 0.72, insufficient: 'stop' };
  const must = makePlan(args);
  assert.ok(Math.abs(must.kwh - 11.7) < 0.05);
  const later = { title: 'Pick up', readyAtMs: Date.parse('2026-10-06T13:30:00Z'), kwh: 8.8 };
  const away2 = [Date.parse('2026-10-06T13:41:00Z'), Date.parse('2026-10-06T15:19:00Z')];
  const plan = withRest(must, args, slots, { mustKwh: 11.7, restKwh: 13.3, backAtMs: back, tripKwh: 8.8, reserveKwh: 3.9, title: 'Sev', away: [[Date.parse('2026-10-06T04:41:00Z'), back], away2], later: [later] }, ready);
  assert.ok(Math.abs(plan.kwh - 25) < 0.1, `planned ${plan.kwh}`);
  for (const s of plan.split.restSlots) {
    const a = Date.parse(s.start); const b = Date.parse(s.end);
    assert.ok(!(a < away2[1] && b > away2[0]), 'charging while away');
    assert.ok(!(a < back && a >= ready), 'charging during the first trip');
  }
  // the later trip's energy comes before it leaves, and the sun is used
  assert.ok(plan.split.later[0].kwh >= 8.7);
  assert.ok(plan.pvKwh > 5);
});
