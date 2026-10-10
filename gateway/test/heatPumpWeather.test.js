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

test('room forecast: when the heat pump comes on and when the room is at its target', () => {
  const m = rw.learn(roomSamples(8)); // 0.4 °C/h at 0 °C outside
  const T = Date.parse('2026-10-10T00:00:00Z');
  const hours = Array.from({ length: 10 }, (_, i) => ({ ms: T + i * HOUR, targetC: i >= 5 ? 20.5 : 19, outdoorC: 0.5 }));
  const f = rw.forecast(m, { startC: 19.2, hours, k: 0.005 });
  assert.equal(f.onAt, T + 5 * HOUR, 'comes on when the target goes up');
  assert.ok(f.reachAt > T + 7 * HOUR && f.reachAt < T + 10 * HOUR, new Date(f.reachAt).toISOString());
  assert.ok(f.rows[4].roomC < 19.2, 'cools down before');
});

test('room forecast: a small dip is made up within the hour, with its own on and at-temperature time', () => {
  const m = rw.learn(roomSamples(8));
  const T = Date.parse('2026-10-10T00:00:00Z');
  const hours = Array.from({ length: 6 }, (_, i) => ({ ms: T + i * HOUR, targetC: 20, outdoorC: 0.5 }));
  const f = rw.forecast(m, { startC: 19.6, hours, k: 0.005 });
  assert.ok(f.runs.length >= 1);
  const r = f.runs[0];
  assert.ok(r.offAt > r.onAt, 'warm after it came on');
  assert.ok(r.onAt > T && r.onAt % HOUR !== 0 || r.onAt === T, 'on at the moment it drops below, not rounded to the hour');
});

test('SCOP as measured: all heat over all power, per day kept, days with too little data left out', () => {
  const T = Date.parse('2026-01-10T00:00:00Z');
  const s = [];
  for (let i = 0; i < 24 * 60; i++) s.push({ ms: T + i * 60000, elecKw: 1, heatKw: 4, outdoorC: 2 });
  for (let i = 0; i < 24 * 60; i++) s.push({ ms: T + 86400000 + i * 60000, elecKw: 1, heatKw: 3, outdoorC: -3 });
  s.push({ ms: T + 2 * 86400000, elecKw: 5, heatKw: 0 });
  const days = hw.dailyEnergy(s, (ms) => new Date(ms).toISOString().slice(0, 10));
  assert.equal(days['2026-01-10'].heat, 96);
  assert.equal(days['2026-01-10'].elec, 24);
  const r = hw.scop(days);
  assert.equal(r.scop, 3.5);
  assert.equal(r.days, 2);
});

test('monthly report: what shifting to cheap hours saved against the day average', () => {
  const H0 = Date.parse('2026-01-10T00:00:00Z') / 3600000;
  const price = (h) => ((h - H0) % 24 < 6 ? 0.1 : 0.3); // night cheap
  const days = { '2026-01-10': { heat: 40, elec: 10, min: 1440, eh: { [H0 + 2]: 8, [H0 + 14]: 2 } } };
  const hoursOfDay = () => Array.from({ length: 24 }, (_, i) => H0 + i);
  const [m] = hw.monthly(days, price, hoursOfDay);
  assert.equal(m.month, '2026-01');
  assert.equal(m.costEur, 1.4); // 8 × 0.1 + 2 × 0.3
  const avg = (6 * 0.1 + 18 * 0.3) / 24; // 0.25
  assert.equal(m.flatEur, Math.round(10 * avg * 100) / 100);
  assert.equal(m.savedEur, Math.round((10 * avg - 1.4) * 100) / 100);
  assert.equal(m.scop, 4);
});

test('the house as a battery: a little warmer on solar (cooler when cooling), more with more sun', () => {
  const rw = require('../src/roomWarmup');
  const hours = [{ ms: 1, targetC: 20, room: 'comfort', surplusKwh: 0.5 }, { ms: 2, targetC: 20, room: 'comfort', surplusKwh: 1.5 }, { ms: 3, targetC: 20, room: 'comfort', surplusKwh: 4 }];
  const h = rw.solarShift(hours, { boostC: 0.6, minSurplusKwh: 1 });
  assert.deepEqual(h.map((x) => x.targetC), [20, 20.5, 20.6]);
  assert.equal(h[2].room, 'solar');
  assert.equal(rw.solarShift(hours, { cooling: true, boostC: 0.6 })[2].targetC, 19.4);
  assert.deepEqual(rw.solarShift(hours, { boostC: 0 }), hours);
});
