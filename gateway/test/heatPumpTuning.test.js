// Tuning for long, calm runs with few defrosts (heatPumpTuning.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const tu = require('../src/heatPumpTuning');

const MIN = 60000;
const T0 = Date.parse('2026-11-01T00:00:00Z');

// n runs of runMin minutes, a defrost every defrostEvery minutes, at 1 °C and 95 % humidity
function sim(setting, { n, runMin, offMin, defrostEvery, elecKw, heatKw }, startMs = T0) {
  const out = [];
  let t = startMs;
  for (let r = 0; r < n; r++) {
    for (let m = 0; m < runMin; m++, t += MIN) out.push({ ms: t, running: true, defrost: defrostEvery && m % defrostEvery >= defrostEvery - 5, elecKw, heatKw, outdoorC: 1, rh: 95, ...setting });
    for (let m = 0; m < offMin; m++, t += MIN) out.push({ ms: t, running: false, defrost: false, elecKw: 0.02, heatKw: 0, outdoorC: 1, rh: 95, ...setting });
  }
  return out;
}

test('runs: one start to its stop, defrosts inside a run are counted, not a new run', () => {
  const rs = tu.runs(sim({ flowC: 35, step: 0, ntc: 0 }, { n: 3, runMin: 20, offMin: 10, defrostEvery: 10, elecKw: 2, heatKw: 5 }));
  assert.equal(rs.length, 3);
  assert.equal(rs[0].minutes, 20);
  assert.equal(rs[0].defrosts, 2);
});

test('learns per weather and setting; the calm setting wins: longer runs, fewer defrosts, better COP', () => {
  const hard = sim({ flowC: 35, step: 0, ntc: 0 }, { n: 6, runMin: 18, offMin: 12, defrostEvery: 12, elecKw: 2.0, heatKw: 4.8 });
  const calm = sim({ flowC: 33, step: 1, ntc: 0 }, { n: 4, runMin: 70, offMin: 5, defrostEvery: 60, elecKw: 1.3, heatKw: 3.9 }, T0 + 6 * 3600000);
  const model = tu.learn(tu.runs([...hard, ...calm]));
  const rows = Object.values(model);
  assert.equal(rows.length, 2);
  const h = rows.find((r) => r.setting.step === 0); const c = rows.find((r) => r.setting.step === 1);
  assert.ok(c.runMin > h.runMin && c.defrostPerH < h.defrostPerH && c.cop > h.cop);
  const pick = tu.choose(model, { outdoorC: 1.5, rh: 96, current: { flowC: 35, step: 0, ntc: 0 } });
  assert.deepEqual(pick.setting, { flowC: 33, step: 1, ntc: 0 });
  assert.match(pick.why, /best known/);
});

test('defrosting a lot and nothing known about calmer: tries one step calmer — but not while the room is behind', () => {
  const hard = sim({ flowC: 35, step: 0, ntc: 0 }, { n: 6, runMin: 20, offMin: 10, defrostEvery: 20, elecKw: 2.0, heatKw: 4.8 });
  const model = tu.learn(tu.runs(hard));
  const pick = tu.choose(model, { outdoorC: 1, rh: 95, current: { flowC: 35, step: 0, ntc: 0 } });
  assert.deepEqual(pick.setting, { flowC: 35, step: 1, ntc: 0 });
  assert.match(pick.why, /calmer/);
  const cold = tu.choose(model, { outdoorC: 1, rh: 95, current: { flowC: 35, step: 0, ntc: 0 }, roomBehindC: 1 });
  assert.deepEqual(cold.setting, { flowC: 35, step: 0, ntc: 0 }, 'comfort first');
});
