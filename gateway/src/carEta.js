// When the car that is out will be home, from what it reports right now (Škoda and other sources
// with a parking position): while it drives, the moment it set off from where it was parked plus the
// drive from there to home (OpenStreetMap routing); while it is parked somewhere else, home can't be
// earlier than the drive from there. The learned pattern and the agenda stay the fallback.
const DRIVE_MARGIN = 1.1; // traffic, parking, the last bit of the street
const MIN_AHEAD_MS = 5 * 60000;

const trips = new Map(); // vehicleId -> { away: {lat, lon, at, address}, since, parkedAt }
const routes = new Map(); // "lat,lon>lat,lon" -> { min, km, at } | { error, at }

function homeOf(vehicle, site) {
  const lat = vehicle?.home_lat ?? site?.lat;
  const lon = vehicle?.home_lon ?? site?.lon;
  return lat === null || lat === undefined || lon === null || lon === undefined ? null : { lat: Number(lat), lon: Number(lon) };
}

// Pure: follow the car's reports. -> true when it set off or parked (the plan should be redone).
function observe(vehicleId, reading, nowMs, sourceAtMs = null) {
  if (!vehicleId || !reading) return false;
  const t = trips.get(vehicleId) || { away: null, since: null };
  let changed = false;
  const driving = reading.location === 'driving';
  const hasCoords = Number.isFinite(reading.latitude) && Number.isFinite(reading.longitude) && !(reading.latitude === 0 && reading.longitude === 0);
  if (driving) {
    if (!t.since) { t.since = sourceAtMs && sourceAtMs <= nowMs ? sourceAtMs : nowMs; changed = true; }
  } else if (hasCoords) {
    if (t.since) { t.since = null; changed = true; }
    if (reading.home) { if (t.away) changed = true; t.away = null; }
    else {
      const moved = !t.away || Math.abs(t.away.lat - reading.latitude) > 0.002 || Math.abs(t.away.lon - reading.longitude) > 0.002;
      if (moved) changed = true;
      t.away = { lat: reading.latitude, lon: reading.longitude, at: nowMs, address: reading.location || null };
    }
  }
  trips.set(vehicleId, t);
  return changed;
}

// Pure: arrival from a drive that started at `since` and takes `durationMin`.
function etaFromTrip({ nowMs, since, durationMin }) {
  return Math.max(nowMs + MIN_AHEAD_MS, since + durationMin * DRIVE_MARGIN * 60000);
}

async function osrm(from, to, fetchFn = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetchFn(`https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`, {
      signal: ctrl.signal, headers: { 'User-Agent': 'LoxSuite (self-hosted home automation)', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = (await res.json())?.routes?.[0];
    if (!r) throw new Error('No route found.');
    return { min: Math.round(r.duration / 60), km: Math.round(r.distance / 100) / 10 };
  } finally { clearTimeout(timer); }
}

// Drive time from a place to home, cached per ~100 m (a failed lookup is retried after an hour).
async function driveToHome(from, home, { fetchFn } = {}) {
  const key = `${from.lat.toFixed(3)},${from.lon.toFixed(3)}>${home.lat.toFixed(3)},${home.lon.toFixed(3)}`;
  const c = routes.get(key);
  if (c && (!c.error || Date.now() - c.at < 3600000)) return c.error ? null : c;
  try {
    const r = { ...(await osrm(from, home, fetchFn)), at: Date.now() };
    routes.set(key, r);
    return r;
  } catch (err) {
    routes.set(key, { error: err.message, at: Date.now() });
    return null;
  }
}

// -> { at, source: 'driving', label, confidence } while it drives home, { minAt, label } while it is
// parked away (home can't be earlier), or null.
async function liveArrival(vehicle, nowMs, { site = null, fetchFn } = {}) {
  if (!vehicle) return null;
  const t = trips.get(vehicle.id);
  if (!t?.away) return null;
  if (!site) site = await require('./wallboxSettings').get('site', { lat: null, lon: null }).catch(() => null);
  const home = homeOf(vehicle, site);
  if (!home) return null;
  const r = await driveToHome(t.away, home, { fetchFn });
  if (!r) return null;
  const addr = t.away.address;
  if (t.since) {
    const label = addr ? `on the way from ${addr} (${r.km} km, ~${r.min} min drive)` : `on the way home (${r.km} km, ~${r.min} min drive)`;
    return { at: etaFromTrip({ nowMs, since: t.since, durationMin: r.min }), source: 'driving', confidence: 'live', label };
  }
  return { minAt: nowMs + r.min * 60000, label: addr ? `parked ${r.km} km away at ${addr}` : `parked ${r.km} km from home` };
}

function reset() { trips.clear(); routes.clear(); }

module.exports = { observe, etaFromTrip, liveArrival, driveToHome, homeOf, reset, _trips: trips };
