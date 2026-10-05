// Climate at departure: timing, dedupe, log-only, retries — with agenda/vehicles/db stubbed.
process.env.DB_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const src = (m) => path.join(__dirname, '..', 'src', m);
function stub(mod, exports) { const f = require.resolve(src(mod)); require.cache[f] = { id: f, filename: f, loaded: true, exports }; }

const runs = new Map();
const fired = [];
let cfg = {};
let items = [];
let vehicle = { id: 1, name: 'Superb', source_type: 'http', source_config: '{"provider":"skoda","vin":"TMBJB9NY5RF999999"}' };
let ops = [];
stub('db', {
  prepare: (sql) => ({
    get: async (a) => (/climate_runs/.test(sql) ? runs.get(a) : vehicle),
    all: async () => [...runs.values()],
  }),
  upsert: async (table, row) => { runs.set(row.item_key, { ...runs.get(row.item_key), ...row }); },
});
stub('agenda', { getConfig: async () => cfg, items: async () => items });
stub('vehicles', {
  sourceKind: (v) => (JSON.parse(v.source_config || '{}').provider === 'skoda' ? 'skoda' : v.source_type),
  getVehicleStatus: () => ({ extra: { operations: ops } }),
  parseConfig: (v) => JSON.parse(v.source_config), secretOf: () => 'k',
});
stub('notifications', { fireCarEvent: async (type, key, ev) => { fired.push({ type, key, ev }); } });
const cc = require('../src/carClimate');

const LEAVE = Date.parse('2026-10-06T07:40:00Z');
const trip = { kind: 'trip', id: 3, title: 'Work', start: '2026-10-06T08:00:00Z', leaveAt: new Date(LEAVE).toISOString(), needsCar: true, climateC: 20, vehicle_id: 1 };
const reset = () => { runs.clear(); fired.length = 0; ops = []; vehicle.source_config = '{"provider":"skoda","vin":"TMBJB9NY5RF999999"}'; };

test('due: only in the window [leave − lead, leave), only with a temperature', () => {
  assert.equal(cc.due(trip, LEAVE - 21 * 60000, 20), false);
  assert.equal(cc.due(trip, LEAVE - 20 * 60000, 20), true);
  assert.equal(cc.due(trip, LEAVE - 1000, 20), true);
  assert.equal(cc.due(trip, LEAVE, 20), false);
  assert.equal(cc.due({ ...trip, climateC: null }, LEAVE - 60000, 20), false);
  assert.equal(cc.due({ ...trip, needsCar: false }, LEAVE - 60000, 20), false);
  assert.equal(cc.clampLead('2'), 5);
  assert.equal(cc.clampLead('x'), 20);
});

test('canClimate reads the operations list when the API gives one', () => {
  assert.equal(cc.canClimate([]), true);
  assert.equal(cc.canClimate(['startAirConditioning', 'stopAirConditioning']), true);
  assert.equal(cc.canClimate(['startCharging']), false);
});

test('mode off does nothing; log only writes it down once and sends nothing', async () => {
  reset(); items = [trip];
  cfg = { climate_mode: 'off', climate_lead_min: 20 };
  assert.deepEqual(await cc.tick(LEAVE - 10 * 60000), []);
  cfg = { climate_mode: 'log', climate_lead_min: 20 };
  let sent = 0;
  const r = await cc.tick(LEAVE - 10 * 60000, { command: async () => { sent++; } });
  assert.equal(r[0].status, 'logged');
  assert.equal(sent, 0);
  assert.equal((await cc.tick(LEAVE - 9 * 60000, { command: async () => { sent++; } })).length, 0, 'once per departure');
  assert.equal(fired[0].type, 'car_climate');
});

test('mode on sends the temperature once, with the battery choice', async () => {
  reset(); items = [trip];
  cfg = { climate_mode: 'on', climate_lead_min: 20, climate_on_battery: false };
  const bodies = [];
  const r = await cc.tick(LEAVE - 15 * 60000, { command: async (v, b) => { bodies.push(b); } });
  assert.equal(r[0].status, 'sent');
  assert.deepEqual(bodies[0], { targetTemperature: { value: 20, unit: 'CELSIUS' }, airConditioningWithoutExternalPower: false });
  await cc.tick(LEAVE - 14 * 60000, { command: async (v, b) => { bodies.push(b); } });
  assert.equal(bodies.length, 1);
});

test('a failed send is retried while there is time, then reported as failed', async () => {
  reset(); items = [trip];
  cfg = { climate_mode: 'on', climate_lead_min: 30 };
  const fail = async () => { const e = new Error('The car is not accepting requests right now.'); throw e; };
  let r = await cc.tick(LEAVE - 30 * 60000, { command: fail });
  assert.equal(r[0].status, 'retry');
  assert.equal(fired.length, 0, 'no message while retrying');
  assert.equal((await cc.tick(LEAVE - 29 * 60000, { command: fail })).length, 0, 'waits until next_at');
  r = await cc.tick(LEAVE - 26 * 60000, { command: fail });
  assert.equal(r[0].status, 'retry');
  r = await cc.tick(LEAVE - 22 * 60000, { command: fail });
  assert.equal(r[0].status, 'failed');
  assert.equal(r[0].attempts, 3);
  assert.equal(fired[0].ev.severity, 'warning');
});

test('skipped for a car without the Škoda API or without the operation', async () => {
  reset(); items = [trip];
  cfg = { climate_mode: 'on', climate_lead_min: 20 };
  vehicle.source_config = '{}';
  let r = await cc.tick(LEAVE - 10 * 60000, { command: async () => assert.fail('must not send') });
  assert.equal(r[0].status, 'skipped');
  reset(); ops = ['startCharging'];
  r = await cc.tick(LEAVE - 10 * 60000, { command: async () => assert.fail('must not send') });
  assert.equal(r[0].status, 'skipped');
});

test('a departure switched off for this time is left alone', async () => {
  reset(); items = [trip];
  cfg = { climate_mode: 'on', climate_lead_min: 20 };
  runs.set(cc.itemKey(trip), { item_key: cc.itemKey(trip), status: 'off' });
  assert.deepEqual(await cc.tick(LEAVE - 10 * 60000, { command: async () => assert.fail('must not send') }), []);
});
