const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb, db } = require('./helpers/testDb');
const energy = require('../src/energyMeters');

before(async () => { await initTestDb(); });
after(async () => { await db.close(); });

const structure = {
  controls: {
    g1: { type: 'Meter', name: 'Meter Grid', details: { type: 'bidirectional' }, states: { actual: 'ga', total: 'gt', totalNeg: 'gn' }, statisticV2: { groups: [{ id: '1', dataPoints: [{ output: 'actual' }] }, { id: '2', dataPoints: [{ output: 'total' }, { output: 'totalNeg' }] }] } },
    p1: { type: 'Meter', name: 'Meter PV', details: { type: 'unidirectional' }, states: { actual: 'pa', total: 'pt' }, statisticV2: { groups: [{ id: '2', dataPoints: [{ output: 'total' }] }] } },
    w1: { type: 'Wallbox2', name: 'Wallbox 11kW', states: { actual: 'wa', total: 'wt', connected: 'wc' } },
    l1: { type: 'LightControllerV2', name: 'Licht', states: {} },
  },
};

test('meterCandidates lists meters and wallboxes with a suggested role', () => {
  const c = energy.meterCandidates(structure, { id: 1, name: 'Gen 2' });
  assert.deepEqual(c.map((x) => [x.uuid, x.suggest]), [['g1', 'grid'], ['p1', 'pv'], ['w1', 'wallbox']]);
  assert.equal(c[0].bidirectional, true);
  assert.deepEqual(energy.totalStatGroup(structure.controls.g1), { id: '2', outputs: ['total', 'totalNeg'] });
  assert.equal(energy.totalStatGroup(structure.controls.w1), null);
});

test('readingFromValues and housePower follow the sign convention', () => {
  const grid = energy.readingFromValues('grid', { actual: 0.2, total: 100, totalNeg: 40 }, false);
  assert.deepEqual(grid, { role: 'grid', power_kw: 0.2, import_kwh: 100, export_kwh: 40 });
  const inv = energy.readingFromValues('grid', { actual: 0.2, total: 100, totalNeg: 40 }, true);
  assert.deepEqual(inv, { role: 'grid', power_kw: -0.2, import_kwh: 40, export_kwh: 100 });
  assert.equal(energy.housePower({ grid: { power_kw: -2 }, pv: { power_kw: 3.5 }, wallbox: { power_kw: 0 } }), 1.5);
  assert.equal(energy.housePower({ grid: { power_kw: 7 }, pv: { power_kw: 4 }, wallbox: { power_kw: 11 } }), 0);
  assert.equal(energy.housePower({ pv: { power_kw: 3 } }), null);
});

test('houseHourKwh and safeDelta', () => {
  assert.equal(energy.houseHourKwh({ grid: { import_kwh: 1, export_kwh: 2 }, pv: { import_kwh: 3 }, wallbox: { import_kwh: 0.5 } }), 1.5);
  assert.equal(energy.houseHourKwh({ grid: { import_kwh: 11.4, export_kwh: 0 }, wallbox: { import_kwh: 11 } }), 0.4);
  assert.equal(energy.houseHourKwh({ pv: { import_kwh: 3 } }), null);
  assert.ok(Math.abs(energy.safeDelta(10, 10.2, 60000) - 0.2) < 1e-9);
  assert.equal(energy.safeDelta(10, 9, 60000), 0); // reset
  assert.equal(energy.safeDelta(10, 500, 60000), 0); // impossible jump
  assert.equal(energy.safeDelta(null, 5, 60000), 0);
});

test('parseStatisticsResult reads the MCP control_statistics answer', () => {
  const res = { content: [{ type: 'text', text: JSON.stringify({ header: [{ output: 'total' }, { output: 'totalNeg' }], rows: [{ ts: '2026-10-03T20:00:00Z', values: [11.39, 0] }, { ts: '2026-10-03T21:00:00Z', values: [3.18, 0.5] }] }) }] };
  assert.deepEqual(energy.parseStatisticsResult(res), [
    { hour: '2026-10-03T20:00:00.000Z', total: 11.39, totalNeg: 0 },
    { hour: '2026-10-03T21:00:00.000Z', total: 3.18, totalNeg: 0.5 },
  ]);
  assert.throws(() => energy.parseStatisticsResult({ isError: true, content: [{ type: 'text', text: 'Unauthorized' }] }), /Unauthorized/);
});

test('roleHealth: unknown during start-up, failing after 10 minutes without values', () => {
  const now = 1_000_000_000;
  assert.equal(energy.roleHealth(now - 60000, now, now - 3600000), 'ok');
  assert.equal(energy.roleHealth(null, now, now - 60000), 'unknown');
  assert.equal(energy.roleHealth(null, now, now - 11 * 60000), 'failing');
  assert.equal(energy.roleHealth(now - 11 * 60000, now, now - 3600000), 'failing');
});

test('importHistory stores hourly kWh from Loxone and derives the house', async () => {
  const msId = await db.insertReturningId(
    "INSERT INTO miniservers (name, host, http_port, username, password) VALUES ('Gen 2', '127.0.0.1', 8099, 'u', 'p')",
    []
  );
  for (const [role, uuid] of [['grid', 'g1'], ['pv', 'p1']]) {
    await db.upsert('energy_meters', { role, miniserver_id: msId, control_uuid: uuid, invert: 0, enabled: 1 }, ['role']);
  }
  // Structure comes from the cache filled here (no Miniserver is reachable in the test).
  require('../src/loxoneStructure').getStructure = async () => structure;
  energy.resetRuntime();
  const calls = [];
  const fake = async (ms, name, input) => {
    calls.push(input);
    const rows = input.uuid === 'g1'
      ? { header: [{ output: 'total' }, { output: 'totalNeg' }], rows: [{ ts: '2026-09-01T10:00:00Z', values: [0.2, 1.5] }, { ts: '2026-09-01T11:00:00Z', values: [0.6, 0] }] }
      : { header: [{ output: 'total' }], rows: [{ ts: '2026-09-01T10:00:00Z', values: [2.3] }, { ts: '2026-09-01T11:00:00Z', values: [0.4] }] };
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  };
  const report = await energy.importHistory(2, { callTool: fake });
  assert.deepEqual(report.map((r) => [r.role, r.ok, r.hours]), [['grid', true, 2], ['pv', true, 2]]);
  assert.equal(calls[0].group_id, '2');
  assert.equal(calls[0].dp_unit, 'hour');
  const house = await db.prepare("SELECT hour, import_kwh, source FROM energy_hourly WHERE role = 'house' ORDER BY hour").all();
  assert.deepEqual(house, [
    { hour: '2026-09-01T10:00:00.000Z', import_kwh: 1, source: 'derived' }, // 0.2 - 1.5 + 2.3
    { hour: '2026-09-01T11:00:00.000Z', import_kwh: 1, source: 'derived' }, // 0.6 + 0.4
  ]);
  const s = await energy.hourlySeries('2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
  assert.equal(s.hours.length, 24);
  assert.equal(s.series.pv[10], 2.3);
  assert.equal(s.exported.grid[10], 1.5);
});
