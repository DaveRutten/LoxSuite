// Route options and which car (v0.54): a default for every address (avoid ferries / toll roads /
// motorways), per address your own choice where the route takes one of them, and per appointment (or
// series) which car when LoxSuite knows more than one.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb, db } = require('./helpers/testDb');
const agenda = require('../src/agenda');

const H = 3600000;
const day = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime() + 2 * 86400000; })();
const at = (h) => new Date(day + h * H).toISOString();
let calId;
let carA;
let carB;

before(async () => {
  await initTestDb();
  const settings = require('../src/wallboxSettings');
  await settings.set('site', { lat: 52.0, lon: 5.0 });
  await settings.set('agenda', { ...agenda.DEFAULTS, geo: true, margin_km: 0 });
  const car = (name, type, kwh, kpk) => db.insertReturningId("INSERT INTO vehicles (name, type, battery_kwh, kwh_per_km, enabled, source_type, created_at) VALUES (?, ?, ?, ?, 1, 'none', ?)", [name, type, kwh, kpk, new Date().toISOString()]);
  carA = await car('Family car', 'phev', 13, 0.2);
  carB = await car('City EV', 'bev', 50, 0.15);
  calId = await db.insertReturningId('INSERT INTO calendars (name, url, color, enabled, created_at) VALUES (?, ?, ?, 1, ?)', ['Gezin', 'x', '#3366cc', new Date().toISOString()]);
});

after(async () => { await db.close(); });

test('avoidFor: your choice for an address wins over the default; avoiding wins between two addresses', () => {
  const prefs = { 'veerweg 1, texel': { ferry: false }, 'tolweg 2': { toll: true } };
  assert.deepEqual(agenda.avoidFor(['Plein 1'], ['ferry'], prefs), ['ferry'], 'the default');
  assert.deepEqual(agenda.avoidFor(['  Veerweg 1,  TEXEL '], ['ferry'], prefs), [], 'allowed for this address (written differently)');
  assert.deepEqual(agenda.avoidFor(['Tolweg 2'], [], prefs), ['toll']);
  // a drive between two addresses: one that avoids it wins, one that allows it beats the default
  assert.deepEqual(agenda.avoidFor(['Tolweg 2', 'Veerweg 1, Texel'], ['ferry', 'motorway'], prefs), ['toll', 'motorway']);
  assert.deepEqual(agenda.avoidFor([], undefined, undefined), []);
});

test('routeFlags: a ferry step, toll and motorway from the road classes; other classes ignored', () => {
  const r = { legs: [{ steps: [
    { mode: 'driving', intersections: [{ classes: ['motorway'] }, { classes: ['restricted'] }] },
    { mode: 'ferry', intersections: [{}] },
    { mode: 'driving', intersections: [{ classes: ['toll', 'motorway'] }] },
  ] }] };
  assert.deepEqual(agenda.routeFlags(r), ['ferry', 'toll', 'motorway']);
  assert.deepEqual(agenda.routeFlags({ legs: [{ steps: [{ mode: 'driving' }] }] }), []);
  assert.deepEqual(agenda.routeFlags(null), []);
});

test('osrmRoute: asks without what it avoids; a server that can\'t falls back to the plain route', async () => {
  const urls = [];
  const ferryRoute = { routes: [{ distance: 41200, duration: 3000, legs: [{ steps: [{ mode: 'ferry' }] }] }] };
  const around = { routes: [{ distance: 128000, duration: 5400, legs: [{ steps: [{ mode: 'driving', intersections: [{ classes: ['motorway'] }] }] }] }] };
  let r = await agenda.osrmRoute(async (u) => { urls.push(u); return /exclude=ferry/.test(u) ? around : ferryRoute; }, { lat: 52, lon: 5 }, { lat: 53, lon: 4.8 }, ['ferry']);
  assert.deepEqual(r, { distance_km: 128, duration_min: 90, route_flags: 'motorway' });
  assert.match(urls[0], /steps=true&exclude=ferry$/);
  // exclude not supported (an error): the plain route, which shows it still takes the ferry
  urls.length = 0;
  r = await agenda.osrmRoute(async (u) => { urls.push(u); if (/exclude/.test(u)) throw new Error('InvalidValue'); return ferryRoute; }, { lat: 52, lon: 5 }, { lat: 53, lon: 4.8 }, ['ferry']);
  assert.deepEqual(r, { distance_km: 41.2, duration_min: 50, route_flags: 'ferry' });
  assert.equal(urls.length, 2);
  // nothing to avoid: one request; '' = looked, none of them
  urls.length = 0;
  r = await agenda.osrmRoute(async (u) => { urls.push(u); return { routes: [{ distance: 5000, duration: 600, legs: [] }] }; }, { lat: 52, lon: 5 }, { lat: 52.1, lon: 5 });
  assert.equal(r.route_flags, '');
  assert.equal(urls.length, 1);
  assert.doesNotMatch(urls[0], /exclude/);
});

test('setRoutePref: avoid, allow or back to the default — per kind, per address', async () => {
  assert.deepEqual(await agenda.setRoutePref('Veerweg 1, Texel', { ferry: true, toll: false }), { ferry: true, toll: false });
  assert.deepEqual(await agenda.setRoutePref('veerweg 1,  texel', { toll: null, motorway: 'x' }), { ferry: true }, 'unknown values: the default');
  assert.deepEqual((await agenda.routePrefs())['veerweg 1, texel'], { ferry: true });
  assert.deepEqual(await agenda.setRoutePref('Veerweg 1, Texel', { ferry: null }), {});
  assert.equal((await agenda.routePrefs())['veerweg 1, texel'], undefined, 'nothing chosen: gone');
  await assert.rejects(agenda.setRoutePref('  ', { ferry: true }), /No address/);
});

test('distanceFromHome: one cached route per set of options, the address looked up once', async () => {
  const calls = [];
  const get = async (u) => {
    calls.push(u);
    if (u.includes('nominatim')) return [{ lat: '53.05', lon: '4.8' }];
    return /exclude=ferry/.test(u)
      ? { routes: [{ distance: 128000, duration: 5400, legs: [] }] }
      : { routes: [{ distance: 41200, duration: 3000, legs: [{ steps: [{ mode: 'ferry' }] }] }] };
  };
  const plain = await agenda.distanceFromHome('Haven 5, Texel', { get });
  assert.deepEqual([plain.distance_km, plain.route_flags, plain.query], [41.2, 'ferry', 'haven 5, texel|52.0000,5.0000']);
  await agenda.setRoutePref('Haven 5, Texel', { ferry: true });
  const without = await agenda.distanceFromHome('Haven 5, Texel', { get });
  assert.deepEqual([without.distance_km, without.route_flags, without.query], [128, '', 'haven 5, texel|52.0000,5.0000|x:ferry']);
  assert.equal(calls.filter((u) => u.includes('nominatim')).length, 1, 'the coordinates from the first lookup');
  // both stay cached: back to the ferry costs no request
  await agenda.setRoutePref('Haven 5, Texel', { ferry: null });
  const n = calls.length;
  assert.equal((await agenda.distanceFromHome('Haven 5, Texel', { get })).distance_km, 41.2);
  assert.equal(calls.length, n);
});

test('an appointment shows what its route takes, and the distance without it once you choose that', async () => {
  await db.upsert('calendar_events', { calendar_id: calId, uid: 'texel@t', start_at: at(9), end_at: at(17), all_day: 0, title: 'Strand', location: 'Haven 5, Texel', car_tag: 1, car_hint: null, trip_tag: null, recurrence_at: null }, ['calendar_id', 'uid', 'start_at']);
  const find = async () => (await agenda.items(at(0), at(24))).find((i) => i.uid === 'texel@t');
  let it = await find();
  assert.deepEqual(it.route, { avoid: [], uses: ['ferry'], choice: {} });
  assert.equal(it.distanceKm, 41.2);
  await agenda.setRoutePref('Haven 5, Texel', { ferry: true });
  it = await find();
  assert.deepEqual(it.route, { avoid: ['ferry'], uses: [], choice: { ferry: true } });
  assert.equal(it.distanceKm, 128);
  assert.equal(it.travelMin, 90);
  // the default avoids ferries, this address allows them
  const settings = require('../src/wallboxSettings');
  await settings.set('agenda', { ...agenda.DEFAULTS, geo: true, margin_km: 0, route_avoid: ['ferry'] });
  await agenda.setRoutePref('Haven 5, Texel', { ferry: false });
  it = await find();
  assert.deepEqual([it.route.avoid, it.distanceKm], [[], 41.2]);
  await agenda.setRoutePref('Haven 5, Texel', { ferry: null });
  assert.deepEqual((await find()).route.avoid, ['ferry'], 'as the default');
  await settings.set('agenda', { ...agenda.DEFAULTS, geo: true, margin_km: 0 });
});

test('cleanVehicle: a vehicle id, or nothing chosen', () => {
  assert.equal(agenda.cleanVehicle('3'), 3);
  assert.equal(agenda.cleanVehicle(2), 2);
  for (const v of ['', null, undefined, '0', '-1', 'x', '1.5']) assert.equal(agenda.cleanVehicle(v), null, String(v));
});

test('which car: the calendar\'s car, else the first; chosen for one day or for the whole series', async () => {
  for (const [uid, h] of [['zw@t', 0], ['zw@t', 7 * 24]]) {
    await db.upsert('calendar_events', { calendar_id: calId, uid, start_at: at(h + 18), end_at: at(h + 19), all_day: 0, title: 'Zwemles', location: null, car_tag: 1, car_hint: '{"km":20}', trip_tag: null, recurrence_at: at(h + 18) }, ['calendar_id', 'uid', 'start_at']);
  }
  const both = async () => (await agenda.items(at(0), at(8 * 24))).filter((i) => i.uid === 'zw@t');
  let [a, b] = await both();
  assert.deepEqual([a.vehicle_id, a.vehicleSource, a.kwhPerKm], [null, null, 0.2], 'no choice: the first car');
  await db.prepare('UPDATE calendars SET vehicle_id = ? WHERE id = ?').run(carB, calId);
  [a] = await both();
  assert.deepEqual([a.vehicle_id, a.vehicleSource, a.kwhPerKm], [carB, 'calendar', 0.15]);
  // this day: the family car
  await agenda.setOverride({ calendar_id: calId, uid: 'zw@t', start_at: at(18), vehicle_id: String(carA) });
  [a, b] = await both();
  assert.deepEqual([a.vehicle_id, a.vehicleSource, b.vehicle_id], [carA, 'you', carB]);
  // the whole series: the family car; the day choice gives way
  await agenda.setOverride({ calendar_id: calId, uid: 'zw@t', start_at: at(7 * 24 + 18), vehicle_id: carA, scope: 'series' });
  [a, b] = await both();
  assert.deepEqual([a.vehicle_id, a.vehicleSource, b.vehicle_id, b.vehicleSource], [carA, 'series', carA, 'series']);
  assert.equal(a.day.vehicle_id, null);
  assert.equal(a.series.vehicle_id, carA);
  // Smart charging plans the drives for the car that makes them
  const drives = (await agenda.tours(at(0), at(8 * 24))).filter((t) => t.title === 'Zwemles');
  assert.deepEqual(drives.map((t) => t.vehicle_id), [carA, carA]);
  // back to the calendar's car
  await agenda.setOverride({ calendar_id: calId, uid: 'zw@t', start_at: at(18), vehicle_id: '', scope: 'series' });
  [a] = await both();
  assert.deepEqual([a.vehicle_id, a.vehicleSource], [carB, 'calendar']);
});

test('a calendar\'s name, colour and car: in LoxSuite only, only what is given changes', async () => {
  const id = await db.insertReturningId('INSERT INTO calendars (name, url, color, enabled, created_at) VALUES (?, ?, ?, 1, ?)', ['Werk', 'y', '#FF2968FF', new Date().toISOString()]);
  let c = await agenda.updateCalendar(id, { name: '  Gezin   thuis ', color: '#00AA88' });
  assert.deepEqual([c.name, c.color, c.vehicle_id, c.enabled], ['Gezin thuis', '#00aa88', null, 1]);
  c = await agenda.updateCalendar(id, { vehicle_id: String(carB) });
  assert.deepEqual([c.name, c.color, c.vehicle_id], ['Gezin thuis', '#00aa88', carB], 'name and colour kept');
  c = await agenda.updateCalendar(id, { name: ' ', color: 'red', vehicle_id: '999' });
  assert.deepEqual([c.name, c.color, c.vehicle_id, c.enabled], ['Gezin thuis', '#00aa88', null, 1], 'empty name / no colour kept, unknown car: none');
  assert.equal(await agenda.updateCalendar(99999, { name: 'x' }), null);
  // what the agenda shows
  await db.upsert('calendar_events', { calendar_id: id, uid: 'w@t', start_at: at(10), end_at: at(11), all_day: 0, title: 'Overleg', location: null, car_tag: 0, car_hint: null, trip_tag: null, recurrence_at: null }, ['calendar_id', 'uid', 'start_at']);
  const it = (await agenda.items(at(0), at(24))).find((i) => i.uid === 'w@t');
  assert.deepEqual([it.calendar, it.color], ['Gezin thuis', '#00aa88']);
});
