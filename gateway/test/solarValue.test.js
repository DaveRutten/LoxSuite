// What own solar counts as (v0.50): what exporting it yields — net metering until the end of 2026, then
// the bare market price — minus "prefer own solar". With that preference Smart charging runs at the
// minimum power through a sunny hour and uses a sunny afternoon hour, instead of full power from the
// grid in the cheapest quarters only.
const test = require('node:test');
const assert = require('node:assert/strict');
const sv = require('../src/solarValue');
const { makePlan } = require('../src/planner');

const at = (iso) => Date.parse(iso);

test('net metering: the price of that moment until 2027, then the bare market price', () => {
  const before = at('2026-12-31T22:45:00Z'); // 23:45 in the Netherlands
  const after = at('2026-12-31T23:00:00Z');  // 1 January 2027 00:00
  assert.equal(sv.ruleAt('saldering', before), 'saldering');
  assert.equal(sv.ruleAt('saldering', after), 'market');
  assert.equal(sv.ruleAt('fixed', after), 'fixed');
  assert.equal(sv.ruleAt(undefined, before), 'saldering', 'an old setting counts as net metering');
  assert.equal(sv.exportWorth({ atMs: before, price: 0.27, market: 0.11 }), 0.27);
  assert.equal(sv.exportWorth({ atMs: after, price: 0.27, market: 0.11 }), 0.11);
  assert.equal(sv.exportWorth({ atMs: before, price: 0.27, market: 0.11, feedIn: 'market' }), 0.11);
  assert.equal(sv.exportWorth({ atMs: after, price: 0.27, feedIn: 'fixed', feedInEur: 0.07 }), 0.07);
  // no market price (a fixed contract, Loxone only): back from the all-in price
  assert.equal(sv.marketFromAllin(0.28513, { markup_eur_kwh: 0.02, energy_tax_eur_kwh: 0.10, vat_pct: 21 }), 0.133);
  assert.equal(sv.exportWorth({ atMs: after, price: 0.28513, priceCfg: { markup_eur_kwh: 0.02, energy_tax_eur_kwh: 0.10, vat_pct: 21 } }), 0.133);
  // no price at all: the feed-in tariff as a stand-in
  assert.equal(sv.exportWorth({ atMs: before, price: null, feedInEur: 0.05 }), 0.05);
});

test('prefer own solar: that much cheaper, not below zero — a negative market price stays negative', () => {
  assert.equal(sv.ownSolarCost(0.27, 0.05), 0.22);
  assert.equal(sv.ownSolarCost(0.03, 0.05), 0);
  assert.equal(sv.ownSolarCost(-0.04, 0.05), -0.04);
  assert.equal(sv.ownSolarCost(0.27, undefined), 0.27);
  assert.equal(sv.ownSolarCost(0.27, -1), 0.27, 'a negative preference is ignored');
});

// Tomorrow per quarter: a cheap but not very sunny 13:00 (2.6 kW surplus), a sunny 16:00 (4.4 kW) that
// costs more than the plug-in hybrid's fuel break-even (0.21). Wallbox 4.16–9.66 kW, 12 kWh needed.
function day({ date = '2026-10-08', market = null } = {}) {
  const slots = [];
  // UTC hour -> price per quarter (13:00 in the Netherlands = 11:00 UTC in summer time)
  const price = (u, i) => (u === 11 ? [0.200, 0.204, 0.212, 0.216][i] : u === 12 || u === 13 ? 0.23 : u === 14 ? 0.24 : 0.25);
  for (let u = 6; u < 18; u++) {
    for (let i = 0; i < 4; i++) {
      const s = at(`${date}T${String(u).padStart(2, '0')}:00:00Z`) + i * 900000;
      slots.push({ start: new Date(s).toISOString(), end: new Date(s + 900000).toISOString(), price: price(u, i), market, pvKw: u === 11 ? 2.6 : u === 14 ? 4.4 : 0 });
    }
  }
  return slots;
}
const args = (o) => ({ nowMs: at('2026-10-08T06:00:00Z'), readyAtMs: at('2026-10-08T18:00:00Z'), needKwh: 12, mode: 'plan', minKw: 4.16, maxKw: 9.66, solarTrust: 'expected', priceCap: 0.21, insufficient: 'stop', ...o });
const inHour = (plan, isoHour) => plan.slots.filter((s) => s.start.startsWith(isoHour));

test('without a preference: full power in the two cheapest quarters, the sunny afternoon unused', () => {
  const plan = makePlan(args({ slots: day(), solarBonus: 0 }));
  const one = inHour(plan, '2026-10-08T11');
  assert.equal(one.length, 2, 'only the quarters under the price cap');
  assert.ok(one.every((s) => s.kw === 9.66));
  assert.equal(inHour(plan, '2026-10-08T14').length, 0, 'solar at 16:00 counts as its price (0.24), above the fuel break-even');
});

test('with "prefer own solar": the minimum power through the sunny hour, and the sunny afternoon from solar', () => {
  const plan = makePlan(args({ slots: day(), solarBonus: 0.05 }));
  const one = inHour(plan, '2026-10-08T11');
  assert.equal(one.length, 4, 'every quarter of 13:00 charges, at least at the minimum power');
  assert.ok(one.every((s) => s.kw >= 4.16));
  const four = inHour(plan, '2026-10-08T14');
  assert.equal(four.length, 4, '16:00 charges on solar');
  assert.ok(four.every((s) => s.kw === 4.4 && s.source === 'pv'));
  assert.ok(plan.pvKwh > 5.5, `solar ${plan.pvKwh} kWh`);
  // the grid top-up at 13:00 is still cheaper than fuel, so it stays — in the cheapest quarters
  assert.ok(one.filter((s) => s.kw > 4.16).every((s) => s.price <= 0.204));
});

test('from 2027 net metering is over: solar counts as the market price, also without a preference', () => {
  const plan = makePlan(args({ slots: day({ date: '2027-01-08', market: 0.12 }).map((s) => ({ ...s })), nowMs: at('2027-01-08T06:00:00Z'), readyAtMs: at('2027-01-08T18:00:00Z'), solarBonus: 0 }));
  const four = plan.slots.filter((s) => s.start.startsWith('2027-01-08T14'));
  assert.equal(four.length, 4, 'solar worth 0.12 exported is used in the car');
  assert.ok(four.every((s) => s.source === 'pv'));
});
