// Agenda (Wallbox > Agenda): ICS calendars (Nextcloud, Google, Outlook, iCloud — any "secret
// address" / subscription URL), plus trips planned in LoxSuite itself. An appointment needs the
// car when its title (or description) holds a car marker — 🚗 or #auto by default — or when you
// switch "Car needed" on for it in LoxSuite (that choice is stored in LoxSuite only; the calendar
// itself is never changed). For such appointments with an address, LoxSuite looks up the driving
// distance from home (OpenStreetMap: Nominatim + OSRM; only the addresses of car appointments are
// sent, results are cached), adds the margin (default 20 km), and turns it into kWh with the
// car's consumption. The planner then makes sure the car is ready before you have to leave.
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
};

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

// Own value typed in LoxSuite: "150 km", "30 kWh", "vol"/"full".
function parseOwnValue(text) { return parseCarHint(text); }

// kWh needed for a car appointment. distanceKm = one way; hint/own value win over the distance.
function tripNeedKwh({ hint, own, distanceKm, marginKm = 20, kwhPerKm = 0.2, usableKwh = null }) {
  const v = own || hint;
  if (v?.full) return usableKwh ? { kwh: usableKwh, basis: 'full' } : { kwh: null, basis: 'full' };
  if (v?.kwh) return { kwh: v.kwh, basis: `${v.kwh} kWh given` };
  const km = v?.km ? v.km : (distanceKm ? 2 * distanceKm + marginKm : null);
  if (!km) return { kwh: null, basis: 'unknown distance' };
  const kwh = Math.round(km * kwhPerKm * 10) / 10;
  const basis = v?.km ? `${v.km} km given` : `2 × ${Math.round(distanceKm)} km + ${marginKm} km margin`;
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
        title: String(ev.summary?.val ?? ev.summary ?? ''), location: String(ev.location?.val ?? ev.location ?? ''),
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
  return rows.map((c) => ({ ...c, url: undefined, urlHost: hostOf(c.url) }));
}

function hostOf(enc) {
  try { return new URL(icsUrl(decrypt(enc))).host; } catch { return ''; }
}

async function addCalendar({ name, url, color, vehicle_id }) {
  const u = icsUrl(url);
  if (!/^https?:\/\/.+/i.test(u)) throw new Error('The calendar address must start with https://, http:// or webcal://.');
  const id = await db.insertReturningId(
    'INSERT INTO calendars (name, url, color, vehicle_id, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    [String(name || 'Calendar').trim().slice(0, 80), encrypt(u), color || '#3b82c4', vehicle_id || null, new Date().toISOString()]
  );
  return id;
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
    const text = await fetchText(icsUrl(decrypt(cal.url)));
    const occ = expandEvents(ical.sync.parseICS(text), from, to);
    const seen = new Set();
    for (const o of occ) {
      const tagText = `${o.title}\n${o.description}`;
      const car = hasCarTag(tagText, cfg.tags);
      const hint = car ? parseCarHint(o.title) || parseCarHint(o.description) : null;
      await db.upsert('calendar_events', {
        calendar_id: cal.id, uid: o.uid.slice(0, 255), start_at: o.start, end_at: o.end, all_day: o.allDay ? 1 : 0,
        title: o.title.slice(0, 300), location: o.location.slice(0, 300) || null, car_tag: car ? 1 : 0, car_hint: hint ? JSON.stringify(hint) : null,
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
// Address -> { lat, lon, distance_km (one way, by road), duration_min } from home, cached.
async function distanceFromHome(address, { get = geoFetch } = {}) {
  const q = String(address || '').trim().replace(/\s+/g, ' ');
  if (!q) return null;
  const site = await settings.get('site', { lat: null, lon: null });
  if (site.lat === null || site.lon === null) return { error: 'Home location not set.' };
  const key = `${q.toLowerCase().slice(0, 230)}|${Number(site.lat).toFixed(4)},${Number(site.lon).toFixed(4)}`;
  const cached = await db.prepare('SELECT * FROM geo_cache WHERE query = ?').get(key);
  if (cached && (!cached.error || Date.now() - Date.parse(cached.fetched_at) < 86400000)) return cached;
  // Nominatim's usage policy: at most one request per second.
  const wait = 1100 - (Date.now() - lastGeoAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeoAt = Date.now();
  let row;
  try {
    const found = await get(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=nl,be,de,lu,fr&q=${encodeURIComponent(q)}`);
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

async function setOverride({ calendar_id, uid, start_at, needs_car, own_value }) {
  await db.upsert('event_overrides', {
    calendar_id: Number(calendar_id), uid: String(uid), start_at: String(start_at),
    needs_car: needs_car === null || needs_car === undefined || needs_car === '' ? null : (needs_car ? 1 : 0),
    own_value: own_value ? String(own_value).slice(0, 60) : null,
  }, ['calendar_id', 'uid', 'start_at']);
}

async function vehicleFor(vehicleId) {
  if (vehicleId) return db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
  return db.prepare('SELECT * FROM vehicles WHERE enabled = 1 ORDER BY id LIMIT 1').get();
}

// Everything in [from, to): calendar events (with car decision + need), LoxSuite trips.
async function items(fromIso, toIso, { withGeo = false } = {}) {
  const cfg = await getConfig();
  const cals = new Map((await db.prepare('SELECT id, name, color, vehicle_id FROM calendars').all()).map((c) => [c.id, c]));
  const ov = await overridesMap();
  const events = await db.prepare('SELECT * FROM calendar_events WHERE end_at > ? AND start_at < ? ORDER BY start_at').all(fromIso, toIso);
  const out = [];
  for (const e of events) {
    const cal = cals.get(e.calendar_id) || {};
    const o = ov.get(`${e.calendar_id}|${e.uid}|${e.start_at}`);
    const needsCar = o && o.needs_car !== null ? !!o.needs_car : !!e.car_tag;
    const item = {
      kind: 'event', id: e.id, calendar_id: e.calendar_id, calendar: cal.name, color: cal.color, uid: e.uid,
      start: e.start_at, end: e.end_at, allDay: !!e.all_day, title: e.title, location: e.location,
      carTag: !!e.car_tag, needsCar, carSource: o && o.needs_car !== null ? 'you' : e.car_tag ? 'tag' : null,
      own: o?.own_value || null, hint: e.car_hint ? JSON.parse(e.car_hint) : null, vehicle_id: o?.vehicle_id || cal.vehicle_id || null,
      askCar: !needsCar && !!e.location && !(o && o.needs_car === 0),
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
      };
      await enrichNeed(item, cfg, withGeo);
      out.push(item);
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
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
  const kpk = require('./driving').effectiveKwhPerKm(vehicle, cfg.default_kwh_per_km);
  let geo = null;
  const own = parseOwnValue(item.own);
  if (!own && !item.hint?.km && !item.hint?.kwh && !item.hint?.full && item.location && cfg.geo) {
    geo = withGeo ? await distanceFromHome(item.location) : await cachedDistance(item.location);
  }
  const need = tripNeedKwh({ hint: item.hint, own, distanceKm: geo?.distance_km || null, marginKm: Number(cfg.margin_km) || 0, kwhPerKm: kpk, usableKwh: usable });
  item.distanceKm = geo?.distance_km ?? null;
  item.travelMin = geo?.duration_min ?? null;
  item.geoError = geo?.error || null;
  item.needKwh = need.kwh;
  item.needKm = need.km ?? null;
  item.needBasis = need.basis;
  item.kwhPerKm = kpk;
  item.usableKwh = usable;
  item.vehicleType = vehicle?.type || null;
  // Leave = start minus travel time (when known); ready = leave minus the margin.
  const leave = Date.parse(item.start) - (item.travelMin ? item.travelMin * 60000 : 0);
  item.leaveAt = new Date(item.allDay ? Date.parse(item.start) + 8 * 3600000 : leave).toISOString();
  item.readyAt = new Date(Date.parse(item.leaveAt) - (Number(cfg.ready_margin_min) || 0) * 60000).toISOString();
}

async function cachedDistance(address) {
  const site = await settings.get('site', { lat: null, lon: null });
  if (site.lat === null) return null;
  const key = `${String(address).trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 230)}|${Number(site.lat).toFixed(4)},${Number(site.lon).toFixed(4)}`;
  return db.prepare('SELECT * FROM geo_cache WHERE query = ?').get(key);
}

// The next item that needs the car (within 7 days) — the planner's deadline.
async function nextCarTrip(nowMs, vehicle = null) {
  const list = await items(new Date(nowMs).toISOString(), new Date(nowMs + 7 * 86400000).toISOString());
  const next = list.find((i) => i.needsCar && Date.parse(i.readyAt) > nowMs + 10 * 60000 && (!vehicle || !i.vehicle_id || i.vehicle_id === vehicle.id));
  return next ? { title: next.title, readyAt: Date.parse(next.readyAt), needKwh: next.needKwh, item: next } : null;
}

// Look up distances for upcoming car items in the background (Nominatim allows 1 request/s).
async function resolveUpcomingDistances(nowMs = Date.now()) {
  const list = await items(new Date(nowMs).toISOString(), new Date(nowMs + 14 * 86400000).toISOString());
  for (const i of list) if (i.needsCar && i.location && i.distanceKm === null && !i.geoError) await distanceFromHome(i.location).catch(() => {});
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
  setTimeout(run, 55000).unref?.();
}

module.exports = {
  DEFAULTS, hasCarTag, parseCarHint, parseOwnValue, tripNeedKwh, icsUrl, expandEvents, tripOccurrences,
  getConfig, listCalendars, addCalendar, syncCalendar, syncAll, distanceFromHome, items, setOverride, nextCarTrip, startAgenda, resolveUpcomingDistances,
};
