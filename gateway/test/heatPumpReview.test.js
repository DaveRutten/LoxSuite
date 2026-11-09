// The heat pump module review of 2026-11-08: COP without (or with partly missing) power, the advice
// without a COP and with nothing to compare, the history import, the object picker, legionella planned
// too early, the warm-up rate, pre-heating cut off, the comfort schedule, W instead of kW, a missed
// defrost, data gaps — and the set-up / data checks for the bell (energyChecks.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const tu = require('../src/heatPumpTuning');
const hp = require('../src/heatPumpTypes');
const lg = require('../src/legionella');
const rw = require('../src/roomWarmup');
const em = require('../src/energyModules');
const ec = require('../src/energyChecks');
const { mainState } = require('../src/loxoneObjects');

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const T0 = Date.UTC(2026, 10, 2);

// minute samples of one run of `min` minutes
function run(startMs, min, { elecKw = 1, heatKw = 4, setting = { flowC: 35, step: 0, ntc: 0 }, outdoorC = 4, rh = 85, elecEvery = 1 } = {}) {
  return Array.from({ length: min }, (_, i) => ({ ms: startMs + i * MIN, running: true, defrost: false, elecKw: i % elecEvery === 0 ? elecKw : null, heatKw, outdoorC, rh, ...setting }));
}

test('COP: heat of minutes without a power reading does not count (was COP 643)', () => {
  // power read only every 10th minute: before, all heat over a tenth of the power
  const rs = tu.runs([...run(T0, 60, { elecEvery: 10 }), { ms: T0 + 61 * MIN, running: false }, ...run(T0 + 2 * HOUR, 60, { elecEvery: 10 })]);
  assert.equal(rs.length, 2);
  assert.equal(rs[0].elecMin, 6);
  assert.equal(rs[0].elecKw, 1);
  assert.equal(rs[0].heatKw, 4);
  const model = tu.learn(rs);
  // too few minutes with a power reading for a COP (6 of 60)
  assert.equal(Object.values(model)[0].cop, null);
  const full = tu.learn(tu.runs([...run(T0, 60), { ms: T0 + 61 * MIN, running: false }, ...run(T0 + 2 * HOUR, 60)]));
  assert.equal(Object.values(full)[0].cop, 4);
});

test('advice without a COP still compares run length and defrosts, and says so', () => {
  const a = { flowC: 35, step: 0, ntc: 0 }, b = { flowC: 33, step: 0, ntc: 0 };
  const model = {
    x: { weather: '4|humid', setting: a, runs: 5, runMin: 20, defrostPerH: 2, cop: null },
    y: { weather: '4|humid', setting: b, runs: 5, runMin: 70, defrostPerH: 0.5, cop: null },
  };
  const c = tu.choose(model, { outdoorC: 4.5, rh: 85, current: a });
  assert.deepEqual(c.setting, b, 'the calmer one wins on run length and defrosts');
  assert.equal(c.useCop, false);
  assert.match(c.why, /no power measured/);
  assert.equal(tu.score({ cop: null, runMin: 40, defrostPerH: 0 }), Infinity, 'with the COP asked: no COP is no score');
});

test('only the current setting seen: no "best known", and after 10 runs a neighbour to try', () => {
  const cur = { flowC: 35, step: 0, ntc: 0 };
  const one = { x: { weather: '4|humid', setting: cur, runs: 4, runMin: 30, defrostPerH: 0.5, cop: 3.5 } };
  const few = tu.choose(one, { outdoorC: 4, rh: 85, current: cur });
  assert.equal(few.learned, false);
  assert.match(few.why, /nothing to compare/);
  const many = tu.choose({ x: { ...one.x, runs: 12 } }, { outdoorC: 4, rh: 85, current: cur });
  assert.deepEqual(many.explore, { flowC: 34, step: 0, ntc: 0 });
  assert.deepEqual(many.setting, cur, 'only advice: the setting itself stays');
  assert.match(many.why, /try flow 34 °C instead of 35 °C for a day/);
  const behind = tu.choose({ x: { ...one.x, runs: 12 } }, { outdoorC: 4, rh: 85, current: cur, roomBehindC: 1 });
  assert.equal(behind.explore, undefined, 'never while the room is behind');
});

test('history import merges per minute: an empty import keeps the live samples', () => {
  const live = [{ ms: T0, outdoorC: 4, elecKw: 1, heatKw: null }, { ms: T0 + MIN, outdoorC: 4, elecKw: 1 }];
  assert.deepEqual(em.mergeByMinute(live, []), live);
  const merged = em.mergeByMinute(live, [{ ms: T0 + 10, outdoorC: 9, elecKw: 2, heatKw: 3 }, { ms: T0 + 5 * MIN, outdoorC: 5 }]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].outdoorC, 4, 'live wins');
  assert.equal(merged[0].heatKw, 3, 'an empty live field is filled from the import');
});

test('object picker: a Meter gives its power (actual), not its first state', () => {
  assert.equal(mainState({ totalDay: 'u-day', actual: 'u-act', total: 'u-tot' }), 'u-act');
  assert.equal(mainState({ value: 'u-v' }), 'u-v');
  assert.equal(mainState({ something: 'u-s' }), 'u-s');
});

test('legionella: not more than a day before it is due, except on solar', () => {
  const nowMs = T0;
  const hours = Array.from({ length: 72 }, (_, i) => ({ ms: T0 + i * HOUR, price: i === 12 || i === 13 ? 0.05 : 0.3, surplusKwh: 0 }));
  const localHour = (ms) => new Date(ms).getUTCHours();
  // done 5 days ago, every 7 days: due in 2 days; the cheap block tomorrow 12:00 is too early
  const p = lg.planLegionella({ hours, nowMs, lastDoneMs: T0 - 5 * DAY, intervalDays: 7, localHour, fromHour: 10, toHour: 17 });
  assert.ok(p.block.startMs >= p.due - DAY, new Date(p.block.startMs).toISOString());
  const sunny = hours.map((h, i) => (i === 12 || i === 13 ? { ...h, surplusKwh: 4 } : h));
  const s = lg.planLegionella({ hours: sunny, nowMs, lastDoneMs: T0 - 5 * DAY, intervalDays: 7, localHour, fromHour: 10, toHour: 17 });
  assert.equal(s.block.startMs, T0 + 12 * HOUR, 'on solar surplus it may be earlier');
  assert.equal(s.block.solar, true);
});

test('warm-up rate: the slope over longer stretches, not 0 or 0.21 from a 0.1 °C sensor', () => {
  const S = [];
  // three mornings: 0.35 °C/h, the sensor in steps of 0.1 °C
  for (let d = 0; d < 3; d++) {
    for (let m = 0; m <= 150; m++) S.push({ ms: T0 + d * DAY + m * MIN, roomC: Math.floor((19 + 0.35 * (m / 60)) * 10) / 10, outdoorC: 4.5, heating: true, targetC: 20.5 });
    S.push({ ms: T0 + d * DAY + 151 * MIN, roomC: 20, outdoorC: 4.5, heating: false });
  }
  const m = rw.learn(S);
  const rate = m.bins[4].rate;
  assert.ok(rate > 0.3 && rate < 0.4, `rate ${rate}`);
});

test('pre-heating cut off at 8 h is reported, not silent', () => {
  const p = rw.preheat({ bins: { 4: { t: 4, rate: 0.2, windows: 5 } } }, { atMs: T0 + 10 * HOUR, nowMs: T0, fromC: 17, comfortC: 20.5, outdoorAt: () => 4.5 });
  assert.equal(p.capped, true);
  assert.ok(p.shortC > 1.5);
  assert.match(p.reason, /not reached within 8 h/);
  const ok = rw.preheat({ bins: { 4: { t: 4, rate: 0.5, windows: 5 } } }, { atMs: T0 + 10 * HOUR, nowMs: T0, fromC: 19, comfortC: 20.5, outdoorAt: () => 4.5 });
  assert.equal(ok.capped, false);
});

test('comfort schedule: a few sunny afternoons with an offset are no comfort schedule', () => {
  const localOf = (ms) => { const d = new Date(ms); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: (d.getUTCDay() + 6) % 7 }; };
  const s = [];
  for (let m = 0; m < 16 * 1440; m += 5) {
    const ms = T0 + m * MIN; const l = localOf(ms); const t = l.hour * 60 + l.minute;
    // Loxone stays on 20 °C; on 4 of 16 days the solar offset makes it 23.25 from 11:45 to 15:45
    const sunny = [2, 5, 9, 13].includes(Math.floor(m / 1440)) && t >= 11 * 60 + 45 && t < 15 * 60 + 45;
    s.push({ ms, targetC: sunny ? 23.25 : 20 });
  }
  const sc = rw.learnSchedule(s, localOf);
  assert.equal(sc.flat, true);
  assert.equal(sc.comfortC, 20);
  assert.equal(rw.learnSchedule(s.slice(0, 5 * 288), localOf), null, 'not from less than two weeks');
});

test('electric power in W is taken as W; the heat meter running backwards is a defrost', () => {
  const w = hp.interpret({ electricPower: 1350, compressorHz: 40, valveDhw: 0 });
  assert.equal(w.elecKw, 1.35);
  assert.equal(w.elecInW, true);
  const d = hp.interpret({ electricPower: 1.2, compressorHz: 40, valveDhw: 0, heatMeterFlowTemp: 21, heatMeterReturnTemp: 24.5 });
  assert.equal(d.mode, 'defrost');
  assert.equal(d.defrostByDT, true);
  assert.equal(hp.interpret({ electricPower: 1.2, compressorHz: 0, heatMeterFlowTemp: 21, heatMeterReturnTemp: 24.5 }).defrostByDT, false, 'standing still: no defrost');
});

test('data gaps: longer than 30 min, newest first, not before the first sample', () => {
  const xs = [0, 1, 2, 100, 101].map((m) => ({ ms: T0 + m * MIN }));
  const g = em.gapsIn(xs, { sinceMs: T0, nowMs: T0 + 102 * MIN });
  assert.deepEqual(g, [{ fromMs: T0 + 2 * MIN, toMs: T0 + 100 * MIN, min: 98 }]);
});

test('set-up and data checks for the bell', () => {
  const base = { cfg: { enabled: true, mode: 'shadow', tuning: { flow_max: 45 }, room: {} }, values: {}, state: {}, limits: { comfortMinC: 45, hpMaxC: 55 }, learned: { days: 20, patterns: [] }, tuning: { mode: 'advise' }, dataGaps: [] };
  const mem = {};
  const keys = (list) => list.map((c) => c.key.split('|')[0]);
  let c = ec.heatpumpChecks({ ...base, electricFrom: null }, mem, T0, { powerCandidate: 'Meter WarmtePomp' });
  assert.ok(keys(c).includes('power'));
  assert.match(c.find((x) => x.key.startsWith('power')).message, /Meter WarmtePomp/);
  assert.ok(keys(c).includes('shadow') && keys(c).includes('draws'));
  // a linked role without a value: only after 10 minutes
  const st = { ...base, electricFrom: 'module', dataCheck: { noValueRoles: ['electricPower'] } };
  const m2 = {};
  assert.ok(!keys(ec.heatpumpChecks(st, m2, T0)).includes('novalue'));
  assert.ok(keys(ec.heatpumpChecks(st, m2, T0 + 11 * MIN)).includes('novalue'));
  // implausible COP, W instead of kW, a data gap
  c = ec.heatpumpChecks({ ...base, electricFrom: 'module', state: { elecInW: true }, values: { electricPower: 1350 }, tuning: { mode: 'advise', lastRuns: [{ cop: 643 }] }, dataGaps: [{ fromMs: T0, toMs: T0 + 36 * HOUR, min: 2160 }] }, {}, T0 + 40 * HOUR);
  assert.ok(['cop', 'unitW', 'gap'].every((k) => keys(c).includes(k)), keys(c).join());
  // the same week: the same key (it goes out once)
  const a = ec.heatpumpChecks({ ...base, electricFrom: null }, {}, T0).find((x) => x.key.startsWith('power')).key;
  const b = ec.heatpumpChecks({ ...base, electricFrom: null }, {}, T0 + 2 * DAY).find((x) => x.key.startsWith('power')).key;
  assert.equal(a, b);
  assert.deepEqual(ec.heatpumpChecks({ ...base, cfg: { enabled: false } }, {}, T0), [], 'module off: nothing');
});
