// The heat pump review, second part: the setpoint as a mode, the booster meter in the SCOP, predictions
// measured in shadow mode, data quality, and the good news in the bell (energyChecks.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const hp = require('../src/heatPumpTypes');
const em = require('../src/energyModules');
const ec = require('../src/energyChecks');

const MIN = 60000;
const HOUR = 3600000;
const T0 = Date.UTC(2026, 10, 2);

test('setpoint as a mode: only the three values of the own Loxone logic are written', () => {
  const et = require('../src/energyTypes');
  const type = et.loadTypes('heatpump').find((t) => t.key === 'mitsubishi-ecodan-a1m');
  const sm = { hold: 40, normal: 52, high: 60 };
  const val = (plan) => hp.writesFor({ type, plan, now: { tankTemp: 45 }, settings: { setpointModes: sm } }).find((w) => w.role === 'dhwSetpoint').value;
  assert.equal(val({ mode: 'free' }), 40);
  assert.equal(val({ mode: 'dhw' }), 52);
  assert.equal(val({ mode: 'dhw', buffer: true }), 60);
  assert.equal(val({ mode: 'legionella' }), 60);
  const without = hp.writesFor({ type, plan: { mode: 'free' }, now: { tankTemp: 45 }, settings: { comfortMinC: 45 } }).find((w) => w.role === 'dhwSetpoint');
  assert.ok(!without || without.value !== 40, 'without the setting: the setpoint as before');
});

test('the booster meter counts in the SCOP: its power is heat at COP 1, kept apart', () => {
  const hw = require('../src/heatPumpWeather');
  const s = Array.from({ length: 120 }, (_, i) => ({ ms: i * MIN, elecKw: 1, heatKw: 4, boostKw: i < 60 ? 3 : 0 }));
  const r = hw.scop(hw.dailyEnergy(s, () => '2026-11-02'));
  assert.equal(r.boostKwh, 3);
  // (8 heat + 3 booster) / (2 power + 3 booster) = 2.2
  assert.equal(r.scop, 2.2);
});

test('predictions in shadow mode: written down per hour, compared with what the sensors read', () => {
  const nowMs = T0 + 10 * MIN;
  const plan = [{ ms: T0 + HOUR, roomC: 20.4, predC: 48 }, { ms: T0 + 20 * HOUR, roomC: 19.5, predC: 46 }];
  const p = em.predictionsOf(plan, nowMs);
  assert.deepEqual(p.map((x) => `${x.kind}|${x.horizon}`).sort(), ['hp:room|d1', 'hp:tank|d1', 'hp:tank|h1']);
  assert.equal(em.valueAt([{ ms: T0, roomC: 20 }, { ms: T0 + 5 * MIN, roomC: 20.2 }, { ms: T0 + 30 * MIN, roomC: 25 }], T0 + 2 * MIN, 'roomC'), 20.1);
  assert.deepEqual(em.tempAccuracy([{ predicted: 20, actual: 20.3 }, { predicted: 20, actual: 21 }]), { n: 2, maeC: 0.65, within: 0.5 });
});

test('data quality: plausible values per unit', () => {
  assert.equal(ec.plausibleValue('°C', 48.5), true);
  assert.match(ec.plausibleValue('kW', 1350), /W instead of kW/);
  assert.match(ec.plausibleValue('°C', 250), /outside/);
  assert.equal(ec.plausibleValue('°C', null), null);
});

test('good news in the bell: settings compared, a sunny day tomorrow, last month, what was learned', () => {
  const base = { cfg: { enabled: true, mode: 'shadow', tuning: {}, room: {} }, electricFrom: 'module', values: {}, state: {}, limits: { targetC: 52, bufferMaxC: 58, hpMaxC: 55 }, learned: { days: 3, patterns: [1] }, tuning: { mode: 'advise' }, dataGaps: [] };
  const dec2 = Date.UTC(2026, 11, 2, 16);
  const plan = Array.from({ length: 8 }, (_, i) => ({ ms: Date.UTC(2026, 11, 3, 10 + i), surplusKwh: 1.5 }));
  const c = ec.heatpumpChecks({ ...base, tuningWeathers: { seen: 3, compared: 2 }, plan, report: [{ month: '2026-11', days: 30, heatKwh: 900, elecKwh: 250, scop: 3.6, costEur: 61.2, savedEur: 7.4 }] }, {}, dec2);
  const keys = c.map((x) => x.key);
  assert.ok(keys.includes('milestone|compared|2'), keys.join());
  assert.ok(keys.includes('sun|2026-12-03'), keys.join());
  assert.ok(keys.includes('month|2026-11'), keys.join());
  assert.match(c.find((x) => x.key === 'month|2026-11').message, /SCOP 3\.6/);
  const m = ec.learnedMessage([{ label: 'Room warms up', kind: 'changed', from: '0.21 °C/h', to: '0.34 °C/h' }, { label: 'Usual tap-water draws', kind: 'new', to: '07:00' }, { label: 'x', kind: 'gone', from: '1' }], dec2);
  assert.equal(m.key, 'learned|2026-12-02');
  assert.match(m.message, /0\.21 °C\/h → 0\.34 °C\/h; Usual tap-water draws: 07:00\.$/);
  assert.equal(ec.learnedMessage([{ kind: 'gone', label: 'x' }], dec2), null);
});
