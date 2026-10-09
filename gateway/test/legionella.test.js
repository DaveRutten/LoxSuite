// Tap-water limits and the legionella cycle (legionella.js), and how the heat pump writes them.
const test = require('node:test');
const assert = require('node:assert/strict');
const lg = require('../src/legionella');
const hp = require('../src/heatPumpTypes');
const et = require('../src/energyTypes');

const HOUR = 3600000;
const DAY = 86400000;
const MIN = 60000;
const localHour = (ms) => new Date(ms).getUTCHours();
const T0 = Date.parse('2026-10-05T00:00:00Z'); // a Monday

test('limits are put in order and say what they changed', () => {
  const ok = lg.dhwLimits({ comfortMinC: 45, targetC: 50, bufferMaxC: 55, hpMaxC: 55, absoluteMaxC: 60 });
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.limits.planMaxC, 55);
  const odd = lg.dhwLimits({ comfortMinC: 48, targetC: 45, bufferMaxC: 58, hpMaxC: 55, absoluteMaxC: 60 });
  assert.equal(odd.limits.targetC, 48);
  assert.equal(odd.limits.bufferMaxC, 55, 'above the heat pump only with the booster');
  assert.equal(odd.warnings.length, 2);
  const booster = lg.dhwLimits({ bufferMaxC: 58, boosterForBuffer: true });
  assert.equal(booster.limits.planMaxC, 58);
  assert.match(lg.dhwLimits({ comfortMinC: 38 }).warnings[0], /legionella/);
  assert.match(lg.dhwLimits({ absoluteMaxC: 70, bufferMaxC: 70, boosterForBuffer: true }).warnings[0], /scalding/);
});

test('done: held at 60 °C for 30 minutes, whoever did it', () => {
  const s = (startMin, temps) => temps.map((t, i) => ({ ms: T0 + (startMin + i) * MIN, temp: t }));
  const short = s(0, [58, 59.9, 60.1, 60.2, ...Array(20).fill(60.3), 57]);
  assert.equal(lg.lastDone(short, { targetC: 60, holdMin: 30 }), null);
  const long = s(0, [58, 60, ...Array(40).fill(60.4), 55]);
  assert.equal(lg.lastDone(long, { targetC: 60, holdMin: 30 }), T0 + 31 * MIN);
});

test('planned on the sunny afternoon before it is due, not in the cheap night', () => {
  const hours = Array.from({ length: 6 * 24 }, (_, i) => {
    const ms = T0 + i * HOUR; const h = localHour(ms); const day = Math.floor(i / 24);
    return { ms, price: h < 5 ? 0.12 : 0.28, surplusKwh: day === 3 && h >= 11 && h < 15 ? 4 : 0 };
  });
  const p = lg.planLegionella({ hours, nowMs: T0, lastDoneMs: T0 - 2 * DAY, intervalDays: 7, fromHour: 10, toHour: 17, durationH: 2, localHour });
  assert.equal(p.overdue, false);
  assert.equal(p.block.startMs, T0 + 3 * DAY + 11 * HOUR);
  assert.equal(p.block.solar, true);
  assert.equal(p.block.cost, 0);
  assert.match(p.reason, /solar/);
});

test('overdue: the first allowed block; outside the window nothing', () => {
  const hours = Array.from({ length: 48 }, (_, i) => ({ ms: T0 + 20 * HOUR + i * HOUR, price: 0.25, surplusKwh: 0 }));
  const p = lg.planLegionella({ hours, nowMs: T0 + 20 * HOUR, lastDoneMs: T0 - 9 * DAY, localHour });
  assert.equal(p.overdue, true);
  assert.equal(localHour(p.block.startMs), 10);
  const none = lg.planLegionella({ hours: hours.slice(0, 10), nowMs: T0 + 20 * HOUR, lastDoneMs: T0 - 9 * DAY, localHour });
  assert.equal(none.block, null);
});

test('the heat pump writes a legionella hour as its own target + one Force DHW pulse', () => {
  const ecodan = et.loadTypes('heatpump').find((t) => t.key === 'mitsubishi-ecodan-a1m');
  const now = et.fromRaw(ecodan, { tank_water_temp_actual: 52, tank_water_temp_target: 50, dhw_temperature_drop: 5, force_dhw: 0 });
  const w = hp.writesFor({ type: ecodan, plan: { mode: 'legionella' }, now, settings: { legionellaC: 60 } });
  assert.deepEqual(w.map((x) => [x.vi, x.value]), [['WP_Tapwater_Setpoint', 60], ['WP_Tapwater_Nu', 1]]);
  // the buffer maximum is a limit of the plan: a dhw hour never asks for more
  const dhw = hp.writesFor({ type: ecodan, plan: { mode: 'dhw' }, now: { ...now, tankTemp: 40 }, settings: { targetC: 58, bufferMaxC: 55, hpMaxC: 55 } });
  assert.equal(dhw[0].value, 55);
});
