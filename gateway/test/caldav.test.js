const test = require('node:test');
const assert = require('node:assert/strict');
const cd = require('../src/caldav');

const ms = (body) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">${body}</d:multistatus>`;
const resp = (href, prop) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

test('calendarsFrom keeps event calendars, skips reminder lists and the home itself', () => {
  const xml = ms(
    resp('/123/calendars/', '<d:resourcetype><d:collection/></d:resourcetype>') +
    resp('/123/calendars/home/', '<d:displayname>Thuis</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set><a:calendar-color symbolic-color="red">#FF2968FF</a:calendar-color>') +
    resp('/123/calendars/tasks/', '<d:displayname>Herinneringen</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>'));
  assert.deepEqual(cd.calendarsFrom(xml, 'https://p52-caldav.icloud.com/123/calendars/'), [{ url: 'https://p52-caldav.icloud.com/123/calendars/home/', name: 'Thuis', color: '#FF2968' }]);
});

test('joinIcs merges events and time zones into one calendar', () => {
  const a = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Amsterdam\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:A\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const b = a.replace('UID:1', 'UID:2').replace('SUMMARY:A', 'SUMMARY:B');
  const out = cd.joinIcs([a, b]);
  assert.equal((out.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.equal((out.match(/BEGIN:VTIMEZONE/g) || []).length, 1);
  assert.match(out, /^BEGIN:VCALENDAR\n[\s\S]*END:VCALENDAR\n$/);
  assert.equal(cd.icalTime(Date.parse('2026-10-05T07:30:00Z')), '20261005T073000Z');
});

test('discover follows iCloud to the account host with the sign-in, then lists calendars', async () => {
  const seen = [];
  const reply = (status, text, loc) => ({ status, headers: { get: (n) => (n.toLowerCase() === 'location' ? loc || null : null) }, text: async () => text });
  const fetchFn = async (url, opts) => {
    seen.push({ url, auth: opts.headers.Authorization, method: opts.method, depth: opts.headers.Depth });
    if (url === 'https://caldav.icloud.com/') return reply(301, '', 'https://p52-caldav.icloud.com/');
    if (url === 'https://p52-caldav.icloud.com/' && /current-user-principal/.test(opts.body)) return reply(207, ms(resp('/', '<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>')));
    if (url === 'https://p52-caldav.icloud.com/123/principal/') return reply(207, ms(resp('/123/principal/', '<cal:calendar-home-set><d:href>https://p52-caldav.icloud.com:443/123/calendars/</d:href></cal:calendar-home-set>')));
    if (url.startsWith('https://p52-caldav.icloud.com') && /calendars\/$/.test(url)) return reply(207, ms(resp('/123/calendars/work/', '<d:displayname>Werk</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>')));
    return reply(404, '');
  };
  const cals = await cd.discover({ username: 'me@icloud.com', password: 'abcd-efgh-ijkl-mnop', fetchFn });
  assert.equal(cals.length, 1);
  assert.equal(cals[0].name, 'Werk');
  assert.ok(seen.every((r) => r.auth === `Basic ${Buffer.from('me@icloud.com:abcd-efgh-ijkl-mnop').toString('base64')}`), 'sign-in sent on every hop');
  assert.equal(seen[seen.length - 1].depth, '1');
});

test('a refused sign-in gives a clear message', async () => {
  const fetchFn = async () => ({ status: 401, headers: { get: () => null }, text: async () => '' });
  await assert.rejects(cd.discover({ username: 'x', password: 'y', fetchFn }), /Sign-in refused/);
});

test('fetchRange asks for the window and returns one ICS text', async () => {
  let body = '';
  const fetchFn = async (url, opts) => { body = opts.body; return { status: 207, headers: { get: () => null }, text: async () => ms(resp('/c/1.ics', '<cal:calendar-data>BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:9\nSUMMARY:🚗 Utrecht\nDTSTART:20261006T070000Z\nDTEND:20261006T080000Z\nEND:VEVENT\nEND:VCALENDAR\n</cal:calendar-data>')) }; };
  const text = await cd.fetchRange({ url: 'https://x/c/', username: 'u', password: 'p', fromMs: Date.parse('2026-10-01T00:00:00Z'), toMs: Date.parse('2026-11-01T00:00:00Z'), fetchFn });
  assert.match(body, /time-range start="20261001T000000Z" end="20261101T000000Z"/);
  const ical = require('node-ical');
  const ev = Object.values(ical.sync.parseICS(text)).find((x) => x.type === 'VEVENT');
  assert.equal(ev.summary, '🚗 Utrecht');
});
