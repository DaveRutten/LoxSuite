// The weather side of the heat pump: defrosting and COP by outdoor temperature and humidity
// (heatPumpWeather.js), and how long the room takes to warm up by the outdoor temperature (roomWarmup.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const hw = require('../src/heatPumpWeather');
const rw = require('../src/roomWarmup');

const HOUR = 3600000;
const MIN = 60000;

test('start curve: an air source heat pump does worse in the cold, defrosts around freezing in damp air', () => {
  const mild = hw.defaults('air', 10, 70);
  const cold = hw.defaults('air', -5, 70);
  const foggy = hw.defaults('air', 1, 98);
  assert.ok(mild.cop > cold.cop);
  assert.equal(mild.defrost, 0);
  assert.ok(foggy.defrost > 0.1, `foggy ${foggy.defrost}`);
  assert.ok(foggy.cop < hw.defaults('air', 1, 60).cop);
  assert.deepEqual(hw.defaults('ground', -5, 99), { cop: 4.2, defrost: 0 }, 'ground source: the weather hardly matters');
});

test('learns defrosting and COP per temperature and humidity, and plans with it', () => {
  const s = [];
  for (let i = 0; i < 240; i++) s.push({ outdoorC: 1, rh: 95, defrost: i % 5 === 0, elecKw: 1.5, heatKw: i % 5 === 0 ? 0 : 3.6 });
  for (let i = 0; i < 240; i++) s.push({ outdoorC: 9, rh: 70, defrost: false, elecKw: 1.2, heatKw: 4.1 });
  const m = hw.learn(s);
  assert.equal(m.bins['0|wet'].defrost, 0.2);
  assert.equal(m.bins['0|wet'].cop, 1.92);
  const foggyNight = hw.expect(m, { source: 'air', outdoorC: 0.5, rh: 96 });
  const mildAfternoon = hw.expect(m, { source: 'air', outdoorC: 9.5, rh: 65 });
  assert.equal(foggyNight.learned, true);
  // the night is cheaper per kWh of power, but not per kWh of heat
  assert.ok(hw.costPerHeat(0.18, foggyNight) > hw.costPerHeat(0.24, mildAfternoon), `${hw.costPerHeat(0.18, foggyNight)} vs ${hw.costPerHeat(0.24, mildAfternoon)}`);
  // water / water: no defrosting, whatever was seen
  assert.equal(hw.expect(m, { source: 'water', outdoorC: 0.5, rh: 96 }).defrost, 0);
});

// a room that warms up 1 °C/h at 10 °C outside and 0.4 °C/h at 0 °C, heating 06:00-08:00 every day
function roomSamples(days) {
  const out = [];
  const T0 = Date.parse('2026-10-01T00:00:00Z');
  for (let d = 0; d < days; d++) {
    const outdoorC = d % 2 ? 10.5 : 0.5;
    const r = outdoorC > 5 ? 1 : 0.4;
    let room = 18;
    for (let m = 0; m < 24 * 60; m++) {
      const ms = T0 + d * 24 * HOUR + m * MIN;
      const heating = m >= 360 && m < 480;
      room += heating ? r / 60 : -0.1 / 60;
      out.push({ ms, roomC: Math.round(room * 100) / 100, outdoorC, heating });
    }
  }
  return out;
}

test('learns how fast the room warms up, per outdoor temperature', () => {
  const m = rw.learn(roomSamples(8));
  assert.equal(m.bins[10].rate, 1);
  assert.equal(m.bins[0].rate, 0.4);
  assert.ok(m.line.b > 0, 'warmer outside, faster');
  assert.equal(rw.rate(m, 4.9).learned, true, 'between two bins: the line');
  assert.equal(rw.warmupHours(m, { fromC: 19, toC: 20.5, outdoorC: 0.5 }), 3.75);
  assert.equal(rw.warmupHours(m, { fromC: 19, toC: 20.5, outdoorC: 10.5 }), 1.5);
});

test('pre-heat: starts earlier on a cold morning than on a mild one', () => {
  const m = rw.learn(roomSamples(8));
  const at = Date.parse('2026-10-10T05:00:00Z'); // 07:00 local
  const cold = rw.preheat(m, { atMs: at, nowMs: at - 12 * HOUR, fromC: 19, comfortC: 20.5, outdoorAt: () => 0.5 });
  const mild = rw.preheat(m, { atMs: at, nowMs: at - 12 * HOUR, fromC: 19, comfortC: 20.5, outdoorAt: () => 10.5 });
  assert.equal(cold.hours, 4); // 3.75 h + 15 min margin
  assert.equal(mild.hours, 1.75);
  assert.equal(rw.preheat(m, { atMs: at, nowMs: at, fromC: 21, comfortC: 20.5 }).hours, 0);
});

test('what each power-limit step and NTC setting does, per outdoor temperature', () => {
  const s = [];
  for (let i = 0; i < 120; i++) s.push({ outdoorC: 3, step: hw.stepOf(0, 0), ntc: 0, elecKw: 2.0, heatKw: 5.4 });
  for (let i = 0; i < 120; i++) s.push({ outdoorC: 3, step: hw.stepOf(1, 0), ntc: 1, elecKw: 1.2, heatKw: 3.8 });
  for (let i = 0; i < 30; i++) s.push({ outdoorC: 3, step: 2, ntc: 0, elecKw: 0.8, heatKw: 2.8 }); // too little to say anything
  const rows = hw.learnSteps(s);
  assert.deepEqual(rows.map((r) => [r.step, r.ntc, r.cop]), [[0, 0, 2.7], [1, 1, 3.17]]);
  assert.equal(hw.stepOf(1, 1), 2);
});

test('the comfort schedule is learned from the room controller target, per weekday', () => {
  const localOf = (ms) => { const d = new Date(ms); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: (d.getUTCDay() + 6) % 7 }; };
  const s = [];
  const T0 = Date.parse('2026-10-05T00:00:00Z'); // Monday
  for (let m = 0; m < 14 * 1440; m += 5) {
    const ms = T0 + m * MIN; const l = localOf(ms); const t = l.hour * 60 + l.minute;
    const from = l.weekday >= 5 ? 8 * 60 : 6 * 60 + 30;
    s.push({ ms, targetC: t >= from && t < 22 * 60 + 30 ? 20.5 : 19 });
  }
  const sc = rw.learnSchedule(s, localOf);
  assert.equal(sc.comfortC, 20.5);
  assert.equal(sc.setbackC, 19);
  assert.deepEqual(sc.days[0], { from: '06:30', until: '22:30', n: 2 });
  assert.equal(sc.days[5].from, '08:00', 'Saturday later');
});
