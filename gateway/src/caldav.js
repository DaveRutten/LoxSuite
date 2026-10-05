// CalDAV client for the agenda: iCloud (caldav.icloud.com, with an app-specific password from
// appleid.apple.com), Nextcloud, Fastmail and other CalDAV servers. Only reads: finds the calendars
// of the account, and fetches the events of a time window as ICS, which the agenda then expands
// exactly like an ICS link. Redirects are followed by hand so the sign-in goes along (iCloud sends
// every account to its own pNN-caldav.icloud.com host, and fetch drops credentials across hosts).
const { XMLParser } = require('fast-xml-parser');

const ICLOUD = 'https://caldav.icloud.com/';
const TIMEOUT_MS = 20000;

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
// Pure: "Naam &amp; Naam" -> "Naam & Naam" (also double-escaped, as some servers send it).
function decodeEntities(text) {
  let s = String(text ?? '');
  for (let i = 0; i < 2 && /&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/i.test(s); i++) {
    s = s.replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, '&');
  }
  return s;
}
const arr = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

async function request(method, url, { username, password, depth = null, body = null, fetchFn = fetch } = {}) {
  let target = url;
  for (let hop = 0; hop < 5; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchFn(target, {
        method, redirect: 'manual', signal: ctrl.signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
          'Content-Type': 'application/xml; charset=utf-8', 'User-Agent': 'LoxSuite',
          ...(depth !== null ? { Depth: String(depth) } : {}),
        },
        body: body || undefined,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`No answer within ${TIMEOUT_MS / 1000} s.`);
      throw new Error(`Cannot reach ${new URL(target).host} (${err.cause?.code || err.message}).`);
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get ? res.headers.get('location') : null;
      if (!loc) throw new Error(`Redirect without an address (HTTP ${res.status}).`);
      target = new URL(loc, target).toString();
      continue;
    }
    const text = await res.text();
    if (res.status === 401) throw new Error('Sign-in refused — check the user name and the (app-specific) password.');
    if (res.status >= 400) throw new Error(`The CalDAV server answered HTTP ${res.status}.`);
    return { url: target, text };
  }
  throw new Error('Too many redirects.');
}

// Pure: multistatus XML -> [{ href, props }] with the props of the 200 propstat merged.
function parseMultistatus(xml) {
  const doc = parser.parse(String(xml || ''));
  const out = [];
  for (const r of arr(doc?.multistatus?.response)) {
    const props = {};
    for (const ps of arr(r.propstat)) {
      if (ps.status && !/ 200 /.test(` ${String(ps.status)} `)) continue;
      Object.assign(props, ps.prop || {});
    }
    out.push({ href: String(arr(r.href)[0] || ''), props });
  }
  return out;
}

const hrefOf = (v) => (v && typeof v === 'object' ? String(arr(v.href)[0] || '') : String(v || ''));
const textOf = (v) => (v && typeof v === 'object' ? String(v['#text'] ?? '') : String(v ?? ''));

const PROP_PRINCIPAL = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
const PROP_HOME = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>';
const PROP_CALS = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><a:calendar-color/></d:prop></d:propfind>';

// The calendars (with events) of an account. -> [{ url, name, color }]
async function discover({ server = ICLOUD, username, password, fetchFn } = {}) {
  if (!username || !password) throw new Error('User name and (app-specific) password are needed.');
  const base = /^https?:\/\//i.test(server || '') ? server : `https://${server}`;
  const opts = { username, password, fetchFn };
  let r = await request('PROPFIND', base, { ...opts, depth: 0, body: PROP_PRINCIPAL }).catch(async (err) => {
    if (/HTTP 404|HTTP 405/.test(err.message)) return request('PROPFIND', new URL('/.well-known/caldav', base).toString(), { ...opts, depth: 0, body: PROP_PRINCIPAL });
    throw err;
  });
  const principal = hrefOf(parseMultistatus(r.text)[0]?.props?.['current-user-principal']);
  if (!principal) throw new Error('The server did not say which account this is (no current-user-principal).');
  const pUrl = new URL(principal, r.url).toString();
  r = await request('PROPFIND', pUrl, { ...opts, depth: 0, body: PROP_HOME });
  const home = hrefOf(parseMultistatus(r.text)[0]?.props?.['calendar-home-set']);
  if (!home) throw new Error('The server did not give a calendar home (calendar-home-set).');
  const hUrl = new URL(home, r.url).toString();
  r = await request('PROPFIND', hUrl, { ...opts, depth: 1, body: PROP_CALS });
  return calendarsFrom(r.text, r.url);
}

// Pure: the home's listing -> calendars that hold events.
function calendarsFrom(xml, baseUrl) {
  const out = [];
  for (const { href, props } of parseMultistatus(xml)) {
    const rt = props.resourcetype;
    if (!rt || typeof rt !== 'object' || !('calendar' in rt)) continue;
    // only calendars with events (a server may list just VTODO for a reminders list)
    const comps = arr(props['supported-calendar-component-set']?.comp).map((c) => String(c?.['@_name'] || '').toUpperCase()).filter(Boolean);
    if (comps.length && !comps.includes('VEVENT')) continue;
    const cc = props['calendar-color'];
    const color = String(cc && typeof cc === 'object' ? cc['#text'] ?? '' : cc || '').slice(0, 7);
    const text = (v) => (v && typeof v === 'object' ? String(v['#text'] ?? '') : String(v ?? ''));
    out.push({ url: new URL(href, baseUrl).toString(), name: decodeEntities(text(props.displayname)) || decodeURIComponent(href.split('/').filter(Boolean).pop() || '') || 'Calendar', color: /^#[0-9a-f]{6}$/i.test(color) ? color : null });
  }
  return out;
}

const icalTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// The events in [fromMs, toMs) as one ICS text (recurring events come as their series, which the
// agenda expands itself).
async function fetchRange({ url, username, password, fromMs, toMs, fetchFn } = {}) {
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${icalTime(fromMs)}" end="${icalTime(toMs)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const r = await request('REPORT', url, { username, password, depth: 1, body, fetchFn });
  return joinIcs(parseMultistatus(r.text).map((x) => textOf(x.props['calendar-data'])).filter(Boolean));
}

// Pure: several VCALENDAR texts -> one (the components of each, time zones once).
function joinIcs(list) {
  const parts = [];
  const tz = new Map();
  for (const t of list) {
    const inner = String(t).replace(/\r\n/g, '\n').replace(/^[\s\S]*?BEGIN:VCALENDAR\n/, '').replace(/END:VCALENDAR[\s\S]*$/, '');
    for (const m of inner.matchAll(/BEGIN:VTIMEZONE\n[\s\S]*?END:VTIMEZONE\n/g)) {
      const id = (/TZID:([^\n]+)/.exec(m[0]) || [])[1] || m[0];
      if (!tz.has(id)) tz.set(id, m[0]);
    }
    for (const m of inner.matchAll(/BEGIN:VEVENT\n[\s\S]*?END:VEVENT\n/g)) parts.push(m[0]);
  }
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//LoxSuite//CalDAV//EN\n${[...tz.values()].join('')}${parts.join('')}END:VCALENDAR\n`;
}

module.exports = { decodeEntities, ICLOUD, discover, fetchRange, parseMultistatus, calendarsFrom, joinIcs, icalTime, request };
