const test = require('node:test');
const assert = require('node:assert');
const ep = require('../src/energyPatterns');

// UTC as "local" time keeps the test independent of the machine.
const localOf = (ms) => { const d = new Date(ms); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: (d.getUTCDay() + 6) % 7 }; };
const NOW = Date.parse('2026-10-05T12:00:00Z'); // a Monday
const dayMs = (back, h) => Date.parse('2026-10-05T00:00:00Z') - back * 86400000 + h * 3600000;

test('daily pattern: tap water every evening 19-20 h', () => {
  const hourly = [];
  for (let d = 1; d <= 28; d++) { if (d % 7 === 3) continue; hourly.push({ hour: new Date(dayMs(d, 19)).toISOString(), kwh: 2.4 }); hourly.push({ hour: new Date(dayMs(d, 7)).toISOString(), kwh: 0.05 }); }
  const { patterns, profile } = ep.findPatterns({ kind: 'dhw', hourly, localOf, nowMs: NOW });
  assert.equal(profile.days, 28);
  assert.equal(patterns.length, 1);
  assert.deepEqual([patterns[0].type, patterns[0].from, patterns[0].to], ['daily', 19, 20]);
  assert.ok(patterns[0].probability >= 0.8);
  assert.ok(ep.expectedKwh(profile, dayMs(0, 19), localOf) > 1.5);
  assert.equal(ep.expectedKwh(profile, dayMs(0, 7), localOf), 0); // below the threshold: not in use
});

test('weekly pattern stands out from the daily profile', () => {
  const hourly = [];
  for (let d = 1; d <= 35; d++) { const wd = localOf(dayMs(d, 9)).weekday; if (wd === 6) { hourly.push({ hour: new Date(dayMs(d, 9)).toISOString(), kwh: 1.2 }); hourly.push({ hour: new Date(dayMs(d, 10)).toISOString(), kwh: 1.0 }); } }
  const ps = ep.hourPatterns(ep.profile({ hourly, localOf, nowMs: NOW }));
  assert.equal(ps.length, 1);
  assert.deepEqual([ps[0].type, ps[0].weekday, ps[0].from, ps[0].to], ['weekly', 6, 9, 11]);
});

test('run pattern: washer on Saturday ~10:00, and the dryer follows it', () => {
  const washer = []; const dryer = [];
  for (let w = 0; w < 6; w++) {
    const sat = Date.parse('2026-10-03T10:00:00Z') - w * 7 * 86400000 + (w % 2) * 20 * 60000;
    washer.push({ start_at: new Date(sat).toISOString(), end_at: new Date(sat + 2 * 3600000).toISOString(), kwh: 1.1 });
    if (w !== 4) dryer.push({ start_at: new Date(sat + 2 * 3600000 + 40 * 60000).toISOString(), end_at: new Date(sat + 4.5 * 3600000).toISOString(), kwh: 2 });
  }
  const ps = ep.runPatterns({ runs: washer, localOf, nowMs: NOW });
  assert.equal(ps.length, 1);
  assert.equal(ps[0].weekday, 5);
  assert.equal(ps[0].hour, 10);
  assert.equal(ps[0].durationH, 2);
  assert.equal(ps[0].kwh, 1.1);
  assert.ok(ps[0].count >= 6);
  const f = ep.followPatterns({ 1: washer, 2: dryer });
  assert.equal(f.length, 1);
  assert.deepEqual([f[0].from, f[0].to, f[0].gapMin, f[0].count], [1, 2, 40, 5]);
  assert.match(ep.describe(f[0], { 1: 'Washer', 2: 'Dryer' }), /Dryer usually starts ~40 min after Washer/);
  const next = ep.nextOccurrence(ps[0], NOW, NOW + 7 * 86400000, localOf);
  assert.equal(new Date(next).toISOString().slice(0, 13), '2026-10-10T10');
});

test('too little data or always on: no patterns', () => {
  assert.deepEqual(ep.findPatterns({ kind: 'dhw', hourly: [{ hour: new Date(dayMs(2, 19)).toISOString(), kwh: 2 }], localOf, nowMs: NOW }).patterns, []);
  const hourly = [];
  for (let d = 1; d <= 14; d++) for (let h = 0; h < 24; h++) hourly.push({ hour: new Date(dayMs(d, h)).toISOString(), kwh: 0.8 });
  assert.deepEqual(ep.hourPatterns(ep.profile({ hourly, localOf, nowMs: NOW })), []);
});
