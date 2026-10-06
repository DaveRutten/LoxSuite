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

test('text status (Loxone Status block): name and countdown left off, off-words mean not running', () => {
  assert.equal(em.cleanStatusText('Wasmachine uitgeschakeld', 'Wasmachine'), 'Uitgeschakeld');
  assert.equal(em.cleanStatusText('Wasmachine wassen - nog 45 min', 'Wasmachine'), 'Wassen');
  assert.equal(em.cleanStatusText('Wasmachine Spoelen (nog 0:12)', 'Wasmachine'), 'Spoelen');
  assert.equal(em.cleanStatusText('Droger: Drogen 35%', 'Droger'), 'Drogen');
  assert.equal(em.cleanStatusText('Wasmachine klaar om 14:30', 'Wasmachine'), 'Klaar');
  assert.equal(em.cleanStatusText('Wasmachine', 'Wasmachine'), 'Wasmachine');
  for (const t of ['Uitgeschakeld', 'Klaar', 'Programma beëindigd', 'Pauze', 'Uitgestelde start', 'Off', 'Stand-by']) assert.equal(em.isOffText(t), true, t);
  for (const t of ['Wassen', 'Centrifugeren', 'Drogen', 'Kreukbescherming', 'Eco 40-60']) assert.equal(em.isOffText(t), false, t);
  const src = SRC({ status: 'u-text' });
  const off = em.loadState({ raw: { status: 'Wasmachine uitgeschakeld' }, src, name: 'Wasmachine' });
  assert.equal(off.label, 'Uitgeschakeld'); assert.equal(off.on, false);
  const on = em.loadState({ raw: { status: 'Wasmachine wassen - nog 45 min' }, src, name: 'Wasmachine' });
  assert.equal(on.status, 'Wassen'); assert.equal(on.on, true);
  // "Uitgeschakeld" is just off: booked with the on/off signal's off, also older rows in the summary
  assert.equal(em.statusKey(off), 'off');
  assert.equal(em.statusKey(on), 'Wassen');
  const sum = em.statusSummary([{ status: 'off', minutes: 60, kwh: 0 }, { status: 'Uitgeschakeld', minutes: 30, kwh: 0 }, { status: 'Klaar', minutes: 10, kwh: 0 }], 1);
  assert.deepEqual(sum.map((x) => x.status), ['off', 'Klaar']);
  assert.equal(sum[0].hours, 1.5);
  // numeric status with a label "Done" is not running either
  assert.equal(em.loadState({ raw: { status: 3 }, src: SRC({ status: 'u', status_map: '3=Done' }) }).on, false);
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
  assert.equal(by.off.kw, null); // "Off" is booked as off
  assert.equal(s[0].status, 'off'); // longest first
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

test('scheduled start (Home Connect): from the status text or a "start in" signal, counted as not running', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  assert.deepEqual(em.scheduledFromText('Droger ingepland', now), { scheduled: true, startMs: null });
  assert.equal(em.scheduledFromText('Ingepland - start over 3 uur', now).startMs, now + 3 * 3600000);
  assert.equal(em.scheduledFromText('Uitgestelde start, over 2 uur 30 min', now).startMs, now + 150 * 60000);
  assert.equal(em.scheduledFromText('Start over 1:15', now).startMs, now + 75 * 60000);
  assert.equal(em.scheduledFromText('Wasmachine wassen', now).scheduled, false);
  assert.equal(em.isOffText('Ingepland'), true);
  // a "start in" signal (hours) wins
  const st = em.loadState({ raw: { status: 'Wasmachine ingepland', startIn: 4 }, src: SRC({ status: 'u', start_in: 'u2' }), name: 'Wasmachine', nowMs: now });
  assert.equal(st.on, false); assert.equal(st.startAt, now + 4 * 3600000);
  // without the signal: the text's time
  const st2 = em.loadState({ raw: { status: 'Ingepland - start over 45 min' }, src: SRC({ status: 'u' }), nowMs: now });
  assert.equal(st2.startAt, now + 45 * 60000);
});

test('history: runs from imported kWh per hour (stand-by left out)', () => {
  const h = (i, kwh) => ({ hour: new Date(Date.parse('2026-10-01T08:00:00Z') + i * 3600000).toISOString(), kwh });
  const runs = em.runsFromHourly([h(0, 0.01), h(1, 0.9), h(2, 1.1), h(3, 0.02), h(5, 0.06), h(8, 1.5)]);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].start_at, '2026-10-01T09:00:00.000Z'); assert.equal(runs[0].end_at, '2026-10-01T11:00:00.000Z'); assert.equal(runs[0].kwh, 2);
  assert.equal(runs[1].kwh, 1.5);
});

test('Home Connect operation state: running only while the program runs, Gereed = ready to start, Inactief = off', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const src = SRC({ status: 'u', status_map: em.HOME_CONNECT_STATUS, status_on: em.HOME_CONNECT_RUNNING });
  const at = (v, extra = {}) => em.loadState({ raw: { status: v, ...extra }, src: extra.src || src, nowMs: now });
  assert.equal(at(3).on, true); assert.equal(at(3).label, 'Programma loopt');
  for (const v of [0, 1, 2, 4, 5, 6, 7, 8]) assert.equal(at(v).on, false, String(v));
  assert.equal(em.statusKey(at(0)), 'off');
  assert.equal(at(1).readyToStart, true);
  assert.equal(at(3).readyToStart, false);
  assert.equal(at(6).readyToStart, false);
  // delayed start with a "start in" signal: scheduled, not ready (it starts by itself)
  const d = em.loadState({ raw: { status: 2, startIn: 3 }, src: SRC({ status: 'u', status_map: em.HOME_CONNECT_STATUS, status_on: '3', start_in: 'u2' }), nowMs: now });
  assert.equal(d.startAt, now + 3 * 3600000); assert.equal(d.readyToStart, false);
  // without a numbered list nothing is "running" by mistake: voltooid/fout/actie vereist are not running
  for (const t of ['Programma voltooid', 'Fout', 'Actie vereist', 'Programma afgebroken', 'Inactief']) assert.equal(em.isOffText(t), true, t);
  // a ready signal of its own wins
  assert.equal(em.loadState({ raw: { status: 0, ready: 1 }, src: SRC({ status: 'u', ready: 'r' }), nowMs: now }).readyToStart, true);
});

test('appliance in steps: cheapest hours with pauses of at most maxGapH, one block when pausing is off', () => {
  const t0 = Date.parse('2026-10-06T10:00:00Z');
  const prices = [0.30, 0.10, 0.40, 0.40, 0.12, 0.50, 0.11, 0.60];
  const H = prices.map((p, i) => ({ ms: t0 + i * 3600000, price: p }));
  const costOf = (i) => prices[i];
  // no pausing: the cheapest 2 hours in a row
  const one = em.bestSteps(H, { dur: 2, readyBy: t0 + 8 * 3600000, costOf });
  assert.deepEqual(one.idx, [0, 1]); assert.equal(one.pauses, 0);
  // pauses up to 2 h: 10:00-ish cheap hour 1, then 4 (gap 2 h), then 6 (gap 1 h)
  const steps = em.bestSteps(H, { dur: 3, readyBy: t0 + 8 * 3600000, maxGapH: 2, maxPauses: 2, costOf });
  assert.deepEqual(steps.idx, [1, 4, 6]); assert.equal(steps.pauses, 2);
  // at most one pause
  const onePause = em.bestSteps(H, { dur: 3, readyBy: t0 + 8 * 3600000, maxGapH: 2, maxPauses: 1, costOf });
  assert.equal(onePause.pauses <= 1, true);
  // gap of 3 h never allowed with maxGapH 2
  for (const r of [steps, onePause]) for (let k = 1; k < r.idx.length; k++) assert.ok(r.idx[k] - r.idx[k - 1] - 1 <= 2);
  // must be done by readyBy
  const early = em.bestSteps(H, { dur: 2, readyBy: t0 + 3 * 3600000, maxGapH: 2, maxPauses: 2, costOf });
  assert.ok(early.idx.every((i) => i < 3));
  assert.equal(em.bestSteps(H, { dur: 9, readyBy: t0 + 8 * 3600000, costOf }), null);
});
