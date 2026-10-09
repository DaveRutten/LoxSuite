// Adding an appointment in LoxSuite (v0.55): into a calendar over CalDAV (iCloud, Nextcloud, … —
// written there, so it is on your phone too) or LoxSuite's own; an ICS link can only be read. One
// added in LoxSuite can be removed again (from the CalDAV calendar too).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initTestDb, db } = require('./helpers/testDb');
const agenda = require('../src/agenda');
const caldav = require('../src/caldav');

const day = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime() + 3 * 86400000; })();
const at = (h) => new Date(day + h * 3600000).toISOString();
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
let davId;
let icsId;

// a CalDAV server that remembers what it is sent
function fakeDav({ status = 201 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body });
    return { status, headers: { get: () => null }, text: async () => '' };
  };
  return { fn, calls };
}

before(async () => {
  await initTestDb();
  const settings = require('../src/wallboxSettings');
  await settings.set('site', { lat: 52.0, lon: 5.0 });
  await settings.set('agenda', { ...agenda.DEFAULTS, geo: false });
  davId = await agenda.addCalendar({ kind: 'caldav', name: 'Thuis', url: 'https://p01-caldav.icloud.com/1234/calendars/home/', username: 'iemand@example.com', password: 'abcd-efgh-ijkl-mnop' });
  icsId = await agenda.addCalendar({ name: 'Werk', url: 'https://calendar.example.com/werk.ics' });
});

after(async () => { await db.close(); });

test('cleanNewEvent: a name, a time (an end before the start is the next day), or a whole day', () => {
  assert.deepEqual(agenda.cleanNewEvent({ title: '  Tandarts ', start: '2026-10-12T08:00:00Z', end: '2026-10-12T09:00:00Z', location: ' Kerkstraat 1 ' }),
    { title: 'Tandarts', location: 'Kerkstraat 1', allDay: false, start: '2026-10-12T08:00:00.000Z', end: '2026-10-12T09:00:00.000Z' });
  assert.equal(agenda.cleanNewEvent({ title: 'Nachtdienst', start: '2026-10-12T20:00:00Z', end: '2026-10-12T04:00:00Z' }).end, '2026-10-13T04:00:00.000Z');
  assert.equal(agenda.cleanNewEvent({ title: 'Kort', start: '2026-10-12T20:00:00Z' }).end, '2026-10-12T21:00:00.000Z', 'no end: an hour');
  assert.deepEqual(agenda.cleanNewEvent({ title: 'Vakantie', all_day: '1', date: '2026-10-12', end_date: '2026-10-14' }),
    { title: 'Vakantie', location: null, allDay: true, start: '2026-10-12T00:00:00.000Z', end: '2026-10-15T00:00:00.000Z' });
  assert.equal(agenda.cleanNewEvent({ title: 'Dag', all_day: true, date: '2026-10-12' }).end, '2026-10-13T00:00:00.000Z');
  assert.throws(() => agenda.cleanNewEvent({ title: ' ', start: '2026-10-12T08:00:00Z' }), /name/);
  assert.throws(() => agenda.cleanNewEvent({ title: 'x', start: 'morgen' }), /date and time/);
  assert.throws(() => agenda.cleanNewEvent({ title: 'x', all_day: 1, date: '2026-10-01', end_date: '2026-12-01' }), /month/);
});

test('eventIcs: a VEVENT any calendar app reads — escaped, folded at 75 octets, UTC or whole days', () => {
  const ics = agenda.eventIcs({ uid: 'u1@loxsuite', title: `Tandarts, controle; ${'é'.repeat(60)}`, location: 'Kerkstraat 1, Bergen (L)', start: '2026-10-12T08:00:00.000Z', end: '2026-10-12T09:00:00.000Z', nowMs: Date.UTC(2026, 9, 9, 8) });
  assert.match(ics, /\r\nDTSTART:20261012T080000Z\r\nDTEND:20261012T090000Z\r\n/);
  assert.match(ics, /\r\nSUMMARY:Tandarts\\, controle\\; /);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `${Buffer.byteLength(line)}: ${line}`);
  const ev = Object.values(require('node-ical').sync.parseICS(ics)).find((x) => x.type === 'VEVENT');
  assert.equal(ev.summary, `Tandarts, controle; ${'é'.repeat(60)}`);
  assert.equal(ev.location, 'Kerkstraat 1, Bergen (L)');
  assert.equal(ev.start.toISOString(), '2026-10-12T08:00:00.000Z');
  const allDay = agenda.eventIcs({ uid: 'u2', title: 'Vakantie', start: '2026-10-12T00:00:00.000Z', end: '2026-10-15T00:00:00.000Z', allDay: true });
  assert.match(allDay, /DTSTART;VALUE=DATE:20261012\r\nDTEND;VALUE=DATE:20261015\r\n/);
  assert.equal(agenda.icsText('a\\b\nc'), 'a\\\\b\\nc');
});

test('into a CalDAV calendar: written there (never over another), shown at once with the car choices', async () => {
  const dav = fakeDav();
  const r = await agenda.addEvent({ calendar_id: String(davId), title: 'Tandarts', location: 'Kerkstraat 1, Bergen (L)', start: at(8), end: at(9), needs_car: '1', trip_mode: 'drop' }, { fetchFn: dav.fn, nowMs: day });
  assert.equal(r.kind, 'caldav');
  assert.match(r.uid, /^[0-9a-f-]{36}@loxsuite$/);
  assert.equal(dav.calls.length, 1);
  const put = dav.calls[0];
  assert.equal(put.method, 'PUT');
  assert.equal(put.url, `https://p01-caldav.icloud.com/1234/calendars/home/${encodeURIComponent(r.uid)}.ics`);
  assert.equal(put.headers['If-None-Match'], '*');
  assert.match(put.headers['Content-Type'], /^text\/calendar/);
  assert.equal(put.headers.Authorization, `Basic ${Buffer.from('iemand@example.com:abcd-efgh-ijkl-mnop').toString('base64')}`);
  assert.match(put.body, new RegExp(`UID:${r.uid}\r\n`));
  assert.match(put.body, /SUMMARY:Tandarts\r\n/);
  const it = (await agenda.items(at(0), at(24))).find((i) => i.uid === r.uid);
  assert.deepEqual([it.title, it.location, it.needsCar, it.tripMode, it.calendar], ['Tandarts', 'Kerkstraat 1, Bergen (L)', true, 'drop', 'Thuis']);
});

test('the CalDAV server refuses: an error, nothing stored', async () => {
  const dav = fakeDav({ status: 403 });
  await assert.rejects(agenda.addEvent({ calendar_id: davId, title: 'Gedeeld', start: at(10), end: at(11) }, { fetchFn: dav.fn }), /read-only/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE title = 'Gedeeld'").get()).n, 0);
});

test('an ICS link can only be read; LoxSuite\'s own calendar is made when first used', async () => {
  await assert.rejects(agenda.addEvent({ calendar_id: icsId, title: 'x', start: at(10) }), /ICS link/);
  const a = await agenda.addEvent({ calendar_id: 'local', title: 'Vakantie', all_day: 1, date: ymd(day), end_date: ymd(day + 86400000), needs_car: '0' });
  const b = await agenda.addEvent({ calendar_id: 'local', title: 'Garage', start: at(14), end: at(15) });
  assert.equal(a.kind, 'local');
  assert.equal(a.calendar_id, b.calendar_id, 'one LoxSuite calendar');
  const cals = await agenda.listCalendars();
  const own = cals.find((c) => c.id === a.calendar_id);
  assert.deepEqual([own.name, own.kind, own.writable, own.urlHost], ['LoxSuite', 'local', true, '']);
  assert.equal(cals.find((c) => c.id === icsId).writable, false);
  const list = await agenda.items(at(0), at(48));
  const v = list.find((i) => i.uid === a.uid);
  assert.deepEqual([v.allDay, v.start, v.end, v.needsCar], [true, `${ymd(day)}T00:00:00.000Z`, `${ymd(day + 2 * 86400000)}T00:00:00.000Z`, false]);
  // syncing LoxSuite's own calendar fetches nothing and keeps them
  const r = await agenda.syncCalendar(await db.prepare('SELECT * FROM calendars WHERE id = ?').get(a.calendar_id), { fetchText: async () => { throw new Error('no fetch'); } });
  assert.deepEqual(r, { ok: true, events: 2 });
});

test('removing: only one added in LoxSuite, from the CalDAV calendar too (already gone is fine)', async () => {
  const dav = fakeDav();
  const r = await agenda.addEvent({ calendar_id: davId, title: 'Kapper', start: at(16), end: at(17), needs_car: '1' }, { fetchFn: dav.fn });
  const gone = fakeDav({ status: 404 });
  await agenda.removeEvent({ calendar_id: davId, uid: r.uid }, { fetchFn: gone.fn });
  assert.equal(gone.calls[0].method, 'DELETE');
  assert.equal(gone.calls[0].url, caldav.eventUrl('https://p01-caldav.icloud.com/1234/calendars/home/', r.uid));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE uid = ?').get(r.uid)).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM event_overrides WHERE uid = ?').get(r.uid)).n, 0);
  await db.upsert('calendar_events', { calendar_id: davId, uid: 'iphone-123', start_at: at(18), end_at: at(19), all_day: 0, title: 'Van de telefoon', location: null, car_tag: 0, car_hint: null, trip_tag: null, recurrence_at: null }, ['calendar_id', 'uid', 'start_at']);
  await assert.rejects(agenda.removeEvent({ calendar_id: davId, uid: 'iphone-123' }), /added in LoxSuite/);
});

test('eventUrl: <collection>/<uid>.ics, also without a trailing slash', () => {
  assert.equal(caldav.eventUrl('https://dav.example.com/cal/home', 'a b@loxsuite'), 'https://dav.example.com/cal/home/a%20b%40loxsuite.ics');
  assert.equal(caldav.eventUrl('https://dav.example.com/cal/home/', 'x'), 'https://dav.example.com/cal/home/x.ics');
});
