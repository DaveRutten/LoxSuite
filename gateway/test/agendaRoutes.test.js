// How you drive to an appointment (v0.46): drop off and pick up (there and back at the start, and
// again at the end — the car is home in between), only drop off / only pick up, from the calendar
// text (#brengen / #halen) or chosen in LoxSuite per day or for the whole series; and driving on from
// one appointment to the next (home → 1 → 2 → 3 → home) as one route with the real distances.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb, db } = require('./helpers/testDb');
const agenda = require('../src/agenda');

const H = 3600000;
const M = 60000;

test('parseTripTag: #brengen, #halen, both — in Dutch and English', () => {
  const cases = {
    '🚗 Hond #brengen': 'drop', '#halen Max': 'pick', 'Max #ophalen': 'pick', '#brengen #halen': 'both', '#brengenhalen opvang': 'both',
    '#brengen en halen': 'both', '#brengen/halen': 'both', '#Brengen & #Halen': 'both', '#drop': 'drop', '#pickup': 'pick',
    '#dropoff/pickup': 'both', '#wegbrengen': 'drop', 'niks': null, 'auto #halende': null, '#brengenx': null, 'brengen': null,
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(agenda.parseTripTag(text), want, text);
});

test('stopsOf: the car stays there, or only at the start and/or the end', () => {
  const it = { start: '2026-10-08T08:00:00Z', end: '2026-10-08T17:00:00Z', tripMode: 'both', chainStart: true, chainEnd: false };
  const st = agenda.stopsOf(it, 5);
  assert.deepEqual(st.map((s) => [s.role, new Date(s.arrive).toISOString().slice(11, 16), new Date(s.depart).toISOString().slice(11, 16), s.chain]),
    [['drop', '08:00', '08:05', true], ['pick', '17:00', '17:05', false]]);
  assert.deepEqual(agenda.stopsOf({ ...it, tripMode: 'pick' }).map((s) => s.role), ['pick']);
  assert.deepEqual(agenda.stopsOf({ ...it, tripMode: 'drop' }).map((s) => s.role), ['drop']);
  const stay = agenda.stopsOf({ ...it, tripMode: 'stay', chainEnd: true });
  assert.deepEqual(stay.map((s) => [s.role, s.chain]), [['stay', true]]);
  assert.equal(agenda.stopsOf({ ...it, allDay: true })[0].role, 'stay', 'all day: never drop off / pick up');
});

test('chainStops: drive on to the next appointment, home after the last; not into its own pick-up', () => {
  const T = (h) => Date.UTC(2026, 9, 8, h);
  const a = { title: 'A' }; const b = { title: 'B' }; const c = { title: 'C' }; const d = { title: 'D' };
  const stops = [
    { item: a, role: 'drop', arrive: T(8), depart: T(8) + 5 * M, chain: true },
    { item: b, role: 'stay', arrive: T(9), depart: T(10), chain: true },
    { item: c, role: 'stay', arrive: T(11), depart: T(12), chain: false },
    { item: a, role: 'pick', arrive: T(17), depart: T(17) + 5 * M, chain: true },
    { item: d, role: 'stay', arrive: T(17) + 30 * 60000 + 24 * H, depart: T(19) + 24 * H, chain: false },
  ];
  const routes = agenda.chainStops(stops, { maxGapH: 12 });
  assert.deepEqual(routes.map((r) => r.map((s) => s.item.title + ':' + s.role)), [['A:drop', 'B:stay', 'C:stay'], ['A:pick'], ['D:stay']], 'D is more than 12 h later: home first');
  // driving on after dropping off, but nothing in between before picking up: home in between
  const own = agenda.chainStops([stops[0], stops[3]]);
  assert.equal(own.length, 2);
});

test('legOf: same address none, the looked-up road distance, else estimated', () => {
  const st = (item) => ({ item });
  const A = { location: 'Oppas 1, Utrecht', lat: 52.09, lon: 5.12, distanceKm: 12, travelMin: 15 };
  const B = { location: 'Kapper 2, Zeist', lat: 52.09, lon: 5.23, distanceKm: 18, travelMin: 20 };
  assert.deepEqual(agenda.legOf(st(A), st({ ...A })), { km: 0, min: 0 });
  assert.deepEqual(agenda.legOf(st(A), st(B), { distance_km: 9.4, duration_min: 14 }), { km: 9.4, min: 14 });
  const crow = agenda.legOf(st(A), st(B));
  assert.ok(crow.approx && crow.km > 7 && crow.km < 12, `crow × 1.3: ${crow.km}`);
  assert.deepEqual(agenda.legOf(st({ ...A, lat: null }), st(B)), { km: 30, min: 35, approx: true }, 'no coordinates: via home');
  assert.equal(agenda.legOf(st({ location: 'x' }), st(B)), null);
});

test('routeNeed: legs + margin once; own values at least; full = full', () => {
  const kpk = 0.2;
  const A = { title: 'A', kwhPerKm: kpk, _stops: 1 };
  const B = { title: 'B', kwhPerKm: kpk, _stops: 1 };
  const r1 = [{ item: A }];
  assert.deepEqual(agenda.routeNeed(r1, [{ km: 12 }, { km: 12 }], { marginKm: 20 }), { kwh: 8.8, km: 44, approx: false }, 'the same as before: 2 × 12 + 20');
  const r2 = [{ item: A }, { item: B }];
  assert.equal(agenda.routeNeed(r2, [{ km: 12 }, { km: 9 }, { km: 18 }], { marginKm: 20 }).km, 59, '12 + 9 + 18 + 20 once');
  const own = { ...B, needExplicit: 'value', needKwh: 30 };
  assert.equal(agenda.routeNeed([{ item: A }, { item: own }], [{ km: 12 }, { km: 9 }, { km: 18 }], { marginKm: 20 }).kwh, 30, 'an own value is at least counted');
  assert.equal(agenda.routeNeed([{ item: { ...A, needExplicit: 'full', usableKwh: 23 } }, { item: B }], [{ km: 1 }, { km: 1 }, { km: 1 }]).kwh, 23);
  // drop off and pick up with an own value: half each drive
  assert.equal(agenda.routeNeed([{ item: { ...A, _stops: 2, needExplicit: 'value', needKwh: 10 } }], [{ km: 5 }, { km: 5 }]).kwh, 5);
  // a leg unknown: each appointment's own estimate
  assert.deepEqual(agenda.routeNeed([{ item: { ...A, needKwh: 4 } }, { item: { ...B, needKwh: 6 } }], [{ km: 12 }, null, { km: 18 }]), { kwh: 10, km: null, approx: true });
});

test('routeOf: leave home before the first stop, back after the last; a too short gap is tight', () => {
  const T = (h, m = 0) => Date.UTC(2026, 9, 8, h, m);
  const A = { kind: 'event', calendar_id: 1, uid: 'a', start: new Date(T(8)).toISOString(), title: 'Oppas', kwhPerKm: 0.2, _stops: 2 };
  const B = { kind: 'event', calendar_id: 1, uid: 'b', start: new Date(T(8, 20)).toISOString(), title: 'Kapper', kwhPerKm: 0.2, _stops: 1 };
  const route = [{ item: A, role: 'drop', arrive: T(8), depart: T(8, 5) }, { item: B, role: 'stay', arrive: T(8, 20), depart: T(9) }];
  const r = agenda.routeOf(route, [{ km: 12, min: 15 }, { km: 9, min: 25 }, { km: 18, min: 20 }], { marginKm: 20, readyMarginMin: 15 });
  assert.equal(r.leaveAt, new Date(T(7, 45)).toISOString());
  assert.equal(r.backAt, new Date(T(9, 20)).toISOString());
  assert.equal(r.readyAt, new Date(T(7, 30)).toISOString());
  assert.equal(r.title, 'Oppas → Kapper');
  assert.equal(r.km, 59);
  assert.equal(r.legs[1].tight, true, '25 min drive, 15 min between');
  assert.equal(r.id, 'event|1|a|' + A.start + '|drop');
});

// ---------------------------------------------------------------- with the database

const day = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) + 2 * 86400000;
const at = (h, m = 0, d = 0) => new Date(day + d * 86400000 + h * H + m * M).toISOString();
let calId;

before(async () => {
  await initTestDb();
  const settings = require('../src/wallboxSettings');
  await settings.set('site', { lat: 52.0, lon: 5.0 });
  await settings.set('agenda', { ...agenda.DEFAULTS, margin_km: 20, ready_margin_min: 15, dwell_min: 5 });
  calId = await db.insertReturningId('INSERT INTO calendars (name, url, color, enabled, created_at) VALUES (?, ?, ?, 1, ?)', ['Gezin', 'x', '#3366cc', new Date().toISOString()]);
  const ev = async (uid, start, end, title, location, extra = {}) => db.upsert('calendar_events', {
    calendar_id: calId, uid, start_at: start, end_at: end, all_day: 0, title, location, car_tag: 1, car_hint: null, trip_tag: null, ...extra,
  }, ['calendar_id', 'uid', 'start_at']);
  // a weekly drop off and pick up (from the calendar text), and two appointments in between
  await ev('hond@test', at(8), at(17), 'Hond #brengen #halen', 'Oppas 1, Utrecht', { trip_tag: 'both' });
  await ev('hond@test', at(8, 0, 7), at(17, 0, 7), 'Hond #brengen #halen', 'Oppas 1, Utrecht', { trip_tag: 'both' });
  await ev('kapper@test', at(9), at(9, 45), 'Kapper', 'Kapper 2, Zeist');
  await ev('overleg@test', at(11), at(12), 'Overleg', 'Kantoor 3, Amersfoort');
  const geo = async (addr, lat, lon, km, min) => db.upsert('geo_cache', { query: `${addr.toLowerCase()}|52.0000,5.0000`, lat, lon, distance_km: km, duration_min: min, error: null, fetched_at: new Date().toISOString() }, ['query']);
  await geo('Oppas 1, Utrecht', 52.09, 5.12, 12, 15);
  await geo('Kapper 2, Zeist', 52.09, 5.23, 18, 20);
  await geo('Kantoor 3, Amersfoort', 52.15, 5.38, 30, 30);
});
after(async () => { await db.close(); });

const range = () => [at(0, 0, -1), at(0, 0, 9)];

test('drop off and pick up from the calendar text: two drives, the car home in between', async () => {
  const items = await agenda.items(...range());
  const hond = items.find((i) => i.uid === 'hond@test' && i.start === at(8));
  assert.equal(hond.tripMode, 'both');
  assert.equal(hond.tripModeSource, 'tag');
  assert.equal(hond.needKwh, 17.6, '(4 × 12 km + 40 km margin) × 0.2');
  assert.deepEqual(hond.tours.map((t) => [t.role, t.leaveAt, t.backAt, t.kwh]), [
    ['drop', at(7, 45), at(8, 20), 8.8],
    ['pick', at(16, 45), at(17, 20), 8.8],
  ]);
  assert.deepEqual(hond.departures.map((d) => d.leaveAt), [at(7, 45), at(16, 45)], 'climate at departure: both drives');
  assert.equal(hond.nextAfterStart.title, 'Kapper', 'offered: drive on to the next appointment');
  const trips = await agenda.tours(at(0), at(23, 59));
  assert.deepEqual(trips.map((t) => t.title), ['Hond #brengen #halen', 'Kapper', 'Overleg', 'Hond #brengen #halen']);
});

test('driving on: home → Oppas → Kapper → Overleg → home as one route; the planner sees that drive', async () => {
  const day0 = at(8);
  await agenda.setOverride({ calendar_id: calId, uid: 'hond@test', start_at: day0, chain_start: '1' });
  await agenda.setOverride({ calendar_id: calId, uid: 'kapper@test', start_at: at(9), chain_end: '1' });
  const trips = await agenda.tours(at(0), at(23, 59));
  assert.equal(trips.length, 2, 'the route and picking up');
  const r = trips[0];
  assert.equal(r.title, 'Hond #brengen #halen → Kapper → Overleg');
  assert.deepEqual(r.stops.map((s) => s.role), ['drop', 'stay', 'stay']);
  assert.equal(r.leaveAt, at(7, 45));
  assert.equal(r.backAt, at(12, 30), 'back from Amersfoort: 12:00 + 30 min');
  assert.equal(r.legs.length, 4);
  assert.ok(r.legs[1].approx && r.legs[2].approx, 'between appointments: estimated until looked up');
  const km = 12 + r.legs[1].km + r.legs[2].km + 30 + 20;
  assert.equal(r.km, Math.round(km));
  assert.equal(r.kwh, Math.round(km * 0.2 * 10) / 10);
  // with the road distance looked up (cached), no estimate any more
  await db.upsert('geo_cache', { query: 'leg|52.0900,5.1200|52.0900,5.2300', lat: 52.09, lon: 5.23, distance_km: 9.5, duration_min: 14, error: null, fetched_at: new Date().toISOString() }, ['query']);
  const r2 = (await agenda.tours(at(0), at(23, 59)))[0];
  assert.deepEqual({ km: r2.legs[1].km, min: r2.legs[1].min }, { km: 9.5, min: 14 });
  // the planner's next drive: the whole route, with what it needs
  const next = await agenda.nextCarTrip(Date.parse(at(6)));
  assert.equal(next.title, r2.title);
  assert.equal(next.readyAt, Date.parse(at(7, 30)));
  assert.equal(next.needKwh, r2.kwh);
  assert.equal(next.item.uid, 'hond@test');
  // later that day: picking up is the next drive
  const later = await agenda.nextCarTrip(Date.parse(at(13)));
  assert.equal(later.tour.stops[0].role, 'pick');
  assert.equal(later.readyAt, Date.parse(at(16, 30)));
  // the series' other week isn't affected by this day's choice
  const other = (await agenda.items(...range())).find((i) => i.uid === 'hond@test' && i.start === at(8, 0, 7));
  assert.equal(other.chainStart, false);
});

test('a series: how you drive set for the whole series, a day can differ, the series again resets the days', async () => {
  const w1 = at(8);
  const w2 = at(8, 0, 7);
  const get = async () => (await agenda.items(...range())).filter((i) => i.uid === 'hond@test');
  await agenda.setOverride({ calendar_id: calId, uid: 'hond@test', start_at: w1, trip_mode: 'drop', scope: 'series' });
  let list = await get();
  assert.deepEqual(list.map((i) => [i.tripMode, i.tripModeSource]), [['drop', 'series'], ['drop', 'series']]);
  assert.equal(list[0].needKwh, 8.8, 'only dropping off: once there and back');
  await agenda.setOverride({ calendar_id: calId, uid: 'hond@test', start_at: w2, trip_mode: 'pick' });
  list = await get();
  assert.deepEqual(list.map((i) => [i.tripMode, i.tripModeSource]), [['drop', 'series'], ['pick', 'you']]);
  assert.equal(list[1].leaveAt, at(16, 45, 7), 'only picking up: leave before the end');
  // driving on for the whole series too
  await agenda.setOverride({ calendar_id: calId, uid: 'hond@test', start_at: w2, chain_start: '1', scope: 'series' });
  list = await get();
  assert.deepEqual(list.map((i) => [i.chainStart, i.chainSource]), [[true, 'series'], [true, 'series']], 'the day\'s own choice gave way');
  await agenda.setOverride({ calendar_id: calId, uid: 'hond@test', start_at: w1, trip_mode: 'stay', scope: 'series' });
  list = await get();
  assert.deepEqual(list.map((i) => i.tripMode), ['stay', 'stay'], 'the day\'s own mode gave way to the series');
  assert.equal(list[0].tours.length, 1);
  // back to the calendar text
  await agenda.setOverride({ calendar_id: calId, uid: 'hond@test', start_at: w1, trip_mode: '', chain_start: '', scope: 'series' });
  list = await get();
  assert.deepEqual(list.map((i) => [i.tripMode, i.tripModeSource, i.chainStart]), [['both', 'tag', false], ['both', 'tag', false]]);
});

test('sync: #brengen / #halen in the calendar text is stored, and marks the car as needed', async () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
    'BEGIN:VEVENT', 'UID:opvang@test', `DTSTART:${at(8, 30, 1).replace(/[-:]/g, '').replace('.000', '')}`, `DTEND:${at(17, 0, 1).replace(/[-:]/g, '').replace('.000', '')}`, 'SUMMARY:Opvang', 'DESCRIPTION:#brengen en halen', 'LOCATION:Oppas 1\\, Utrecht', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const cal = await db.prepare('SELECT * FROM calendars WHERE id = ?').get(calId);
  const r = await agenda.syncCalendar({ ...cal, kind: 'ics', url: require('../src/secretCrypto').encrypt('https://example.test/cal.ics') }, { fetchText: async () => ics });
  assert.equal(r.ok, true, r.message);
  const row = await db.prepare('SELECT car_tag, trip_tag FROM calendar_events WHERE uid = ?').get('opvang@test');
  assert.deepEqual({ ...row }, { car_tag: 1, trip_tag: 'both' });
});

test('a series moved for one week (Tuesday → Thursday): that week on Thursday only, its original day kept', () => {
  const ical = require('node-ical');
  const tz = 'BEGIN:VTIMEZONE\r\nTZID:Europe/Amsterdam\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700329T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE';
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', tz,
    'BEGIN:VEVENT', 'UID:hond-tue@test', 'DTSTART;TZID=Europe/Amsterdam:20261006T080000', 'DTEND;TZID=Europe/Amsterdam:20261006T170000', 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'SUMMARY:Hond #brengen #halen', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:hond-tue@test', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20261013T080000', 'DTSTART;TZID=Europe/Amsterdam:20261015T083000', 'DTEND;TZID=Europe/Amsterdam:20261015T173000', 'SUMMARY:Hond #brengen #halen', 'END:VEVENT',
    'END:VCALENDAR', ''].join('\r\n');
  const occ = agenda.expandEvents(ical.sync.parseICS(ics), Date.parse('2026-10-05T00:00:00Z'), Date.parse('2026-10-25T00:00:00Z'));
  assert.deepEqual(occ.map((o) => [o.start, o.recurrenceAt]), [
    ['2026-10-06T06:00:00.000Z', '2026-10-06T06:00:00.000Z'],
    ['2026-10-15T06:30:00.000Z', '2026-10-13T06:00:00.000Z'],
    ['2026-10-20T06:00:00.000Z', '2026-10-20T06:00:00.000Z'],
  ]);
});

test('moved to another day: the series\' choices count there, and a choice for that one day moves with it', async () => {
  const orig = at(8, 0, 3);
  await db.upsert('calendar_events', { calendar_id: calId, uid: 'sport@test', start_at: orig, end_at: at(9, 0, 3), all_day: 0, title: 'Sport', location: 'Oppas 1, Utrecht', car_tag: 1, car_hint: null, trip_tag: null, recurrence_at: orig }, ['calendar_id', 'uid', 'start_at']);
  await db.upsert('calendar_events', { calendar_id: calId, uid: 'sport@test', start_at: at(8, 0, 10), end_at: at(9, 0, 10), all_day: 0, title: 'Sport', location: 'Oppas 1, Utrecht', car_tag: 1, car_hint: null, trip_tag: null, recurrence_at: at(8, 0, 10) }, ['calendar_id', 'uid', 'start_at']);
  await agenda.setOverride({ calendar_id: calId, uid: 'sport@test', start_at: orig, trip_mode: 'drop', scope: 'series' });
  await agenda.setOverride({ calendar_id: calId, uid: 'sport@test', start_at: orig, own_value: '30 km' });
  // the calendar moves this one occurrence two days later (next sync)
  await db.prepare('UPDATE calendar_events SET start_at = ?, end_at = ? WHERE uid = ? AND start_at = ?').run(at(10, 0, 5), at(11, 0, 5), 'sport@test', orig);
  const moved = (await agenda.items(...range())).find((i) => i.uid === 'sport@test' && i.start === at(10, 0, 5));
  assert.ok(moved, 'on the new day');
  assert.equal(moved.movedFrom, orig);
  assert.equal(moved.recurring, true);
  assert.equal(moved.tripMode, 'drop', 'the series\' choice');
  assert.equal(moved.own, '30 km', 'the day\'s own value moved along');
  assert.equal(moved.occ, orig);
});

test('after the second appointment: back home via the first address (to pick up there)', async () => {
  const ev = async (uid, start, end, title, location, extra = {}) => db.upsert('calendar_events', {
    calendar_id: calId, uid, start_at: start, end_at: end, all_day: 0, title, location, car_tag: 1, car_hint: null, trip_tag: null, ...extra,
  }, ['calendar_id', 'uid', 'start_at']);
  await ev('school@test', at(8, 0, 2), at(15, 0, 2), 'School #brengen', 'Oppas 1, Utrecht', { trip_tag: 'drop' });
  await ev('kapper2@test', at(9, 0, 2), at(9, 30, 2), 'Kapper', 'Kapper 2, Zeist');
  let items = await agenda.items(at(0, 0, 2), at(23, 0, 2));
  let b = items.find((i) => i.uid === 'kapper2@test');
  assert.equal(b.viaAfterEnd, undefined, 'not driving on from the school yet: nothing to go back via');
  await agenda.setOverride({ calendar_id: calId, uid: 'school@test', start_at: at(8, 0, 2), chain_start: '1' });
  items = await agenda.items(at(0, 0, 2), at(23, 0, 2));
  b = items.find((i) => i.uid === 'kapper2@test');
  assert.equal(b.viaAfterEnd.title, 'School #brengen', 'offered: back via the school');
  await agenda.setOverride({ calendar_id: calId, uid: 'kapper2@test', start_at: at(9, 0, 2), chain_end: '2' });
  items = await agenda.items(at(0, 0, 2), at(23, 0, 2));
  const a = items.find((i) => i.uid === 'school@test');
  b = items.find((i) => i.uid === 'kapper2@test');
  assert.equal(b.chainEnd, 2);
  assert.equal(a.tours.length, 1, 'the same drive once, though it passes the school twice');
  const r = a.tours[0];
  assert.deepEqual(r.stops.map((s) => s.role), ['drop', 'stay', 'via']);
  assert.equal(r.legs.length, 4, 'home → school → hairdresser → school → home');
  assert.equal(r.legs[3].km, 12, 'from the school home');
  const back = Date.parse(at(9, 30, 2)) + r.legs[2].min * 60000 + 5 * 60000 + 15 * 60000;
  assert.equal(r.backAt, new Date(back).toISOString(), 'back after the stop at the school');
  assert.equal(agenda.cleanChain('2'), 2);
  assert.equal(agenda.cleanChain('1'), 1);
  assert.equal(agenda.cleanChain('0'), 0);
  assert.equal(agenda.cleanChain(''), null);
});
