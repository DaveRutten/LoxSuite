// Import from and export to the grid, visible apart: Meters tile and chart, MQTT topics for Monitor /
// dashboards, and the expected import in the Smart charging chart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { periodStarts, energyTopics } = require('../src/energyMeters');

test('period starts: today, Monday of this week and the 1st of the month, in local time', () => {
  // Wednesday 7 October 2026 15:00 in Amsterdam (UTC+2)
  const s = periodStarts(Date.parse('2026-10-07T13:00:00Z'), 'Europe/Amsterdam');
  assert.equal(new Date(s.today).toISOString(), '2026-10-06T22:00:00.000Z');
  assert.equal(new Date(s.week).toISOString(), '2026-10-04T22:00:00.000Z'); // Monday 5 October 00:00
  assert.equal(new Date(s.month).toISOString(), '2026-09-30T22:00:00.000Z'); // 1 October 00:00
});

test('MQTT topics: grid import and export today, this week and this month', () => {
  const t = energyTopics();
  assert.equal(t.grid_today_kwh, 'loxsuite/energy/grid/today_kwh'); // import (unchanged)
  for (const k of ['today_export_kwh', 'week_import_kwh', 'week_export_kwh', 'month_import_kwh', 'month_export_kwh']) {
    assert.equal(t[`grid_${k}`], `loxsuite/energy/grid/${k}`);
  }
});

test('views: import bars + export bars on Meters, expected import line on Smart charging', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'views', f), 'utf8');
  const en = read('energy.ejs');
  assert.match(en, /IMPORT_COLOR/);
  assert.match(en, /Import from the grid/);
  assert.match(en, /Export to the grid/);
  assert.ok(!/stroke-dasharray="4 3"/.test(en), 'no thin dashed grid line any more: import is bars');
  const pl = read('planner.ejs');
  assert.match(pl, /expected import from the grid \(kW\)/);
  assert.match(pl, /gridKw/);
});
