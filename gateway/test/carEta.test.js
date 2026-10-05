const test = require('node:test');
const assert = require('node:assert');
const eta = require('../src/carEta');

const osrm = (min, km) => async () => ({ ok: true, json: async () => ({ routes: [{ duration: min * 60, distance: km * 1000 }] }) });
const site = { lat: 52.1, lon: 5.1 };
const car = { id: 7, home_lat: null, home_lon: null };

test('parked away gives a lower bound, setting off gives an arrival', async () => {
  eta.reset();
  const t0 = Date.parse('2026-10-05T14:00:00Z');
  assert.strictEqual(eta.observe(7, { latitude: 52.4, longitude: 4.9, home: false, location: 'Work' }, t0), true);
  const parked = await eta.liveArrival(car, t0, { site, fetchFn: osrm(40, 45) });
  assert.strictEqual(parked.minAt, t0 + 40 * 60000);
  assert.ok(!parked.at);
  // sets off at 15:30 -> home ~ 15:30 + 44 min
  const t1 = Date.parse('2026-10-05T15:30:00Z');
  assert.strictEqual(eta.observe(7, { latitude: null, longitude: null, location: 'driving' }, t1 + 60000, t1), true);
  const driving = await eta.liveArrival(car, t1 + 60000, { site, fetchFn: osrm(40, 45) });
  assert.strictEqual(driving.source, 'driving');
  assert.strictEqual(driving.at, t1 + 44 * 60000);
  assert.match(driving.label, /from Work/);
  // still driving: no change; parked at home: change and nothing left
  assert.strictEqual(eta.observe(7, { location: 'driving' }, t1 + 120000), false);
  assert.strictEqual(eta.observe(7, { latitude: 52.1, longitude: 5.1, home: true }, t1 + 50 * 60000), true);
  assert.strictEqual(await eta.liveArrival(car, t1 + 50 * 60000, { site, fetchFn: osrm(40, 45) }), null);
});

test('a drive that takes longer than expected stays a few minutes ahead', () => {
  const now = Date.parse('2026-10-05T16:30:00Z');
  assert.strictEqual(eta.etaFromTrip({ nowMs: now, since: now - 60 * 60000, durationMin: 30 }), now + 5 * 60000);
});
