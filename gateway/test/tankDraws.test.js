// Tap water from the tank temperature (tankDraws.js): a synthetic 200 l tank that loses ~0.6 °C/h,
// a shower every morning at 07:00 and the dishes / a bath in the evening at 19:30.
const test = require('node:test');
const assert = require('node:assert/strict');
const td = require('../src/tankDraws');
const ep = require('../src/energyPatterns');

const MIN = 60000;
const HOUR = 3600000;
const localOf = (ms) => { const d = new Date(ms); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: (d.getUTCDay() + 6) % 7 }; };
const T0 = Date.parse('2026-09-01T00:00:00Z');

// One sample a minute, the temperature rounded to 0.1 °C like a Loxone sensor.
function tank(days) {
  const out = [];
  let t = 52;
  for (let m = 0; m < days * 1440; m++) {
    const ms = T0 + m * MIN;
    const { hour, minute } = localOf(ms);
    const shower = hour === 7 && minute < 8;              // 8 min, ~6 °C
    const evening = hour === 19 && minute >= 30 && minute < 40; // 10 min, ~4 °C
    const heating = hour === 13 && minute < 40;          // the heat pump tops it up after noon
    if (heating) t = Math.min(52, t + 0.3);
    else t -= 0.6 / 60 + (shower ? 0.75 : 0) + (evening ? 0.4 : 0);
    out.push({ ms, temp: Math.round(t * 10) / 10, heating });
  }
  return out;
}

test('learns what fast is for this tank and finds every draw', () => {
  const samples = tank(14);
  const th = td.learnThreshold(td.dropRates(samples));
  assert.ok(th.learned);
  assert.ok(th.baselineCph > 0.2 && th.baselineCph < 1.5, `standby ${th.baselineCph} °C/h`);
  assert.ok(th.cph >= 4 && th.cph < 30, `threshold ${th.cph} °C/h`);
  const draws = td.detectDraws(samples, { thresholdCph: th.cph });
  assert.equal(draws.length, 28, 'two draws a day for 14 days');
  const morning = draws.filter((d) => localOf(d.startMs).hour === 7);
  assert.equal(morning.length, 14);
  assert.ok(morning.every((d) => d.dropC > 5 && d.dropC < 7.5), JSON.stringify(morning.map((d) => d.dropC)));
});

test('standby cooling and the heat-pump top-up are not draws', () => {
  const quiet = [];
  let t = 50;
  for (let m = 0; m < 2 * 1440; m++) { t -= 0.6 / 60; quiet.push({ ms: T0 + m * MIN, temp: Math.round(t * 10) / 10, heating: false }); }
  assert.deepEqual(td.detectDraws(quiet, { thresholdCph: 8 }), []);
});

test('the profile shows the usual draws as daily patterns', () => {
  const samples = tank(14);
  const draws = td.detectDraws(samples, { thresholdCph: td.learnThreshold(td.dropRates(samples)).cph });
  const prof = td.drawProfile(draws, { localOf, nowMs: T0 + 14 * 24 * HOUR, firstMs: T0 });
  const pats = ep.hourPatterns(prof);
  assert.deepEqual(pats.filter((p) => p.type === 'daily').map((p) => p.from), [7, 19]);
  assert.ok(ep.expectedKwh(prof, Date.parse('2026-09-20T07:00:00Z'), localOf) > 5);
});

test('heats in the cheap night before the morning shower, not when it is expensive', () => {
  const start = Date.parse('2026-09-15T20:00:00Z');
  const hours = Array.from({ length: 16 }, (_, i) => {
    const ms = start + i * HOUR;
    const h = localOf(ms).hour;
    return { ms, price: h >= 1 && h < 5 ? 0.12 : 0.30, surplusKwh: 0 };
  });
  const dropOf = (ms) => (localOf(ms).hour === 7 ? 6 : 0);
  const plan = td.planTank({ hours, tankC: 52, dropOf, lossCph: 0.6, heatCph: 10, minC: 45, maxC: 58 });
  const dhw = plan.hours.filter((h) => h.mode === 'dhw' && h.ms < Date.parse('2026-09-16T08:00:00Z')).map((h) => localOf(h.ms).hour);
  assert.ok(dhw.length >= 1);
  assert.ok(dhw.every((h) => h >= 1 && h < 5), `planned at ${dhw}`);
  const at7 = plan.hours.find((h) => localOf(h.ms).hour === 7);
  assert.ok(at7.predC >= 45, `after the shower still ${at7.predC} °C`);
});

test('too cold now: heat now, before the boost element does', () => {
  const hours = Array.from({ length: 6 }, (_, i) => ({ ms: T0 + i * HOUR, price: i === 3 ? 0.05 : 0.3, surplusKwh: 0 }));
  const plan = td.planTank({ hours, tankC: 41, minC: 45 });
  assert.equal(plan.hours[0].mode, 'dhw');
  assert.match(plan.hours[0].reason, /boost/);
});

test('a solar surplus goes into the tank as long as there is room', () => {
  const hours = Array.from({ length: 6 }, (_, i) => ({ ms: T0 + (10 + i) * HOUR, price: 0.25, surplusKwh: i === 2 ? 3 : 0 }));
  const plan = td.planTank({ hours, tankC: 48, minC: 45, maxC: 58 });
  assert.equal(plan.hours[2].mode, 'dhw');
  assert.match(plan.hours[2].reason, /solar/);
  const full = td.planTank({ hours, tankC: 55, minC: 45, maxC: 56 });
  assert.equal(full.hours[2].mode, 'free', 'a full tank leaves the surplus for others');
});

test('never longer without space heating than the house allows', () => {
  const hours = Array.from({ length: 8 }, (_, i) => ({ ms: T0 + i * HOUR, price: i < 4 ? 0.10 : 0.40, surplusKwh: 0 }));
  const plan = td.planTank({ hours, tankC: 46, dropOf: (ms) => (ms === T0 + 5 * HOUR ? 30 : 0), heatCph: 6, holdH: 2, minC: 45, maxC: 80 });
  const modes = plan.hours.map((h) => h.mode);
  for (let i = 0; i + 2 < modes.length; i++) assert.ok(!(modes[i] === 'dhw' && modes[i + 1] === 'dhw' && modes[i + 2] === 'dhw'), modes.join(','));
});

test('tap water right before or after heating the room, never in between', () => {
  const start = Date.parse('2026-10-16T00:00:00Z');
  const hours = Array.from({ length: 10 }, (_, i) => ({ ms: start + i * HOUR, price: [0.2, 0.2, 0.2, 0.2, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2][i], surplusKwh: 0 }));
  const heatingHours = new Set([4, 5, 6].map((i) => start + i * HOUR)); // pre-heating the room 04:00-07:00
  const dropOf = (ms) => (ms === start + 8 * HOUR ? 8 : 0);
  const plan = td.planTank({ hours, tankC: 47, dropOf, lossCph: 0.5, heatCph: 10, minC: 45, maxC: 58, heatingHours });
  const dhw = plan.hours.map((h, i) => (h.mode === 'dhw' ? i : null)).filter((i) => i !== null);
  assert.ok(dhw.length >= 1);
  assert.ok(dhw.every((i) => i < 4 || i > 6), `tap water at ${dhw}`);
  assert.ok(dhw.some((i) => i === 3 || i === 7), `next to the heating block: ${dhw}`);
  assert.equal(plan.hours[5].mode, 'heating');
  assert.match(plan.hours.find((h) => h.mode === 'dhw').reason, /right (before|after) heating/);
});

test('a sensor on the hot-water pipe: each jump is a draw, small ones too, the size from the tank', () => {
  const s = [];
  let tank = 52;
  for (let m = 0; m < 24 * 60; m++) {
    const ms = Date.parse('2026-10-01T00:00:00Z') + m * MIN;
    const shower = m >= 420 && m < 428; // 07:00, 8 min
    const hands = m >= 600 && m < 601;  // 10:00, one minute — too small for the tank alone
    tank -= 0.01 + (shower ? 0.75 : 0) + (hands ? 0.4 : 0);
    const since = [420, 600].map((st) => m - st).filter((d) => d >= 0).sort((a, b) => a - b)[0];
    const running = shower || hands;
    const pipe = running ? 48 : since !== undefined && since < 90 ? Math.max(20, 48 - (since - (since >= 180 ? 8 : 1)) * 0.6) : 20;
    s.push({ ms, temp: Math.round(tank * 10) / 10, pipe: Math.round(pipe * 10) / 10, heating: false });
  }
  const d = td.pipeDraws(s);
  assert.equal(d.length, 2, JSON.stringify(d.map((x) => [new Date(x.startMs).toISOString().slice(11, 16), x.dropC])));
  assert.equal(new Date(d[0].startMs).toISOString().slice(11, 16), '07:00');
  assert.ok(d[0].dropC > 5);
  assert.equal(new Date(d[1].startMs).toISOString().slice(11, 16), '10:00');
  assert.ok(d[1].dropC > 0.2 && d[1].dropC < 1);
  // the tank alone misses the one-minute draw
  assert.equal(td.detectDraws(s, { thresholdCph: 8 }).length, 1);
});
