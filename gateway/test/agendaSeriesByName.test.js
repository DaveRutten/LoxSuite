// A series is linked by name (v0.51): two weekly series, "Oppas Lisa" on Monday and "Opvang bij
// opa & oma" on Tuesday; one week they are swapped by renaming the two appointments — the calendar
// keeps each series' ID on its weekday. What was chosen for "opa & oma" must go along to Monday that
// week, and Tuesday (now "Lisa") must not get it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb, db } = require('./helpers/testDb');
const agenda = require('../src/agenda');

const H = 3600000;
const monday = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); return d.getTime(); })();
const at = (d, h = 7) => new Date(monday + d * 86400000 + h * H).toISOString();
const range = () => [at(-1, 0), at(17, 0)];
let calId;
let cal2;

// rec: an occurrence of a calendar series (RRULE), else a single appointment
const ev = (cal, uid, d, title, location, rec = true) => db.upsert('calendar_events', {
  calendar_id: cal, uid, start_at: at(d), end_at: at(d, 17), all_day: 0, title, location, car_tag: 0, car_hint: null, trip_tag: null, recurrence_at: rec ? at(d) : null,
}, ['calendar_id', 'uid', 'start_at']);

async function weeks(cal) {
  // normal, swapped (renamed), normal
  await ev(cal, 'lisa@t', 0, 'Oppas Lisa', 'Thuis');
  await ev(cal, 'lisa@t', 7, 'Opvang bij opa en oma', 'Thuis');
  await ev(cal, 'lisa@t', 14, 'Oppas Lisa', 'Thuis');
  await ev(cal, 'opa@t', 1, 'Opvang bij opa & oma', 'Dorp 1, Zeist');
  await ev(cal, 'opa@t', 8, 'Oppas Lisa', 'Kerkplein 3, Zeist');
  await ev(cal, 'opa@t', 15, 'Opvang bij opa & oma', 'Dorp 1, Zeist');
}

before(async () => {
  await initTestDb();
  const settings = require('../src/wallboxSettings');
  await settings.set('site', { lat: 52.0, lon: 5.0 });
  await settings.set('agenda', { ...agenda.DEFAULTS, geo: false });
  calId = await db.insertReturningId('INSERT INTO calendars (name, url, color, enabled, created_at) VALUES (?, ?, ?, 1, ?)', ['Gezin', 'x', '#3366cc', new Date().toISOString()]);
  cal2 = await db.insertReturningId('INSERT INTO calendars (name, url, color, enabled, created_at) VALUES (?, ?, ?, 1, ?)', ['Oud', 'y', '#cc6633', new Date().toISOString()]);
  await weeks(calId);
  await weeks(cal2);
});

after(async () => { await db.close(); });

const find = (list, cal, uid, d) => list.find((i) => i.calendar_id === cal && i.uid === uid && i.start === at(d));

test('seriesName: one name for small differences in writing', () => {
  assert.equal(agenda.seriesName('Opvang bij opa & oma'), agenda.seriesName('🚗 Opvang bij opa en oma'));
  assert.equal(agenda.seriesName('Opvang #brengen #halen'), 'opvang');
  assert.equal(agenda.seriesName('Tom and Jerry'), agenda.seriesName('Tom + Jerry'));
  assert.notEqual(agenda.seriesName('Oppas Lisa'), agenda.seriesName('Opvang bij opa & oma'));
  assert.equal(agenda.seriesName('🚗'), '');
});

test('swapped by renaming: the choices follow the name, not the calendar ID of the weekday', async () => {
  await agenda.setOverride({ calendar_id: calId, uid: 'opa@t', start_at: at(1), needs_car: '1', trip_mode: 'both', scope: 'series' });
  const list = await agenda.items(...range());
  for (const d of [1, 15]) {
    const t = find(list, calId, 'opa@t', d);
    assert.deepEqual([t.needsCar, t.tripMode, t.carSource, t.tripModeSource, t.recurring], [true, 'both', 'series', 'series', true], `Tuesday ${d}`);
  }
  const mon = find(list, calId, 'lisa@t', 7);
  assert.equal(mon.needsCar, true, 'Monday in the swapped week is "opa en oma": the car');
  assert.equal(mon.tripMode, 'both');
  assert.equal(mon.linkedSeries, 'Opvang bij opa & oma');
  const tue = find(list, calId, 'opa@t', 8);
  assert.equal(tue.needsCar, false, 'Tuesday in the swapped week is "Lisa": not the choices of opa & oma');
  assert.equal(tue.tripMode, 'stay');
  assert.equal(tue.linkedSeries, 'Oppas Lisa');
  assert.equal(find(list, calId, 'lisa@t', 0).needsCar, false, 'a normal Monday stays as it was');
  assert.equal(mon.seriesTitle, 'Opvang bij opa & oma', 'the title most of them have');
});

test('choices made earlier per calendar ID follow the name too', async () => {
  await db.upsert('event_overrides', { calendar_id: cal2, uid: 'opa@t', start_at: '*', needs_car: 1, trip_mode: 'drop', chain_start: null, chain_end: null }, ['calendar_id', 'uid', 'start_at']);
  const list = await agenda.items(...range());
  assert.equal(find(list, cal2, 'lisa@t', 7).tripMode, 'drop');
  assert.equal(find(list, cal2, 'opa@t', 8).needsCar, false);
  assert.equal(find(list, cal2, 'opa@t', 1).tripMode, 'drop');
  // set again for the series (from the swapped Monday): stored by name, the old row gives way
  await agenda.setOverride({ calendar_id: cal2, uid: 'lisa@t', start_at: at(7), trip_mode: 'pick', scope: 'series' });
  const old = await db.prepare("SELECT trip_mode, needs_car FROM event_overrides WHERE calendar_id = ? AND uid = 'opa@t' AND start_at = '*'").get(cal2);
  assert.deepEqual({ ...old }, { trip_mode: null, needs_car: 1 }, 'only what was set again gives way');
  const after = await agenda.items(...range());
  assert.deepEqual([1, 15].map((d) => find(after, cal2, 'opa@t', d).tripMode), ['pick', 'pick']);
  assert.equal(find(after, cal2, 'lisa@t', 7).tripMode, 'pick');
  assert.equal(find(after, cal2, 'lisa@t', 0).needsCar, false, 'the Lisa series is untouched');
});

test('one day: "default" for that day wins over the series, "as the series" follows it again', async () => {
  await agenda.setOverride({ calendar_id: calId, uid: 'opa@t', start_at: at(15), trip_mode: 'auto' });
  let list = await agenda.items(...range());
  assert.equal(find(list, calId, 'opa@t', 15).tripMode, 'stay');
  assert.equal(find(list, calId, 'opa@t', 15).day.trip_mode, 'auto');
  assert.equal(find(list, calId, 'opa@t', 1).tripMode, 'both', 'the rest of the series keeps its choice');
  await agenda.setOverride({ calendar_id: calId, uid: 'opa@t', start_at: at(15), trip_mode: '' });
  list = await agenda.items(...range());
  assert.equal(find(list, calId, 'opa@t', 15).tripMode, 'both');
  // 'auto' for the whole series = nothing chosen
  await agenda.setOverride({ calendar_id: calId, uid: 'opa@t', start_at: at(1), trip_mode: 'auto', scope: 'series' });
  list = await agenda.items(...range());
  assert.equal(find(list, calId, 'opa@t', 1).tripMode, 'stay');
  assert.equal(find(list, calId, 'opa@t', 1).series.trip_mode, null);
  await agenda.setOverride({ calendar_id: calId, uid: 'opa@t', start_at: at(1), trip_mode: 'both', scope: 'series' });
});

test('a choice for the whole series replaces the day choices of every appointment with that name', async () => {
  await agenda.setOverride({ calendar_id: calId, uid: 'lisa@t', start_at: at(7), needs_car: '0' });
  await agenda.setOverride({ calendar_id: calId, uid: 'opa@t', start_at: at(8), needs_car: '1' });
  let list = await agenda.items(...range());
  assert.equal(find(list, calId, 'lisa@t', 7).needsCar, false, 'a day choice wins over the series');
  await agenda.setOverride({ calendar_id: calId, uid: 'opa@t', start_at: at(1), needs_car: '1', scope: 'series' });
  list = await agenda.items(...range());
  assert.equal(find(list, calId, 'lisa@t', 7).needsCar, true, 'gone: same name');
  assert.equal(find(list, calId, 'opa@t', 8).needsCar, true, 'kept: that day is "Lisa"');
});

test('separate appointments with the same name are a series too', async () => {
  await ev(calId, 'zw1@t', 2, 'Zwemles', 'Bad 1, Zeist', false);
  await ev(calId, 'zw2@t', 9, 'Zwemles ', 'Bad 1, Zeist', false);
  let list = await agenda.items(...range());
  assert.equal(find(list, calId, 'zw1@t', 2).recurring, true);
  await agenda.setOverride({ calendar_id: calId, uid: 'zw1@t', start_at: at(2), needs_car: '1', trip_mode: 'drop', scope: 'series' });
  list = await agenda.items(...range());
  const z2 = find(list, calId, 'zw2@t', 9);
  assert.deepEqual([z2.needsCar, z2.tripMode, z2.carSource], [true, 'drop', 'series']);
  // a name used once is not a series
  await ev(calId, 'tandarts@t', 3, 'Tandarts', 'Plein 2', false);
  list = await agenda.items(...range());
  assert.equal(find(list, calId, 'tandarts@t', 3).recurring, false);
});
