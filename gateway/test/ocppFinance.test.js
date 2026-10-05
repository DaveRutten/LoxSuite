const test = require('node:test');
const assert = require('node:assert');
const f = require('../src/ocppFinance');

const tz = 'Europe/Amsterdam';
const at = (iso) => Math.round(Date.parse(iso) / 1000);

test('tariffOn picks the latest tariff on or before the date; none = null', () => {
  const t = [{ valid_from: '2026-01-01', eur_per_kwh: 0.23 }, { valid_from: '2026-07-01', eur_per_kwh: 0.25 }];
  assert.equal(f.tariffOn(t, '2025-12-31'), null);
  assert.equal(f.tariffOn(t, '2026-03-01').eur_per_kwh, 0.23);
  assert.equal(f.tariffOn(t, '2026-07-01').eur_per_kwh, 0.25);
});

test('hourly cost: grid part at the hour price, solar part at its value; reimbursement from the tariff', () => {
  const rows = [{ start: at('2026-06-10T10:05:00Z'), end: at('2026-06-10T11:55:00Z'), energy: 10 }];
  const hours = new Map([
    ['2026-06-10T10:00:00.000Z', { wallboxKwh: 5, gridImportKwh: 5 }], // all grid at 0.30
    ['2026-06-10T11:00:00.000Z', { wallboxKwh: 5, gridImportKwh: 0 }], // all solar
  ]);
  const prices = [
    { s: Date.parse('2026-06-10T10:00:00Z'), e: Date.parse('2026-06-10T11:00:00Z'), v: 0.30 },
    { s: Date.parse('2026-06-10T11:00:00Z'), e: Date.parse('2026-06-10T12:00:00Z'), v: 0.10 },
  ];
  const tariffs = [{ valid_from: '2026-01-01', eur_per_kwh: 0.25 }];
  const [sal] = f.costSessions({ rows, tariffs, settings: { cost_mode: 'hourly', solar_value: 'saldering' }, hours, prices, timeZone: tz });
  assert.equal(sal.cost, 2); // 5 × 0.30 + 5 × 0.10
  assert.equal(sal.reimbursement, 2.5);
  assert.equal(sal.saldo, 0.5);
  assert.equal(sal.solarShare, 50);
  assert.equal(sal.costSource, 'uur');
  const [free] = f.costSessions({ rows, tariffs, settings: { solar_value: 'free' }, hours, prices, timeZone: tz });
  assert.equal(free.cost, 1.5);
});

test('fallbacks: average price without hourly meter data, fixed rate, no tariff = no reimbursement/saldo', () => {
  const rows = [{ start: at('2026-06-10T10:05:00Z'), end: at('2026-06-10T10:55:00Z'), energy: 4 }];
  const prices = [{ s: Date.parse('2026-06-10T10:00:00Z'), e: Date.parse('2026-06-10T11:00:00Z'), v: 0.25 }];
  const [avg] = f.costSessions({ rows, tariffs: [], settings: null, hours: new Map(), prices, timeZone: tz });
  assert.equal(avg.cost, 1);
  assert.equal(avg.costSource, 'gem');
  assert.equal(avg.reimbursement, null);
  assert.equal(avg.saldo, null);
  const [fixed] = f.costSessions({ rows, tariffs: [{ valid_from: '2026-01-01', eur_per_kwh: 0.2 }], settings: { cost_mode: 'fixed', fixed_eur_kwh: 0.3 }, hours: new Map(), prices: [], timeZone: tz });
  assert.equal(fixed.cost, 1.2);
  assert.equal(fixed.saldo, -0.4);
});

test('VAT: a tariff excl. VAT is raised; showing excl. VAT lowers every amount', () => {
  const rows = [{ start: at('2026-06-10T10:05:00Z'), end: at('2026-06-10T10:55:00Z'), energy: 10 }];
  const tariffs = [{ valid_from: '2026-01-01', eur_per_kwh: 0.2 }];
  const [a] = f.costSessions({ rows, tariffs, settings: { cost_mode: 'fixed', fixed_eur_kwh: 0.242, tariff_vat: 'excl', vat_pct: 21 }, hours: new Map(), prices: [], timeZone: tz });
  assert.equal(a.reimbursement, 2.42);
  const [b] = f.costSessions({ rows, tariffs, settings: { cost_mode: 'fixed', fixed_eur_kwh: 0.242, show_vat: 'excl', vat_pct: 21 }, hours: new Map(), prices: [], timeZone: tz });
  assert.equal(b.cost, 2);
});

test('summarize: month/quarter/year totals and per month', () => {
  const now = new Date('2026-05-20T12:00:00Z');
  const costed = [
    { start: at('2026-05-02T10:00:00Z'), energy: 10, cost: 2, reimbursement: 2.5 },
    { start: at('2026-04-02T10:00:00Z'), energy: 5, cost: 1, reimbursement: null },
    { start: at('2026-01-02T10:00:00Z'), energy: 5, cost: 1.5, reimbursement: 1.25 },
    { start: at('2025-12-02T10:00:00Z'), energy: 5, cost: 1, reimbursement: 1 },
  ];
  const s = f.summarize(costed, tz, now);
  assert.deepEqual([s.month.cost, s.month.reimbursement, s.month.saldo], [2, 2.5, 0.5]);
  assert.deepEqual([s.quarter.kwh, s.quarter.cost, s.quarter.reimbursement], [15, 3, 2.5]);
  assert.equal(s.year.sessions, 3);
  assert.equal(s.months['2025-12'].saldo, 0);
});
