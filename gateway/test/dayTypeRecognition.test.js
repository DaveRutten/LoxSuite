// Kind of day (away / holiday / home / weekend / workday) and recognising what a consumer is doing:
// how far a run is, something off, and unknown consumers in the house use.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const dt = require('../src/dayType');
const em = require('../src/energyManager');
const { initTestDb, db } = require('./helpers/testDb');

test('Easter and the Dutch public holidays', () => {
  assert.deepEqual(dt.easter(2026), { m: 4, d: 5 });
  assert.deepEqual(dt.easter(2027), { m: 3, d: 28 });
  const h = dt.dutchHolidays(2026);
  assert.equal(h.get('2026-04-06'), 'Easter Monday');
  assert.equal(h.get('2026-05-14'), 'Ascension');
  assert.equal(h.get('2026-05-25'), 'Whit Monday');
  assert.equal(h.get('2026-04-27'), "King's Day");
  assert.equal(dt.dutchHolidays(2025).get('2025-04-26'), "King's Day", 'the 26th when the 27th is a Sunday');
});

test('day type: away beats holiday beats home beats weekday', () => {
  const cfg = dt.DEFAULTS;
  assert.equal(dt.typeOf('2026-10-06', { weekday: 1, items: [{ title: 'Vakantie Texel' }], cfg }), 'away');
  assert.equal(dt.typeOf('2026-10-06', { weekday: 1, items: [], cfg: { ...cfg, away_from: '2026-10-05', away_to: '2026-10-09' } }), 'away');
  assert.equal(dt.typeOf('2026-10-06', { weekday: 1, items: [], presenceAway: true, cfg }), 'away');
  assert.equal(dt.typeOf('2026-04-06', { weekday: 0, items: [{ title: 'Thuiswerken' }], holiday: 'Easter Monday', cfg }), 'holiday');
  assert.equal(dt.typeOf('2026-10-06', { weekday: 1, items: [{ title: 'Thuiswerken' }], cfg }), 'home');
  assert.equal(dt.typeOf('2026-10-10', { weekday: 5, items: [], cfg }), 'weekend');
  assert.equal(dt.typeOf('2026-10-06', { weekday: 1, items: [{ title: 'Dentist' }], cfg }), 'workday');
  assert.equal(dt.typeOf('2026-04-06', { weekday: 0, items: [], holiday: 'Easter Monday', cfg: { ...cfg, holidays: false } }), 'workday');
});

test('house on a holiday follows the weekend profile, on a day away only the base load', () => {
  const learning = require('../src/learning');
  const profile = { workday: Array(24).fill(1), weekend: Array(24).fill(2), baseLoadKw: 0.2 };
  const tuesday = Date.parse('2026-10-06T10:00:00Z');
  assert.equal(learning.expectedHouseKwh(profile, tuesday, { tz: 'UTC' }), 1);
  assert.equal(learning.expectedHouseKwh(profile, tuesday, { tz: 'UTC', dayType: 'holiday' }), 2);
  assert.equal(learning.expectedHouseKwh(profile, tuesday, { tz: 'UTC', dayType: 'away' }), 0.2);
});

test('a running appliance: time and kWh to go from its usual run', () => {
  const now = Date.parse('2026-10-06T10:30:00Z');
  const p = em.runProgress({ sinceMs: now - 30 * 60000, nowMs: now, typicalH: 1.5, typicalKwh: 1.2, usedKwh: 0.5 });
  assert.equal(p.remainingMin, 60); assert.equal(p.remainingKwh, 0.7); assert.equal(p.pct, 33); assert.equal(p.overdue, false);
  assert.equal(em.runProgress({ sinceMs: now - 150 * 60000, nowMs: now, typicalH: 1.5, typicalKwh: 1.2 }).overdue, true);
  assert.equal(em.runProgress({ sinceMs: now, nowMs: now, typicalH: null }), null);
});

test('something off: more power per status than the weeks before, more kWh than the weather explains', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const rows = [];
  for (let d = 27; d >= 1; d--) {
    const hour = new Date(now - d * 86400000).toISOString();
    rows.push({ hour, status: 'Space heating', minutes: 60, kwh: d <= 6 ? 2.0 : 1.4, measured: 1 });
    rows.push({ hour, status: 'Off', minutes: 600, kwh: 0, measured: 0 });
  }
  const a = em.anomalies({ rows, nowMs: now });
  assert.equal(a.length, 1);
  assert.equal(a[0].status, 'Space heating');
  assert.ok(a[0].ratio >= 1.3);
  const model = { usable: true, a: 2, b: 0.5 };
  const w = em.anomalies({ rows: [], nowMs: now, model, weatherDays: Array.from({ length: 7 }, (_, i) => ({ day: `d${i}`, meanC: 8, kwh: 10 })) });
  assert.equal(w[0].kind, 'weather'); // expected 2 + 0.5×10 = 7 kWh/day, used 10
  assert.equal(em.anomalies({ rows: [], nowMs: now, model, weatherDays: Array.from({ length: 7 }, (_, i) => ({ day: `d${i}`, meanC: 8, kwh: 7.2 })) }).length, 0);
});

before(async () => { await initTestDb(); });
after(async () => { await db.close(); });

test('unknown consumers: a block of house use every evening beyond the known consumers is found', async () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const localOf = (ms) => { const d = new Date(ms); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: 0, weekday: (d.getUTCDay() + 6) % 7 }; };
  for (let t = Date.parse('2026-09-15T00:00:00Z'); t < now; t += 3600000) {
    const h = new Date(t).getUTCHours();
    const kwh = 0.3 + (h === 18 ? 1.8 : 0);
    await db.upsert('energy_hourly', { role: 'house', hour: new Date(t).toISOString(), import_kwh: kwh, export_kwh: 0, source: 'live' }, ['role', 'hour']);
  }
  const found = await em.unknownPatterns(now, localOf);
  assert.ok(found.some((p) => p.type === 'daily' && p.from === 18), JSON.stringify(found));
});
