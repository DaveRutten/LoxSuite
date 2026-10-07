// Agenda (Wallbox > Agenda): ICS calendars (Nextcloud, Google, Outlook, iCloud — any "secret
// address" / subscription URL), plus trips planned in LoxSuite itself. An appointment needs the
// car when its title (or description) holds a car marker — 🚗 or #auto by default — or when you
// switch "Car needed" on for it in LoxSuite (that choice is stored in LoxSuite only; the calendar
// itself is never changed). For such appointments with an address, LoxSuite looks up the driving
// distance from home (OpenStreetMap: Nominatim + OSRM; only the addresses of car appointments are
// sent, results are cached), adds the margin (default 20 km), and turns it into kWh with the
// car's consumption. The planner then makes sure the car is ready before you have to leave.
//
// How you drive: by default the car stays there (there at the start, back at the end). An
// appointment can also be "drop off and pick up" (there and back at the start, and again at the end —
// the car is home in between), only drop off or only pick up: in the calendar text (#brengen, #halen,
// both) or chosen in LoxSuite, per day or for the whole series. And after a stop you can drive on to
// the next appointment with the car instead of going home: the stops then form one route
// (home → 1 → 2 → 3 → home), with the real distances between them.
const db = require('./db');
const settings = require('./wallboxSettings');
const { encrypt, decrypt } = require('./secretCrypto');

const DEFAULTS = {
  tags: ['🚗', '🚙', '🚘', '#auto', '#car'],
  margin_km: 20,
  geo: true,
  ready_margin_min: 15,
  default_kwh_per_km: 0.2,
  sync_minutes: 15,
  window_days_back: 35,
  window_days_ahead: 120,
  // Climate at departure (Škoda cars): 'off', 'log' (only write down what would be sent) or 'on'.
  climate_mode: 'log',
  climate_lead_min: 20,
  climate_on_battery: true,
  // drop off / pick up: minutes at the address
  dwell_min: 5,
  // driving on to the next appointment: only when it starts within this many hours
  chain_max_gap_h: 12,
};

const TRIP_MODES = ['stay', 'both', 'drop', 'pick'];

// ------------------------------------------------------------------ pure helpers

function hasCarTag(text, tags = DEFAULTS.tags) {
  const t = String(text || '').toLowerCase();
  return tags.some((tag) => tag && t.includes(String(tag).toLowerCase()));
}

// "🚗 120 km", "#auto 30 kWh", "🚗 vol" / "full" -> { km } | { kwh } | { full: true } | null
function parseCarHint(text) {
  const t = String(text || '');
  let m = /(\d+(?:[.,]\d+)?)\s*kwh\b/i.exec(t);
  if (m) return { kwh: Number(m[1].replace(',', '.')) };
  m = /(\d+(?:[.,]\d+)?)\s*km\b/i.exec(t);
  if (m) return { km: Number(m[1].replace(',', '.')) };
  if (/\b(vol|full|volladen)\b/i.test(t)) return { full: true };
  return null;
}

// How to drive to an appointment, from its calendar text: "#brengen" / "#drop" = only drop off at the
// start, "#halen" / "#ophalen" / "#pickup" = only pick up at the end, both (or "#brengenhalen",
// "#brengen en halen", "#brengen/halen") = drop off and pick up. Null = not said (the car stays there).
function parseTripTag(text) {
  const t = String(text || '').toLowerCase();
  const both = /#(?:weg)?breng(?:en)?[\s/&+-]*(?:en\s+)?#?(?:op)?halen(?![a-z])|#dropoff[\s/&+-]*#?pick-?up(?![a-z])|#drop[\s/&+-]*#?pick-?up(?![a-z])/.test(t);
  const drop = /#(?:weg)?breng(?:en)?(?![a-z])|#drop(?:off|-off)?(?![a-z])/.test(t);
  const pick = /#(?:op)?halen(?![a-z])|#pick-?up(?![a-z])/.test(t);
  if (both || (drop && pick)) return 'both';
  return drop ? 'drop' : pick ? 'pick' : null;
}

// Own value typed in LoxSuite: "150 km", "30 kWh", "vol"/"full".
function parseOwnValue(text) { return parseCarHint(text); }

// kWh needed for a car appointment. distanceKm = one way; hint/own value win over the distance.
// rounds = how often you drive there and back (2 for drop off and pick up; the margin each time).
function tripNeedKwh({ hint, own, distanceKm, marginKm = 20, kwhPerKm = 0.2, usableKwh = null, rounds = 1 }) {
  const v = own || hint;
  if (v?.full) return usableKwh ? { kwh: usableKwh, basis: 'full' } : { kwh: null, basis: 'full' };
  if (v?.kwh) return { kwh: v.kwh, basis: `${v.kwh} kWh given` };
  const n = rounds === 2 ? 2 : 1;
  const km = v?.km ? v.km : (distanceKm ? n * (2 * distanceKm + marginKm) : null);
  if (!km) return { kwh: null, basis: 'unknown distance' };
  const kwh = Math.round(km * kwhPerKm * 10) / 10;
  const one = `2 × ${Math.round(distanceKm)} km + ${marginKm} km margin`;
  const basis = v?.km ? `${v.km} km given` : n === 2 ? `2 × (${one})` : one;
  return { kwh, km: Math.round(km), basis };
}

function icsUrl(url) {
  return String(url || '').trim().replace(/^webcals?:\/\//i, 'https://');
}

// node-ical calendar data -> occurrences [{uid, start, end, allDay, title, location, description}]
// within [fromMs, toMs): recurrences expanded, EXDATEs skipped, modified occurrences applied.
function expandEvents(data, fromMs, toMs) {
  const out = [];
  const dayKey = (d) => d.toISOString().slice(0, 10);
  const asAllDay = (d) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); // node-ical builds dates in the process zone
  for (const e of Object.values(data || {})) {
    if (!e || e.type !== 'VEVENT' || !e.start) continue;
    const allDay = e.datetype === 'date' || e.start.dateOnly === true;
    const durMs = e.end ? e.end - e.start : (allDay ? 86400000 : 3600000);
    const push = (start, ev = e) => {
      const s = allDay ? asAllDay(start) : start;
      const end = ev.end && ev !== e ? (allDay ? asAllDay(ev.end) : ev.end) : new Date(s.getTime() + durMs);
      if (end.getTime() <= fromMs || s.getTime() >= toMs) return;
      out.push({
        uid: String(e.uid || ''), start: s.toISOString(), end: end.toISOString(), allDay,
        title: require('./caldav').decodeEntities(ev.summary?.val ?? ev.summary ?? ''), location: require('./caldav').decodeEntities(ev.location?.val ?? ev.location ?? ''),
        description: String(ev.description?.val ?? ev.description ?? '').slice(0, 2000),
      });
    };
    if (e.rrule) {
      const ex = new Set(Object.keys(e.exdate || {}).map((k) => k.slice(0, 10)));
      const occ = e.rrule.between(new Date(fromMs - durMs), new Date(toMs), true);
      for (const o of occ) {
        const k = dayKey(o);
        if (ex.has(k)) continue;
        const rec = e.recurrences && (e.recurrences[k] || e.recurrences[o.toISOString()]);
        if (rec) { if (rec.status !== 'CANCELLED') push(rec.start || o, rec); continue; }
        push(o);
      }
    } else if (e.status !== 'CANCELLED') {
      push(e.start);
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

// ------------------------------------------------------------------ config & calendars

async function getConfig() { return settings.get('agenda', DEFAULTS); }

async function listCalendars() {
  const rows = await db.prepare('SELECT * FROM calendars ORDER BY name').all();
  const { decodeEntities } = require('./caldav');
  return rows.map((c) => ({ ...c, name: decodeEntities(c.name), url: undefined, secret: undefined, kind: c.kind || 'ics', urlHost: hostOf(c.url) }));
}

function hostOf(enc) {
  try { return new URL(icsUrl(decrypt(enc))).host; } catch { return ''; }
}

// kind 'caldav': url = the calendar collection (from caldav.discover), username + password to sign in.
async function addCalendar({ name, url, color, vehicle_id, kind = 'ics', username = null, password = null }) {
  if (kind === 'caldav') {
    if (!/^https:\/\/.+/i.test(String(url || ''))) throw new Error('Choose a calendar of the account.');
    if (!username || !password) throw new Error('User name and (app-specific) password are needed.');
    return db.insertReturningId(
      'INSERT INTO calendars (name, url, color, vehicle_id, enabled, created_at, kind, username, secret) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)',
      [require('./caldav').decodeEntities(String(name || 'Calendar')).trim().slice(0, 80), encrypt(String(url)), color || '#3b82c4', vehicle_id || null, new Date().toISOString(), 'caldav', String(username).slice(0, 200), encrypt(String(password))]
    );
  }
  const u = icsUrl(url);
  if (!/^https?:\/\/.+/i.test(u)) throw new Error('The calendar address must start with https://, http:// or webcal://.');
  const id = await db.insertReturningId(
    'INSERT INTO calendars (name, url, color, vehicle_id, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    [require('./caldav').decodeEntities(String(name || 'Calendar')).trim().slice(0, 80), encrypt(u), color || '#3b82c4', vehicle_id || null, new Date().toISOString()]
  );
  return id;
}

// Pure: the calendar's own name from an ICS text (X-WR-CALNAME), or null.
function icsName(text) {
  const m = /^X-WR-CALNAME:(.+)$/m.exec(String(text || '').replace(/\r/g, ''));
  return m ? require('./caldav').decodeEntities(m[1].trim().replace(/\\,/g, ',')).slice(0, 80) : null;
}

async function fetchIcs(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'LoxSuite', Accept: 'text/calendar, */*' } });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('The address did not return a calendar (no BEGIN:VCALENDAR).');
    return text;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('No answer within 20 s.');
    if (err.message === 'fetch failed') throw new Error(`Cannot reach ${new URL(url).host} (${err.cause?.code || 'network error'}).`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function syncCalendar(cal, { nowMs = Date.now(), fetchText = fetchIcs } = {}) {
  const cfg = await getConfig();
  const ical = require('node-ical');
  const from = nowMs - cfg.window_days_back * 86400000;
  const to = nowMs + cfg.window_days_ahead * 86400000;
  try {
    const text = cal.kind === 'caldav'
      ? await require('./caldav').fetchRange({ url: decrypt(cal.url), username: cal.username, password: decrypt(cal.secret), fromMs: from, toMs: to })
      : await fetchText(icsUrl(decrypt(cal.url)));
    const occ = expandEvents(ical.sync.parseICS(text), from, to);
    const seen = new Set();
    for (const o of occ) {
      const tagText = `${o.title}\n${o.description}`;
      // #brengen / #halen is about driving there, so it marks the car as needed too
      const tripTag = parseTripTag(tagText);
      const car = hasCarTag(tagText, cfg.tags) || !!tripTag;
      const hint = car ? parseCarHint(o.title) || parseCarHint(o.description) : null;
      await db.upsert('calendar_events', {
        calendar_id: cal.id, uid: o.uid.slice(0, 255), start_at: o.start, end_at: o.end, all_day: o.allDay ? 1 : 0,
        title: o.title.slice(0, 300), location: o.location.slice(0, 300) || null, car_tag: car ? 1 : 0, car_hint: hint ? JSON.stringify(hint) : null,
        trip_tag: tripTag,
      }, ['calendar_id', 'uid', 'start_at']);
      seen.add(`${o.uid}|${o.start}`);
    }
    const existing = await db.prepare('SELECT id, uid, start_at FROM calendar_events WHERE calendar_id = ? AND start_at >= ? AND start_at < ?')
      .all(cal.id, new Date(from).toISOString(), new Date(to).toISOString());
    for (const e of existing) if (!seen.has(`${e.uid}|${e.start_at}`)) await db.prepare('DELETE FROM calendar_events WHERE id = ?').run(e.id);
    await db.prepare('UPDATE calendars SET last_sync_at = ?, last_error = NULL WHERE id = ?').run(new Date().toISOString(), cal.id);
    return { ok: true, events: occ.length };
  } catch (err) {
    await db.prepare('UPDATE calendars SET last_error = ?, last_sync_at = ? WHERE id = ?').run(err.message, new Date().toISOString(), cal.id);
    return { ok: false, message: err.message };
  }
}

async function syncAll() {
  const cals = await db.prepare('SELECT * FROM calendars WHERE enabled = 1').all();
  const out = [];
  for (const c of cals) out.push({ id: c.id, ...(await syncCalendar(c)) });
  return out;
}

// ------------------------------------------------------------------ distance (OpenStreetMap)

async function geoFetch(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'LoxSuite (self-hosted home automation)', Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.message === 'fetch failed') throw new Error(`Cannot reach ${new URL(url).host} (${err.cause?.code || 'network error'}).`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

let lastGeoAt = 0;
const GEO_RETRY_MS = 6 * 3600000;
// Pure: what to ask the geocoder for an agenda location, best first. A calendar often puts a name in
// front of the address ("Coöperatie VGZ Nieuwe Stationsstraat 12, 6811 KS Arnhem, Nederland"), which
// OpenStreetMap doesn't find: then without the leading name / parts, and finally postcode + town.
function addressCandidates(address) {
  const q = String(address || '').trim().replace(/\s+/g, ' ');
  if (!q) return [];
  const out = [q];
  const add = (x) => { const v = String(x || '').trim().replace(/^[,\s]+|[,\s]+$/g, ''); if (v && !out.includes(v)) out.push(v); };
  const parts = q.split(/\s*,\s*/).filter(Boolean);
  const country = /^(nederland|netherlands|the netherlands|nl|belgi[eë]|belgium|deutschland|germany)$/i;
  const core = parts.filter((p) => !country.test(p));
  // "<name> <street> <number>" in the first part: drop words in front of the street, one at a time
  if (/\s\d+\s?[a-zA-Z]?(?:-\d+)?$/.test(core[0] || '')) {
    const words = core[0].split(' ');
    for (let i = 1; i <= words.length - 2; i++) add([words.slice(i).join(' '), ...core.slice(1)].join(', '));
  }
  // without the leading part(s) (a name or building on its own)
  for (let i = 1; i < core.length; i++) add(core.slice(i).join(', '));
  // postcode + town: at least the right neighbourhood
  const pc = /\b(\d{4}\s?[A-Z]{2})\b/.exec(q);
  if (pc) {
    const after = q.slice(pc.index + pc[0].length).split(',')[0].trim();
    add(after ? `${pc[1]} ${after}` : pc[1]);
  }
  return out.slice(0, 7);
}

// Address -> { lat, lon, distance_km (one way, by road), duration_min } from home, cached. A failed
// lookup is tried again after 6 hours.
async function distanceFromHome(address, { get = geoFetch, force = false } = {}) {
  const q = String(address || '').trim().replace(/\s+/g, ' ');
  if (!q) return null;
  const site = await settings.get('site', { lat: null, lon: null });
  if (site.lat === null || site.lon === null) return { error: 'Home location not set.' };
  const key = `${q.toLowerCase().slice(0, 230)}|${Number(site.lat).toFixed(4)},${Number(site.lon).toFixed(4)}`;
  const cached = await db.prepare('SELECT * FROM geo_cache WHERE query = ?').get(key);
  if (cached && (!cached.error || (!force && Date.now() - Date.parse(cached.fetched_at) < GEO_RETRY_MS))) return cached;
  let row;
  try {
    let found = null;
    for (const cand of addressCandidates(q)) {
      // Nominatim's usage policy: at most one request per second.
      const wait = 1100 - (Date.now() - lastGeoAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastGeoAt = Date.now();
      const res = await get(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=nl,be,de,lu,fr&q=${encodeURIComponent(cand)}`);
      if (res?.length) { found = res; break; }
    }
    if (!found?.length) throw new Error('Address not found.');
    const lat = Number(found[0].lat);
    const lon = Number(found[0].lon);
    const route = await get(`https://router.project-osrm.org/route/v1/driving/${site.lon},${site.lat};${lon},${lat}?overview=false`);
    const r = route?.routes?.[0];
    if (!r) throw new Error('No route found.');
    row = { query: key, lat, lon, distance_km: Math.round(r.distance / 100) / 10, duration_min: Math.round(r.duration / 60), error: null, fetched_at: new Date().toISOString() };
  } catch (err) {
    row = { query: key, lat: null, lon: null, distance_km: null, duration_min: null, error: err.message, fetched_at: new Date().toISOString() };
  }
  await db.upsert('geo_cache', row, ['query']);
  return row;
}

// ------------------------------------------------------------------ items for the views

async function overridesMap() {
  const rows = await db.prepare('SELECT * FROM event_overrides').all();
  return new Map(rows.map((r) => [`${r.calendar_id}|${r.uid}|${r.start_at}`, r]));
}

// Pure: '' / unknown -> null (not chosen: from the calendar text), else one of TRIP_MODES.
function cleanMode(v) {
  if (v === null || v === undefined || v === '') return null;
  return TRIP_MODES.includes(String(v)) ? String(v) : null;
}
// Pure: '' -> null (not chosen), else 1/0.
function cleanFlag(v) {
  if (v === null || v === undefined || v === '') return null;
  return Number(v) ? 1 : 0;
}

// Only the fields that are given change; the others (car needed, own value, climate, how you drive,
// driving on) are kept. With scope 'series', car needed / how you drive / driving on go to the whole
// series of a recurring appointment: one row with start_at '*'; the choices made per day for those
// give way to it.
const SERIES_FIELDS = ['needs_car', 'trip_mode', 'chain_start', 'chain_end'];
async function setOverride(b) {
  const { calendar_id, uid } = b;
  const start_at = b.start_at;
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const clean = (k, v) => (k === 'trip_mode' ? cleanMode(v) : cleanFlag(v));
  if (b.scope === 'series' && SERIES_FIELDS.some(has)) {
    const ser = await db.prepare('SELECT * FROM event_overrides WHERE calendar_id = ? AND uid = ? AND start_at = ?').get(Number(calendar_id), String(uid), '*') || {};
    const row = {
      calendar_id: Number(calendar_id), uid: String(uid), start_at: '*',
      needs_car: ser.needs_car ?? null, own_value: ser.own_value ?? null, climate_c: ser.climate_c ?? null,
      trip_mode: ser.trip_mode ?? null, chain_start: ser.chain_start ?? null, chain_end: ser.chain_end ?? null,
    };
    for (const k of SERIES_FIELDS.filter(has)) {
      row[k] = clean(k, b[k]);
      await db.prepare(`UPDATE event_overrides SET ${k} = NULL WHERE calendar_id = ? AND uid = ? AND start_at <> '*'`).run(Number(calendar_id), String(uid));
    }
    await db.upsert('event_overrides', row, ['calendar_id', 'uid', 'start_at']);
    b = { ...b };
    SERIES_FIELDS.forEach((k) => delete b[k]);
    if (!start_at || !['own_value', 'climate_c'].some((k) => Object.prototype.hasOwnProperty.call(b, k))) return;
  }
  const cur = await db.prepare('SELECT * FROM event_overrides WHERE calendar_id = ? AND uid = ? AND start_at = ?').get(Number(calendar_id), String(uid), String(start_at)) || {};
  const keep = (k) => (Object.prototype.hasOwnProperty.call(b, k) ? clean(k, b[k]) : (cur[k] ?? null));
  await db.upsert('event_overrides', {
    calendar_id: Number(calendar_id), uid: String(uid), start_at: String(start_at),
    needs_car: keep('needs_car'),
    own_value: Object.prototype.hasOwnProperty.call(b, 'own_value') ? (b.own_value ? String(b.own_value).slice(0, 60) : null) : (cur.own_value ?? null),
    climate_c: Object.prototype.hasOwnProperty.call(b, 'climate_c') ? parseClimate(b.climate_c) : (cur.climate_c ?? null),
    trip_mode: keep('trip_mode'), chain_start: keep('chain_start'), chain_end: keep('chain_end'),
  }, ['calendar_id', 'uid', 'start_at']);
}

// '' / 'off' -> null; otherwise a temperature the Škoda API accepts (16–29.5 °C, half degrees).
function parseClimate(v) {
  if (v === null || v === undefined || v === '' || v === 'off') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.min(29.5, Math.max(16, Math.round(n * 2) / 2));
}

async function vehicleFor(vehicleId) {
  if (vehicleId) return db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
  return db.prepare('SELECT * FROM vehicles WHERE enabled = 1 ORDER BY id LIMIT 1').get();
}

// Everything in [from, to): calendar events (with car decision + need), LoxSuite trips, each with
// the route(s) it is part of (item.tours) — see build().
async function items(fromIso, toIso, opts = {}) {
  return (await build(fromIso, toIso, opts)).items;
}

// The car's routes (home → stops → home) that touch [from, to), in order of leaving home.
async function tours(fromIso, toIso, opts = {}) {
  const a = Date.parse(fromIso), b = Date.parse(toIso);
  // a route can start before the range (driving on into it) or run past it
  const pad = 86400000;
  const all = (await build(new Date(a - pad).toISOString(), new Date(b + pad).toISOString(), opts)).tours;
  return all.filter((t) => Date.parse(t.backAt) > a && Date.parse(t.leaveAt) < b);
}

async function build(fromIso, toIso, { withGeo = false, fetchLegs = false } = {}) {
  const cfg = await getConfig();
  const cals = new Map((await db.prepare('SELECT id, name, color, vehicle_id FROM calendars').all()).map((c) => [c.id, c]));
  const ov = await overridesMap();
  const events = await db.prepare('SELECT * FROM calendar_events WHERE end_at > ? AND start_at < ? ORDER BY start_at').all(fromIso, toIso);
  const recurring = new Set((await db.prepare('SELECT calendar_id, uid FROM calendar_events GROUP BY calendar_id, uid HAVING COUNT(*) > 1').all()).map((r) => `${r.calendar_id}|${r.uid}`));
  const out = [];
  for (const e of events) {
    const cal = cals.get(e.calendar_id) || {};
    if (cal.name) cal.name = require('./caldav').decodeEntities(cal.name);
    const o0 = ov.get(`${e.calendar_id}|${e.uid}|${e.start_at}`);
    const so = ov.get(`${e.calendar_id}|${e.uid}|*`);
    // the day's own choice, else the series' choice; own value and climate per day
    const o = o0 && o0.needs_car !== null ? o0 : so && so.needs_car !== null ? { ...(o0 || {}), needs_car: so.needs_car, series: true } : o0;
    const needsCar = o && o.needs_car !== null && o.needs_car !== undefined ? !!o.needs_car : !!e.car_tag;
    // how you drive and driving on: the day's own choice, else the series', else the calendar text
    const pick = (k) => (o0 && o0[k] !== null && o0[k] !== undefined ? { v: o0[k], src: 'you' } : so && so[k] !== null && so[k] !== undefined ? { v: so[k], src: 'series' } : null);
    const mode = pick('trip_mode');
    const cs = pick('chain_start');
    const ce = pick('chain_end');
    const item = {
      kind: 'event', id: e.id, calendar_id: e.calendar_id, calendar: cal.name, color: cal.color, uid: e.uid,
      start: e.start_at, end: e.end_at, allDay: !!e.all_day, title: e.title, location: e.location,
      carTag: !!e.car_tag, needsCar, carSource: o && o.needs_car !== null && o.needs_car !== undefined ? (o.series ? 'series' : 'you') : e.car_tag ? 'tag' : null,
      recurring: recurring.has(`${e.calendar_id}|${e.uid}`),
      own: o?.own_value || null, hint: e.car_hint ? JSON.parse(e.car_hint) : null, vehicle_id: o?.vehicle_id || cal.vehicle_id || null,
      askCar: !needsCar && !!e.location && !(o && Number(o.needs_car) === 0 && o.needs_car !== null),
      climateC: o?.climate_c ?? null,
      tripMode: e.all_day ? 'stay' : (TRIP_MODES.includes(mode?.v) ? mode.v : (e.trip_tag || 'stay')),
      tripModeSource: mode ? mode.src : e.trip_tag ? 'tag' : null, tripTag: e.trip_tag || null,
      chainStart: !!Number(cs?.v || 0), chainEnd: !!Number(ce?.v || 0), chainSource: cs?.src === 'series' || ce?.src === 'series' ? 'series' : cs || ce ? 'you' : null,
    };
    if (needsCar) await enrichNeed(item, cfg, withGeo);
    out.push(item);
  }
  const trips = await db.prepare('SELECT * FROM trips').all();
  for (const t of trips) {
    const occ = tripOccurrences(t, Date.parse(fromIso), Date.parse(toIso));
    for (const start of occ) {
      const dur = t.return_at ? Date.parse(t.return_at) - Date.parse(t.depart_at) : 3600000;
      const item = {
        kind: 'trip', id: t.id, title: t.title, start: new Date(start).toISOString(), end: new Date(start + dur).toISOString(), allDay: false,
        location: t.location, needsCar: true, carSource: 'trip', own: t.own_value, hint: null, vehicle_id: t.vehicle_id, weekly: !!t.weekly, color: '#5CA83F',
        climateC: t.climate_c ?? null, tripMode: 'stay', chainStart: false, chainEnd: false,
      };
      await enrichNeed(item, cfg, withGeo);
      out.push(item);
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  const routes = await routesOf(out, cfg, { fetchLegs });
  return { items: out, tours: routes };
}

function tripOccurrences(t, fromMs, toMs) {
  const first = Date.parse(t.depart_at);
  if (!t.weekly) return first >= fromMs - 86400000 && first < toMs ? [first] : [];
  const out = [];
  const week = 7 * 86400000;
  let s = first + Math.max(0, Math.ceil((fromMs - first) / week)) * week;
  for (; s < toMs; s += week) if (s >= first) out.push(s);
  return out;
}

async function enrichNeed(item, cfg, withGeo) {
  const vehicle = await vehicleFor(item.vehicle_id);
  const usable = vehicle?.battery_kwh ? vehicle.battery_kwh * ((vehicle.charge_limit_pct || 100) / 100) : null;
  const kpk = require('./driving').currentKwhPerKm(vehicle, cfg.default_kwh_per_km);
  let geo = null;
  const own = parseOwnValue(item.own);
  if (!own && !item.hint?.km && !item.hint?.kwh && !item.hint?.full && item.location && cfg.geo) {
    geo = withGeo ? await distanceFromHome(item.location) : await cachedDistance(item.location);
  }
  const need = tripNeedKwh({ hint: item.hint, own, distanceKm: geo?.distance_km || null, marginKm: Number(cfg.margin_km) || 0, kwhPerKm: kpk, usableKwh: usable, rounds: item.tripMode === 'both' ? 2 : 1 });
  item.needExplicit = (own || item.hint)?.full ? 'full' : (own || item.hint)?.km || (own || item.hint)?.kwh ? 'value' : null;
  item.lat = geo?.lat ?? null;
  item.lon = geo?.lon ?? null;
  item.distanceKm = geo?.distance_km ?? null;
  item.travelMin = geo?.duration_min ?? null;
  item.geoError = geo?.error || null;
  item.needKwh = need.kwh;
  item.needKm = need.km ?? null;
  item.needBasis = need.basis;
  item.kwhPerKm = kpk;
  item.usableKwh = usable;
  item.vehicleType = vehicle?.type || null;
  // Leave = start minus travel time (when known; only picking up: the end); ready = leave minus the
  // margin. A route past several appointments sets its own (routesOf).
  const leave = Date.parse(item.tripMode === 'pick' ? item.end : item.start) - (item.travelMin ? item.travelMin * 60000 : 0);
  item.leaveAt = new Date(item.allDay ? Date.parse(item.start) + 8 * 3600000 : leave).toISOString();
  item.readyAt = new Date(Date.parse(item.leaveAt) - (Number(cfg.ready_margin_min) || 0) * 60000).toISOString();
}

// ------------------------------------------------------------------ routes (home → stops → home)

function keyOf(i) { return `${i.kind}|${i.calendar_id || i.id}|${i.uid || ''}|${i.start}`; }

// Pure: the stops an appointment with the car makes. 'stay': there from the start to the end (the car
// stays there); 'drop': at the start, a few minutes; 'pick': at the end, a few minutes. chain: after
// this stop the car drives on to the next appointment instead of going home.
function stopsOf(item, dwellMin = 5) {
  const s = Date.parse(item.start);
  const e = Date.parse(item.end);
  const dw = Math.max(0, Number(dwellMin) || 0) * 60000;
  const mode = item.allDay ? 'stay' : (item.tripMode || 'stay');
  const at = (role, arrive, depart, chain) => ({ item, role, arrive, depart, chain: !!chain && !item.allDay });
  if (mode === 'both') return [at('drop', s, s + dw, item.chainStart), at('pick', e, e + dw, item.chainEnd)];
  if (mode === 'drop') return [at('drop', s, s + dw, item.chainStart)];
  if (mode === 'pick') return [at('pick', e, e + dw, item.chainEnd)];
  return [at('stay', s, e, item.chainEnd)];
}

// Pure: the stops of one car -> routes, in time order. A stop that drives on is followed by the next
// stop that isn't in a route yet (not an all-day one), when that starts within maxGapH and isn't the
// same appointment's pick-up (then there is nothing to drive on to: home in between).
function chainStops(stops, { maxGapH = 12 } = {}) {
  const list = [...stops].sort((a, b) => a.arrive - b.arrive || a.depart - b.depart);
  const used = new Set();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const route = [list[i]];
    let cur = i;
    while (list[cur].chain) {
      let k = cur + 1;
      while (k < list.length && (used.has(k) || list[k].item.allDay)) k++;
      // nothing in between before picking up again at the same appointment: home first
      if (k >= list.length || list[k].item === list[cur].item || list[k].arrive - list[cur].depart > maxGapH * 3600000) break;
      used.add(k);
      route.push(list[k]);
      cur = k;
    }
    out.push(route);
  }
  return out;
}

// Pure: km as the crow flies.
function crowKm(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const normAddr = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Pure: the drive from stop a to stop b. The same address: none. Else the road distance when looked
// up (cached), else as the crow flies × 1.3 at 50 km/h, else via home (never shorter) — those two
// marked approx. Null = unknown.
function legOf(a, b, cached = null) {
  const ia = a.item;
  const ib = b.item;
  if (ia === ib || (ia.location && normAddr(ia.location) === normAddr(ib.location))) return { km: 0, min: 0 };
  if (cached && !cached.error && Number.isFinite(cached.distance_km)) return { km: cached.distance_km, min: Number.isFinite(cached.duration_min) ? cached.duration_min : Math.round(cached.distance_km / 50 * 60) };
  if ([ia.lat, ia.lon, ib.lat, ib.lon].every(Number.isFinite)) {
    const km = Math.round(crowKm(ia, ib) * 1.3 * 10) / 10;
    return { km, min: Math.round(km / 50 * 60), approx: true };
  }
  if (Number.isFinite(ia.distanceKm) && Number.isFinite(ib.distanceKm)) return { km: ia.distanceKm + ib.distanceKm, min: (ia.travelMin || 0) + (ib.travelMin || 0), approx: true };
  return null;
}

// Pure: from home to a stop's address, or back (the lookup from home). Null = unknown.
function homeLeg(st) {
  return Number.isFinite(st.item.distanceKm) ? { km: st.item.distanceKm, min: st.item.travelMin || 0 } : null;
}

// Pure: what a route needs. From its legs + the margin once (each drive from home). An appointment
// with its own value (km or kWh) counts at least that (shared over its drives), "full" = full; with
// legs that aren't known: each appointment's own estimate.
function routeNeed(route, legs, { marginKm = 20 } = {}) {
  const itemsIn = [];
  for (const st of route) if (!itemsIn.includes(st.item)) itemsIn.push(st.item);
  const share = (it) => route.filter((st) => st.item === it).length / (it._stops || 1);
  const kpk = itemsIn.find((i) => i.kwhPerKm)?.kwhPerKm || 0.2;
  const usable = itemsIn.find((i) => i.usableKwh)?.usableKwh ?? null;
  const known = legs.every(Boolean);
  const kmRaw = known ? legs.reduce((t, l) => t + l.km, 0) + (Number(marginKm) || 0) : null;
  const explicit = itemsIn.filter((i) => i.needExplicit === 'value' && Number.isFinite(i.needKwh)).reduce((t, i) => t + i.needKwh * share(i), 0);
  let kwh;
  if (itemsIn.some((i) => i.needExplicit === 'full')) kwh = usable;
  else if (itemsIn.length === 1 && itemsIn[0].needExplicit) kwh = itemsIn[0].needKwh * share(itemsIn[0]);
  else if (kmRaw !== null) kwh = Math.max(kmRaw * kpk, explicit);
  else {
    const own = itemsIn.map((i) => (Number.isFinite(i.needKwh) ? i.needKwh * share(i) : null));
    kwh = own.every((x) => x === null) ? null : own.reduce((t, x) => t + (x || 0), 0);
  }
  return {
    kwh: kwh === null || kwh === undefined || !Number.isFinite(kwh) ? null : Math.round(kwh * 10) / 10,
    km: kmRaw === null ? null : Math.round(kmRaw),
    approx: !known || legs.some((l) => l && l.approx),
  };
}

// Pure: one route -> { id, title, leaveAt, backAt, readyAt, kwh, km, stops, legs, ... }. legs =
// [home → 1, 1 → 2, …, n → home]. A leg that is too short for the time between two appointments is
// marked tight.
function routeOf(route, legs, { marginKm = 20, readyMarginMin = 15 } = {}) {
  const first = route[0];
  const last = route[route.length - 1];
  const leave = first.item.allDay ? Date.parse(first.item.leaveAt) : first.arrive - (legs[0]?.min || 0) * 60000;
  const back = Math.max(...route.map((st) => st.depart)) + (legs[legs.length - 1]?.min || 0) * 60000;
  const need = routeNeed(route, legs, { marginKm });
  const titles = [];
  for (const st of route) if (titles[titles.length - 1] !== st.item.title) titles.push(st.item.title);
  return {
    id: `${keyOf(first.item)}|${first.role}`, vehicle_id: first.item.vehicle_id || null, allDay: !!first.item.allDay,
    title: titles.join(' → '), leaveAt: new Date(leave).toISOString(), backAt: new Date(back).toISOString(),
    readyAt: new Date(leave - (Number(readyMarginMin) || 0) * 60000).toISOString(),
    kwh: need.kwh, km: need.km, approx: need.approx, marginKm: Number(marginKm) || 0,
    stops: route.map((st) => ({ key: keyOf(st.item), title: st.item.title, role: st.role, arrive: new Date(st.arrive).toISOString(), depart: new Date(st.depart).toISOString(), location: st.item.location || null })),
    legs: legs.map((l, i) => (l ? { ...l, tight: i > 0 && i < legs.length - 1 && route[i - 1].depart + l.min * 60000 > route[i].arrive + 5 * 60000 } : null)),
    firstItem: first.item, climateC: first.item.climateC ?? null,
  };
}

// The cached road distance between two addresses (either way), or null.
async function cachedLeg(ia, ib) {
  if (![ia.lat, ia.lon, ib.lat, ib.lon].every(Number.isFinite)) return null;
  const k = (a, b) => `leg|${a.lat.toFixed(4)},${a.lon.toFixed(4)}|${b.lat.toFixed(4)},${b.lon.toFixed(4)}`;
  const there = await db.prepare('SELECT * FROM geo_cache WHERE query = ?').get(k(ia, ib));
  if (there) return there;
  return db.prepare('SELECT * FROM geo_cache WHERE query = ?').get(k(ib, ia));
}

// Looks up the road distance between two addresses (OSRM, like the distance from home), cached; a
// failed lookup is tried again after 6 hours.
async function fetchLeg(ia, ib, { get = geoFetch } = {}) {
  if (![ia.lat, ia.lon, ib.lat, ib.lon].every(Number.isFinite)) return null;
  const key = `leg|${ia.lat.toFixed(4)},${ia.lon.toFixed(4)}|${ib.lat.toFixed(4)},${ib.lon.toFixed(4)}`;
  const cur = await cachedLeg(ia, ib);
  if (cur && (!cur.error || Date.now() - Date.parse(cur.fetched_at) < GEO_RETRY_MS)) return cur;
  let row;
  try {
    const wait = 1100 - (Date.now() - lastGeoAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeoAt = Date.now();
    const route = await get(`https://router.project-osrm.org/route/v1/driving/${ia.lon},${ia.lat};${ib.lon},${ib.lat}?overview=false`);
    const r = route?.routes?.[0];
    if (!r) throw new Error('No route found.');
    row = { query: key, lat: ib.lat, lon: ib.lon, distance_km: Math.round(r.distance / 100) / 10, duration_min: Math.round(r.duration / 60), error: null, fetched_at: new Date().toISOString() };
  } catch (err) {
    row = { query: key, lat: ib.lat, lon: ib.lon, distance_km: null, duration_min: null, error: err.message, fetched_at: new Date().toISOString() };
  }
  await db.upsert('geo_cache', row, ['query']);
  return row;
}

// The routes of the appointments with the car in `list` (per car), and on each item: item.tours (the
// routes it is part of), item.departures (the drives from home it starts: for climate at departure),
// item.leaveAt / readyAt (its first route's), item.nextAfterStart / nextAfterEnd (the next appointment
// with the car after its stop, to offer driving on).
async function routesOf(list, cfg, { fetchLegs = false } = {}) {
  const dwell = Number(cfg.dwell_min ?? DEFAULTS.dwell_min);
  const maxGapH = Number(cfg.chain_max_gap_h ?? DEFAULTS.chain_max_gap_h);
  const marginKm = Number(cfg.margin_km) || 0;
  const readyMarginMin = Number(cfg.ready_margin_min) || 0;
  const byCar = new Map();
  for (const it of list) {
    if (!it.needsCar) continue;
    const st = stopsOf(it, dwell);
    it._stops = st.length;
    const k = it.vehicle_id || 0;
    byCar.set(k, (byCar.get(k) || []).concat(st));
  }
  const out = [];
  for (const stops of byCar.values()) {
    const sorted = [...stops].filter((x) => !x.item.allDay).sort((a, b) => a.arrive - b.arrive || a.depart - b.depart);
    for (const [idx, st] of sorted.entries()) {
      const nx = sorted[idx + 1];
      const info = nx && nx.item !== st.item && nx.arrive - st.depart <= maxGapH * 3600000 ? { title: nx.item.title, at: new Date(nx.arrive).toISOString(), role: nx.role } : null;
      if (st.role === 'drop') st.item.nextAfterStart = info; else st.item.nextAfterEnd = info;
    }
    for (const route of chainStops(stops, { maxGapH })) {
      const legs = [homeLeg(route[0])];
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1].item;
        const b = route[i].item;
        let cached = null;
        if (a !== b && normAddr(a.location) !== normAddr(b.location)) {
          cached = await cachedLeg(a, b).catch(() => null);
          if (fetchLegs && (!cached || cached.error)) cached = await fetchLeg(a, b).catch(() => null);
        }
        legs.push(legOf(route[i - 1], route[i], cached));
      }
      legs.push(homeLeg(route[route.length - 1]));
      out.push({ route, r: routeOf(route, legs, { marginKm, readyMarginMin }) });
    }
  }
  out.sort((a, b) => a.r.leaveAt.localeCompare(b.r.leaveAt));
  for (const { route, r } of out) {
    route.forEach((st, idx) => {
      const it = st.item;
      if (!it.tours) {
        it.tours = [];
        it.departures = [];
        it.leaveAt = r.leaveAt;
        it.readyAt = r.readyAt;
      }
      it.tours.push({
        id: r.id, role: st.role, first: idx === 0, title: r.title, leaveAt: r.leaveAt, backAt: r.backAt, readyAt: r.readyAt,
        kwh: r.kwh, km: r.km, approx: r.approx, marginKm: r.marginKm, stops: r.stops.map((x) => ({ title: x.title, role: x.role, arrive: x.arrive, location: x.location })), legs: r.legs,
      });
      if (idx === 0) it.departures.push({ leaveAt: r.leaveAt, n: it.departures.length });
    });
  }
  return out.map((x) => x.r);
}

async function cachedDistance(address) {
  const site = await settings.get('site', { lat: null, lon: null });
  if (site.lat === null) return null;
  const key = `${String(address).trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 230)}|${Number(site.lat).toFixed(4)},${Number(site.lon).toFixed(4)}`;
  return db.prepare('SELECT * FROM geo_cache WHERE query = ?').get(key);
}

// The next item that needs the car (within 7 days) — the planner's deadline.
// A drive from home (drop off at the start, pick up at the end, or a route past several appointments)
// counts on its own: { title, readyAt, needKwh, item (its first appointment), tour }.
async function nextCarTrip(nowMs, vehicle = null) {
  const list = await tours(new Date(nowMs).toISOString(), new Date(nowMs + 7 * 86400000).toISOString());
  const next = list.find((t) => Date.parse(t.readyAt) > nowMs + 10 * 60000 && (!vehicle || !t.vehicle_id || t.vehicle_id === vehicle.id));
  return next ? { title: next.title, readyAt: Date.parse(next.readyAt), needKwh: next.kwh, item: next.firstItem, tour: next } : null;
}

// Look up distances in the background for every upcoming appointment with an address and no
// distance yet (and between appointments you drive on between) — also ones not marked for the car, so marking one shows its distance at once — and
// try failed ones again (distanceFromHome waits 6 h between tries). Nominatim allows 1 request/s.
async function resolveUpcomingDistances(nowMs = Date.now()) {
  const cfg = await getConfig();
  if (!cfg.geo) return;
  const list = await items(new Date(nowMs).toISOString(), new Date(nowMs + 14 * 86400000).toISOString());
  const seen = new Set();
  for (const i of list) {
    if (!i.location || i.distanceKm !== null && i.distanceKm !== undefined) continue;
    const k = String(i.location).trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const c = await cachedDistance(i.location).catch(() => null);
    if (c && !c.error) continue;
    await distanceFromHome(i.location).catch(() => {});
  }
  // and the road distances between appointments you drive on between (routes)
  await build(new Date(nowMs).toISOString(), new Date(nowMs + 14 * 86400000).toISOString(), { fetchLegs: true }).catch(() => {});
}

let timer = null;
function startAgenda() {
  if (timer) return;
  const run = async () => {
    await syncAll().catch(() => {});
    await resolveUpcomingDistances().catch(() => {});
  };
  timer = setInterval(run, 15 * 60 * 1000);
  timer.unref?.();
  require('./carClimate').start();
  setTimeout(run, 55000).unref?.();
}

function stopAgenda() {
  if (timer) clearInterval(timer);
  timer = null;
  require('./carClimate').stop();
}

module.exports = {
  DEFAULTS, TRIP_MODES, hasCarTag, parseCarHint, parseTripTag, parseOwnValue, tripNeedKwh, stopsOf, chainStops, legOf, routeNeed, routeOf, crowKm, cleanMode, cleanFlag, tours, fetchLeg, icsUrl, expandEvents, tripOccurrences,
  addressCandidates, icsName, fetchIcs, getConfig, listCalendars, addCalendar, syncCalendar, syncAll, distanceFromHome, items, setOverride, parseClimate, nextCarTrip, startAgenda, stopAgenda, resolveUpcomingDistances,
};
