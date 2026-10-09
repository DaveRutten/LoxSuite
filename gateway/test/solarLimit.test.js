// Solar module (solarLimit.js): limit the inverter only while exporting costs money.
const test = require('node:test');
const assert = require('node:assert/strict');
const sl = require('../src/solarLimit');
const et = require('../src/energyTypes');

const solaredge = et.loadTypes('solar').find((t) => t.key === 'solaredge');

test('the SolarEdge type has the two outputs, and "own / other make" lists every role', () => {
  assert.ok(et.check('solar', solaredge).ok);
  const custom = et.loadTypes('solar').find((t) => t.key === 'custom');
  assert.deepEqual(custom.registers.map((r) => r.role), Object.keys(et.ROLES.solar.roles));
  assert.equal(et.byRole(solaredge, 'powerLimitPct').extra, true, 'not in the Library template: added in Loxone');
  assert.equal(et.viName('solar', 'powerLimitPct'), 'PV_Limiet');
});

test('worth something: no limit; costs money: what the house uses, in 5 % steps', () => {
  assert.deepEqual(sl.limitPct({ value: 0.02, houseKw: 1 }), { limit: false, pct: 100, why: 'export yields € 0.020/kWh: no limit' });
  const l = sl.limitPct({ value: -0.04, houseKw: 1.3, inverterKw: 8 });
  assert.equal(l.limit, true);
  assert.equal(l.pct, 20); // (1.3 + 0.2) / 8 = 18.75 % -> 20 %
  assert.equal(sl.limitPct({ value: -0.04, houseKw: 12, inverterKw: 8 }).pct, 100, 'the car charging on solar takes it all');
});

test('SolarEdge: the enables go on once to their own on-value (4 and 1) and stay on; the limit does the work', () => {
  const on = sl.writesFor({ type: solaredge, value: -0.05, houseKw: 0.6, now: { powerControlEnable: 0, reactivePowerConfig: 0, powerLimitPct: 100 } });
  assert.deepEqual(on.map((w) => [w.vi, w.value]), [['PV_Regeling', 4], ['PV_Reactief', 1], ['PV_Limiet', 10]]);
  // exporting worth something again: only the limit back to 100 %, the enables stay
  const off = sl.writesFor({ type: solaredge, value: 0.08, houseKw: 0.6, now: { powerControlEnable: 4, reactivePowerConfig: 1, powerLimitPct: 10 } });
  assert.deepEqual(off.map((w) => [w.vi, w.value]), [['PV_Limiet', 100]]);
  const same = sl.writesFor({ type: solaredge, value: -0.05, houseKw: 0.5, now: { powerControlEnable: 4, reactivePowerConfig: 1, powerLimitPct: 10 } });
  assert.deepEqual(same, [], 'a small change in use is no new write');
});

test('what exporting yields comes from the contract: net metering, fixed tariff or market price, minus feed-in costs', () => {
  const sv = require('../src/solarValue');
  const before2027 = Date.parse('2026-10-10T12:00:00Z');
  const after = Date.parse('2027-03-10T12:00:00Z');
  // net metering with a normal price: export it all
  const nm = sv.exportNet({ atMs: before2027, price: 0.28, feedIn: 'saldering', feedInCostEur: 0 });
  assert.deepEqual([nm.rule, nm.value], ['saldering', 0.28]);
  assert.equal(sl.limitPct({ value: nm.value, houseKw: 0.5 }).limit, false);
  // net metering, dynamic contract, negative price at noon: the all-in price goes below zero -> limit
  const neg = sv.exportNet({ atMs: before2027, price: -0.13, feedIn: 'saldering', feedInCostEur: 0.115 });
  assert.equal(neg.value, -0.245);
  assert.equal(sl.limitPct({ value: neg.value, houseKw: 0.5 }).limit, true);
  // fixed feed-in tariff below the feed-in costs
  assert.equal(sv.exportNet({ atMs: after, feedIn: 'fixed', feedInEur: 0.05, feedInCostEur: 0.115 }).value, -0.065);
  // after net metering: the market price minus the costs
  const mk = sv.exportNet({ atMs: after, price: 0.25, market: 0.09, feedIn: 'saldering', feedInCostEur: 0.115 });
  assert.deepEqual([mk.rule, mk.value], ['market', -0.025]);
});
