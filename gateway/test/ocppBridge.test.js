const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wallboxStatus, getConfigurationReply, restoreState } = require('../src/ocppBridge');
const {
  parseTrackerEntries, quarterRange, recentQuarters, buildQuarterRows, buildXlsx, buildCsv,
} = require('../src/ocppExport');

test('wallboxStatus maps the Wallbox state to an OCPP 1.6 connector status', () => {
  assert.equal(wallboxStatus({ connected: 0, active: 0 }, false), 'Available');
  assert.equal(wallboxStatus({ connected: 1, active: 0 }, false), 'Preparing');
  assert.equal(wallboxStatus({ connected: 1, active: 0 }, true), 'SuspendedEVSE');
  assert.equal(wallboxStatus({ connected: 1, active: 1 }, true), 'Charging');
});

test('getConfigurationReply returns only asked keys and lists unknown ones', () => {
  const known = { HeartbeatInterval: { readonly: false, value: '300' }, NumberOfConnectors: { readonly: true, value: '1' } };
  assert.deepEqual(getConfigurationReply(['HeartbeatInterval', 'ClockAlignedDataInterval'], known), {
    configurationKey: [{ key: 'HeartbeatInterval', readonly: false, value: '300' }],
    unknownKey: ['ClockAlignedDataInterval'],
  });
  assert.equal(getConfigurationReply(undefined, known).configurationKey.length, 2);
});

test('restoreState never carries a transaction across dry/live modes', () => {
  const dry = JSON.stringify({ mode: 'dry', tx: { localId: 1 }, queue: [{ action: 'StopTransaction' }], txMap: { 1: 9001 }, nextLocalId: 2 });
  assert.equal(restoreState(dry, 'live').tx, null);
  assert.equal(restoreState(dry, 'live').queue.length, 0);
  assert.equal(restoreState(dry, 'dry').txMap[1], 9001);
  assert.equal(restoreState('not json', 'live').nextLocalId, 1);
});

const TRACKER = '2026-06-30 18:21:27 {"connect":1782834050,"disconnect":1782836487,"energy":1.081}'
  + '|2026-07-01 18:59:00 {"connect":1782907271,"disconnect":1782925140,"energy":13.358}'
  + '|broken entry'
  + '|2026-10-01 07:53:09 {"connect":1790794827,"disconnect":1790833989,"energy":7.568}';

test('parseTrackerEntries reads Loxone Wallbox session log entries and skips junk', () => {
  const e = parseTrackerEntries(TRACKER);
  assert.equal(e.length, 3);
  assert.deepEqual(e[1], { connect: 1782907271, disconnect: 1782925140, energy: 13.358 });
  assert.deepEqual(parseTrackerEntries(''), []);
});

test('quarterRange uses local midnight in the given time zone', () => {
  const q = quarterRange('2026Q3', 'Europe/Amsterdam');
  assert.equal(q.start, Date.UTC(2026, 5, 30, 22) / 1000); // 1 Jul 00:00 CEST
  assert.equal(q.end, Date.UTC(2026, 8, 30, 22) / 1000); // 1 Oct 00:00 CEST
  assert.equal(quarterRange('2026Q4', 'Europe/Amsterdam').end, Date.UTC(2026, 11, 31, 23) / 1000); // 1 Jan CET
  assert.equal(quarterRange('nope', 'UTC'), null);
  assert.deepEqual(recentQuarters(new Date(2026, 9, 3), 3), ['2026Q3', '2026Q2', '2026Q1']);
  assert.deepEqual(recentQuarters(new Date(2026, 1, 3), 2), ['2025Q4', '2025Q3']);
});

test('buildQuarterRows derives readings from the current total and prefers recorded readings', () => {
  const tracker = parseTrackerEntries(TRACKER);
  const range = quarterRange('2026Q3', 'Europe/Amsterdam');
  // current total = sum after the last session
  const { rows, incomplete } = buildQuarterRows({ tracker, recorded: [], currentTotalKwh: 5627.548, start: range.start, end: range.end });
  assert.equal(incomplete, false);
  // 30 Jun is outside Q3; the session logged on 1 Oct STARTED on 30 Sep 21:00, so it counts for Q3
  assert.equal(rows.length, 2);
  assert.equal(rows[1].meterStart, 5619.98);
  assert.equal(rows[0].source, 'afgeleid');
  assert.equal(rows[0].meterStop, 5619.98); // 5627.548 - 7.568
  assert.equal(rows[0].energy, 13.358);

  const recorded = [{ started_at: new Date(1782907300 * 1000).toISOString(), stopped_at: new Date(1782925200 * 1000).toISOString(), meter_start_wh: 5018676, meter_stop_wh: 5032034 }];
  const r2 = buildQuarterRows({ tracker, recorded, currentTotalKwh: 5627.548, start: range.start, end: range.end });
  assert.equal(r2.rows[0].source, 'gemeten');
  assert.equal(r2.rows[0].meterStart, 5018.676);
  assert.equal(r2.rows[0].energy, 13.358);

  const q2 = quarterRange('2026Q2', 'Europe/Amsterdam');
  assert.equal(buildQuarterRows({ tracker, recorded: [], currentTotalKwh: 1, start: q2.start, end: q2.end }).incomplete, true);
});

test('buildXlsx produces a zip with a worksheet and buildCsv a semicolon file', () => {
  const buf = buildXlsx([[{ v: 'Title', bold: true }], [], ['a', 1.5]]);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const csv = buildCsv({ rows: [{ start: 1782907271, end: 1782925140, meterStart: 1, meterStop: 2.5, energy: 1.5, source: 'gemeten' }], timeZone: 'Europe/Amsterdam' });
  assert.match(csv, /^sessie;starttijd/);
  assert.match(csv, /2026-07-01 14:01:11;2026-07-01 18:59:00;1\.000;2\.500;1\.500;gemeten/);
});
