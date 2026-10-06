// Energy manager: a consumer with more Loxone signals than a meter — on/off, status (enumerator),
// power and an energy counter — and what LoxSuite books and learns from them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb, db } = require('./helpers/testDb');
const em = require('../src/energyManager');

const SRC = (o) => em.sourcesOf({ src: o });

test('status values: lines, commas and colons', () => {
  assert.deepEqual(em.parseStatusMap('0=Off\n1=Washing, 2: Spinning;3 = Done'), { 0: 'Off', 1: 'Washing', 2: 'Spinning', 3: 'Done' });
  assert.deepEqual(em.parseStatusMap(''), {});
});

test('on/off is the basis: ≠ 0 is on, inverted when asked', () => {
  const src = SRC({ onoff: 'u-onoff' });
  assert.equal(em.loadState({ raw: { onoff: 1 }, src }).on, true);
  assert.equal(em.loadState({ raw: { onoff: 0 }, src }).on, false);
  assert.equal(em.loadState({ raw: { onoff: 0 }, src: SRC({ onoff: 'u', onoff_invert: true }) }).on, true);
  assert.equal(em.loadState({ raw: {}, src }).on, null);
});

test('status: label from the values, running values decide on/off without an on/off signal', () => {
  const src = SRC({ status: 'u-st', status_map: '0=Off\n1=Washing\n2=Spinning\n3=Done', status_on: '1,2' });
  const washing = em.loadState({ raw: { status: 1 }, src });
  assert.equal(washing.status, '1'); assert.equal(washing.label, 'Washing'); assert.equal(washing.on, true);
  assert.equal(em.loadState({ raw: { status: 3 }, src }).on, false); // Done is not running
  assert.equal(em.statusKey(washing), 'Washing');
  // without running values: everything except 0/off
  const src2 = SRC({ status: 'u-st', status_map: '0=Off\n1=Heating' });
  assert.equal(em.loadState({ raw: { status: 0 }, src: src2 }).on, false);
  assert.equal(em.loadState({ raw: { status: 1 }, src: src2 }).on, true);
  // a text state works too
  assert.equal(em.loadState({ raw: { status: 'Eco' }, src: SRC({ status: 'u' }) }).label, 'Eco');
});

test('power and energy: units converted, the meter block wins when there is one', () => {
  const src = SRC({ power: 'u-p', power_unit: 'W', energy: 'u-e', energy_unit: 'Wh' });
  const st = em.loadState({ raw: { power: 1850, energy: 123400 }, src });
  assert.equal(st.kw, 1.85); assert.equal(st.total, 123.4); assert.equal(st.on, true); assert.equal(st.measured, true);
  const m = em.loadState({ meter: { kw: 0.5, total: 10 }, raw: { power: 1850 }, src });
  assert.equal(m.kw, 0.5); assert.equal(m.total, 10);
  assert.equal(em.loadState({ raw: { power: 2 }, src: SRC({ power: 'u', power_unit: 'kW' }) }).kw, 2);
});

test('per status: hours, kWh and the typical kW only from measured kWh', () => {
  const rows = [
    { hour: '2026-10-05T10:00:00.000Z', status: 'Washing', minutes: 60, kwh: 1.8, measured: 1 },
    { hour: '2026-10-05T11:00:00.000Z', status: 'Spinning', minutes: 15, kwh: 0.1, measured: 1 },
    { hour: '2026-10-05T12:00:00.000Z', status: 'Off', minutes: 600, kwh: 0, measured: 0 },
  ];
  const s = em.statusSummary(rows, 1);
  const by = Object.fromEntries(s.map((x) => [x.status, x]));
  assert.equal(by.Washing.kw, 1.8);
  assert.equal(by.Spinning.kw, 0.4);
  assert.equal(by.Off.kw, null);
  assert.equal(s[0].status, 'Off'); // longest first
});

test('timeline: changes become segments, equal neighbours merged', () => {
  const t = (m) => new Date(Date.parse('2026-10-05T10:00:00Z') + m * 60000).toISOString();
  const segs = em.timeline([
    { ts: t(0), on_state: 1, status: '1', label: 'Washing' },
    { ts: t(50), on_state: 1, status: '2', label: 'Spinning' },
    { ts: t(60), on_state: 0, status: '3', label: 'Done' },
  ], Date.parse(t(0)), Date.parse(t(90)));
  assert.deepEqual(segs.map((s) => [s.key, (s.to - s.from) / 60000]), [['Washing', 50], ['Spinning', 10], ['Done', 30]]);
  const merged = em.timeline([{ ts: t(0), on_state: 1, status: null }, { ts: t(10), on_state: 1, status: null }], Date.parse(t(0)), Date.parse(t(20)));
  assert.equal(merged.length, 1);
});

// ------------------------------------------------------------------ booking, against a real database

let loadId;
before(async () => {
  await initTestDb();
  loadId = await db.insertReturningId("INSERT INTO energy_loads (name, kind, enabled, priority, settings, output, created_at) VALUES (?, 'appliance', 1, 5, ?, 'shadow', ?)",
    ['Washing machine', JSON.stringify({ kw: 2, src: { onoff: 'u-on', status: 'u-st', status_map: '0=Off\n1=Washing\n2=Spinning', status_on: '1,2' } }), new Date().toISOString()]);
});
after(async () => { await db.close(); });

test('sampling: minutes per status, estimated kWh from on × kW, change events and a run from the on/off signal', async () => {
  const t0 = Date.parse('2026-10-05T10:00:00Z');
  const seq = [[0, 0], [1, 1], [1, 1], [1, 1], [1, 2], [0, 0], [0, 0], [0, 0], [0, 0]];
  for (let i = 0; i < seq.length; i++) {
    const [on, status] = seq[i];
    await em.sample(t0 + i * 60000, { read: async () => em.loadState({ raw: { onoff: on, status }, src: em.sourcesOf({ src: { onoff: 'u-on', status: 'u-st', status_map: '0=Off\n1=Washing\n2=Spinning', status_on: '1,2' } }) }) });
  }
  const rows = await db.prepare('SELECT status, minutes, kwh, measured FROM load_status_hourly WHERE load_id = ? ORDER BY status').all(loadId);
  const by = Object.fromEntries(rows.map((r) => [r.status, r]));
  assert.equal(by.Washing.minutes, 3);
  assert.equal(by.Spinning.minutes, 1);
  assert.ok(Math.abs(by.Washing.kwh - 0.1) < 0.001, `estimated 3 min × 2 kW = 0.1 kWh, got ${by.Washing.kwh}`);
  assert.equal(by.Washing.measured, 0);
  const events = await db.prepare('SELECT label FROM load_events WHERE load_id = ? ORDER BY ts').all(loadId);
  assert.deepEqual(events.map((e) => e.label), ['Off', 'Washing', 'Spinning', 'Off']);
  const runs = await db.prepare("SELECT start_at, end_at FROM load_runs WHERE load_id = ? AND kind = 'run'").all(loadId);
  assert.equal(runs.length, 1, 'one run, ended 2 minutes after it went off');
  assert.equal(runs[0].start_at, new Date(t0 + 60000).toISOString());
  const hourly = await db.prepare('SELECT kwh FROM load_hourly WHERE load_id = ?').all(loadId);
  assert.ok(hourly.length && hourly[0].kwh > 0.1);
  const detail = await em.loadDetail((await em.listLoads()).find((l) => l.id === loadId), t0 + 9 * 60000);
  assert.ok(detail.timeline.length >= 3);
  assert.equal(detail.perStatus.find((x) => x.status === 'Washing').hours, 0.05);
});
