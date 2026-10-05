// Vehicles: the cars charged at home and their live state from an optional data source (see
// migration 020 for the model). This module has three layers:
//
//   1. Pure helpers — parse numbers/booleans out of whatever a source sends, pick a value out of
//      a JSON payload by path, decide "at home", turn raw source values into one normalised
//      reading. No I/O, fully unit-tested.
//   2. Source readers — 'mqtt' (latest value of a topic as already seen by mqttClient's '#'
//      subscription, so no extra broker connection), 'http' (poll any JSON URL) and 'homey' (a
//      device's capabilities from a Homey Pro's local Web API), 'homeassistant' (entity states and
//      attributes from Home Assistant's REST API), and 'skoda' (the official MyŠkoda Public API: an
//      API key made in the MyŠkoda app, max. 20 requests per hour per car — stored as source_type
//      'http' with source_config.provider = 'skoda', so no schema change was needed). Each returns
//      { raw, updatedAt }. Node-RED and similar tools publish to the LoxSuite broker and use 'mqtt'.
//   3. A small runtime — every enabled vehicle is read on a fixed tick (MQTT every tick, HTTP/Homey
//      at their own poll interval), the latest reading kept in memory and on the vehicle row,
//      history written to vehicle_readings, and the values published as retained MQTT topics
//      loxsuite/vehicles/<id>/<field> (for Monitor, dashboards and Loxone mappings).
//
// The normalised reading is the only thing the rest of LoxSuite (the charging planner, later) reads.
const db = require('./db');
const { decrypt } = require('./secretCrypto');

// --------------------------------------------------------------------------- fields & presets

// Every field a source can map. `kind` drives parsing; `label`/`hint` are for the form.
const FIELDS = [
  { key: 'soc', label: 'State of charge (%)', kind: 'number' },
  { key: 'range_km', label: 'Electric range (km)', kind: 'number' },
  { key: 'total_range_km', label: 'Total range incl. fuel (km, hybrid)', kind: 'number' },
  { key: 'plugged', label: 'Plugged in', kind: 'plugged' },
  { key: 'charging', label: 'Charging', kind: 'charging' },
  { key: 'limit_soc', label: 'Charge limit in the car (%)', kind: 'number' },
  { key: 'odometer_km', label: 'Odometer (km)', kind: 'number' },
  { key: 'latitude', label: 'Latitude', kind: 'number' },
  { key: 'longitude', label: 'Longitude', kind: 'number' },
  { key: 'location', label: 'Location / presence (text)', kind: 'text' },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

// MQTT presets fill the topic fields as a starting point; every topic stays editable since the
// exact names depend on the other tool's own configuration (loadpoint number, entity names...).
const MQTT_PRESETS = {
  evcc: {
    label: 'evcc (loadpoint 1)',
    fields: {
      soc: 'evcc/loadpoints/1/vehicleSoc',
      range_km: 'evcc/loadpoints/1/vehicleRange',
      plugged: 'evcc/loadpoints/1/connected',
      charging: 'evcc/loadpoints/1/charging',
      limit_soc: 'evcc/loadpoints/1/vehicleLimitSoc',
      odometer_km: 'evcc/loadpoints/1/vehicleOdometer',
    },
  },
  homeassistant: {
    label: 'Home Assistant (MQTT Statestream)',
    fields: {
      soc: 'homeassistant/sensor/CAR_battery_level/state',
      range_km: 'homeassistant/sensor/CAR_electric_range/state',
      plugged: 'homeassistant/binary_sensor/CAR_charger_connected/state',
      charging: 'homeassistant/binary_sensor/CAR_charging/state',
      location: 'homeassistant/device_tracker/CAR_position/state',
    },
  },
};

// --------------------------------------------------------------------------- pure helpers

// "78", "78 %", "78,5", 78, {value: 78} -> 78; anything without a number -> null.
function parseNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value) && 'value' in value) return parseNumber(value.value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const m = String(value).trim().replace(',', '.').match(/^[-+]?\d*\.?\d+(e[-+]?\d+)?/i);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

const FALSE_WORDS = new Set(['0', 'false', 'off', 'no', 'nee', 'none', 'null', '', 'disconnected', 'unplugged',
  'not_connected', 'notconnected', 'plugged_out', 'not_charging', 'notcharging', 'idle', 'stopped', 'complete',
  'completed', 'finished', 'ready', 'unknown', 'unavailable', 'away', 'not_home']);

// Booleans as the many shapes sources send them. `kind` matters for state strings that mean
// different things per field: Homey's ev_charging_state "plugged_in" is plugged=true but
// charging=false, "plugged_in_charging" is both; evcc/HA send plain true/false/on/off.
function parseBool(value, kind = 'bool') {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value) && 'value' in value) return parseBool(value.value, kind);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'unknown' || s === 'unavailable') return null;
  if (kind === 'charging') {
    if (/(dis|not_|no_|stop|paus)charg|charging_(paused|stopped|complete|done|finished)|(ready|waiting)_(for_)?charg/.test(s)) return false;
    if (s.includes('charging') || s === 'charge') return true;
    if (s.startsWith('plugged') || s === 'connected' || s === 'disconnected') return false; // a plug state, not charging
  }
  if (kind === 'plugged') {
    if (/^(dis|un|not_|no_)|connect_cable|plug_in_cable|_out$/.test(s)) return false; // "CONNECT_CABLE" = cable not in yet
    if (s.startsWith('plugged') || s === 'connected' || s.includes('charg') || s === 'conserving' || s === 'locked') return true;
  }
  if (kind === 'charging' && (s === 'connect_cable' || s === 'conserving')) return false;
  if (FALSE_WORDS.has(s)) return false;
  if (['1', 'true', 'on', 'yes', 'ja', 'connected', 'plugged', 'plugged_in', 'charging', 'home'].includes(s)) return true;
  const n = parseNumber(s);
  if (n !== null && /^[-+]?\d/.test(s)) return n !== 0;
  return null;
}

// Value at a dot path in a JSON value: "data.battery.soc", "vehicles[0].soc", "" = the value
// itself. A string payload is parsed as JSON first when a path is given (MQTT payloads).
function getPath(input, path) {
  let obj = input;
  const p = (path || '').trim();
  if (!p) return obj;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return undefined; }
  }
  const parts = p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  for (const part of parts) {
    if (obj === null || obj === undefined) return undefined;
    obj = obj[part];
  }
  return obj;
}

// Great-circle distance in metres.
function distanceM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// raw: { fieldKey: value as the source delivered it }. Returns the normalised reading; fields the
// source didn't map are null. `home` is decided by (in order) coordinates vs. the home position,
// a location text equal to home_value, or — when the car reports itself plugged in — true (it can
// only be plugged in at the home Wallbox, since LoxSuite only knows that one).
function normalizeReading(raw, vehicle = {}) {
  const r = {};
  for (const f of FIELDS) {
    const v = raw ? raw[f.key] : undefined;
    if (f.kind === 'number') r[f.key] = parseNumber(v);
    else if (f.kind === 'plugged' || f.kind === 'charging') r[f.key] = parseBool(v, f.kind);
    else r[f.key] = v === undefined || v === null ? null : String(v).slice(0, 200);
  }
  if (r.soc !== null) {
    if (r.soc > 0 && r.soc <= 1 && raw && typeof raw.soc === 'number' && !Number.isInteger(raw.soc)) r.soc *= 100; // 0..1 fraction
    r.soc = Math.max(0, Math.min(100, Math.round(r.soc * 10) / 10));
  }
  if (r.charging === true && r.plugged === null) r.plugged = true;

  r.home = null;
  r.distance_m = null;
  const hasCoords = r.latitude !== null && r.longitude !== null && !(r.latitude === 0 && r.longitude === 0);
  if (hasCoords && vehicle.home_lat !== null && vehicle.home_lat !== undefined && vehicle.home_lon !== null && vehicle.home_lon !== undefined) {
    r.distance_m = Math.round(distanceM(r.latitude, r.longitude, Number(vehicle.home_lat), Number(vehicle.home_lon)));
    r.home = r.distance_m <= (Number(vehicle.home_radius_m) || 150);
  } else if (r.location !== null && vehicle.home_value) {
    r.home = r.location.trim().toLowerCase() === String(vehicle.home_value).trim().toLowerCase();
  }
  if (r.plugged === true && r.home === null) r.home = true;

  // Energy in the battery, when both the SoC and the capacity are known.
  const cap = Number(vehicle.battery_kwh);
  r.energy_kwh = r.soc !== null && cap > 0 ? Math.round(((r.soc / 100) * cap) * 10) / 10 : null;
  // Without an electric range from the car (a hybrid often only reports the combined range):
  // estimate it from the energy in the battery and the consumption.
  const kpk = Number(vehicle.kwh_per_km) > 0 ? Number(vehicle.kwh_per_km) : Number(vehicle.kwh_per_km_learned);
  r.range_estimated = false;
  if (r.range_km === null && r.energy_kwh !== null && kpk > 0) { r.range_km = Math.round(r.energy_kwh / kpk); r.range_estimated = true; }
  return r;
}

// Whether a reading is worth a history row: something meaningful changed, or it's been a while.
function readingChanged(prev, next, prevAtMs, nowMs, minIntervalMs = 15 * 60 * 1000) {
  if (!prev) return true;
  if (nowMs - prevAtMs >= minIntervalMs) return true;
  if (prev.plugged !== next.plugged || prev.charging !== next.charging || prev.home !== next.home) return true;
  if (next.odometer_km !== null && next.odometer_km !== undefined && prev.odometer_km !== next.odometer_km
    && (prev.odometer_km === null || prev.odometer_km === undefined || Math.abs(next.odometer_km - prev.odometer_km) >= 1)) return true;
  if (prev.soc !== next.soc && (prev.soc === null || next.soc === null || Math.abs(prev.soc - next.soc) >= 1)) return true;
  return false;
}

// Best guess of which Homey capability carries which field, from the capability ids alone. Only
// a default for the form — every mapping can be changed by hand.
// For a plug-in hybrid a single "range" capability is usually the combined range (battery + fuel),
// so it goes to total_range_km; only a capability that says electric/EV/battery is the electric range.
function guessHomeyFields(capabilities = [], type = null) {
  const caps = capabilities.map((c) => String(c));
  const find = (...tests) => caps.find((c) => tests.some((t) => (typeof t === 'string' ? c === t : t.test(c)))) || '';
  const evRange = find(/(electric|ev|battery|elec).*range|range.*(electric|ev|battery|elec)/i);
  const anyRange = find(/range/i);
  const totalRange = find(/(total|combined|fuel|combustion).*range|range.*(total|combined)/i);
  return {
    soc: find('measure_battery', 'ev_battery_level', /battery.*(level|percent|soc)/i, /(^|_)soc($|_|\.)/i, /^measure_battery/),
    range_km: evRange || (type === 'phev' ? '' : anyRange),
    total_range_km: totalRange || (type === 'phev' && !evRange ? anyRange : ''),
    plugged: find('ev_charging_state', /plug/i, /cable/i, /connected/i),
    charging: find('ev_charging_state', /charging/i),
    limit_soc: find(/target|limit/i),
    odometer_km: find(/odometer|mileage|milage/i),
    latitude: find(/lat(itude)?$/i),
    longitude: find(/lon(gitude)?$|lng$/i),
    location: find(/location|position|presence|home/i),
  };
}

// "Name: value" lines -> headers object.
function parseHeaderLines(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function parseConfig(vehicle) {
  if (!vehicle?.source_config) return {};
  try { return JSON.parse(vehicle.source_config) || {}; } catch { return {}; }
}

function secretOf(vehicle) {
  if (!vehicle?.secret) return '';
  try { return decrypt(vehicle.secret) || ''; } catch { return ''; }
}

// Local sources (Homey, Home Assistant) are read at least every minute while the Wallbox has a car
// connected or this car says it's plugged in or charging, so a plug-in shows up within a minute
// instead of after the (default 5 min) poll interval. A cloud HTTP source keeps its own interval.
const FAST_POLL_S = 60;
const LOCAL_SOURCES = new Set(['homey', 'homeassistant']);
// The kind of source as the user sees it: 'skoda' is stored as source_type 'http' + provider.
function sourceKind(vehicle, cfg = parseConfig(vehicle)) {
  return vehicle?.source_type === 'http' && cfg.provider === 'skoda' ? 'skoda' : (vehicle?.source_type || 'none');
}

// Škoda allows 20 requests per hour per car (failed ones count too): normally every 10 min, every
// 4 min (15/h) while the car is plugged in or the Wallbox has a car, never more often than that.
const SKODA_MIN_S = 240;
function pollIntervalS(vehicle, cfg = parseConfig(vehicle), { fast = false } = {}) {
  if (sourceKind(vehicle, cfg) === 'skoda') {
    const own = Number(cfg.interval_s);
    const base = Number.isFinite(own) && own >= SKODA_MIN_S ? Math.min(own, 86400) : 600;
    return fast ? SKODA_MIN_S : base;
  }
  const n = Number(cfg.interval_s);
  const base = Number.isFinite(n) && n >= 60 ? Math.min(n, 86400) : 300;
  return fast && LOCAL_SOURCES.has(vehicle?.source_type) ? Math.min(base, FAST_POLL_S) : base;
}

// --------------------------------------------------------------------------- source readers

const HTTP_TIMEOUT_MS = 10000;

async function fetchJson(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
    try { return JSON.parse(text); } catch { throw new Error('The response is not JSON.'); }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`No answer within ${HTTP_TIMEOUT_MS / 1000} s.`);
    if (err.message === 'fetch failed') {
      let host = url;
      try { host = new URL(url).host; } catch { /* keep url */ }
      throw new Error(`Cannot reach ${host} (${err.cause?.code || err.cause?.message || 'network error'}).`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function readMqtt(cfg, getTopicValue) {
  const raw = {};
  let newest = null;
  const missing = [];
  for (const key of FIELD_KEYS) {
    const f = cfg.fields?.[key];
    if (!f?.topic) continue;
    const entry = getTopicValue(f.topic);
    if (!entry) { missing.push(f.topic); continue; }
    raw[key] = f.path ? getPath(entry.value, f.path) : entry.value;
    if (!newest || entry.lastSeen > newest) newest = entry.lastSeen;
  }
  return { raw, updatedAt: newest, missing };
}

async function readHttp(cfg, secret) {
  if (!cfg.url) throw new Error('No URL set.');
  const body = await fetchJson(cfg.url, parseHeaderLines(secret));
  const raw = {};
  for (const key of FIELD_KEYS) {
    const f = cfg.fields?.[key];
    if (f?.path) raw[key] = getPath(body, f.path);
  }
  return { raw, updatedAt: new Date().toISOString(), body };
}

function homeyBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u;
}

async function listHomeyDevices(url, apiKey) {
  const base = homeyBase(url);
  if (!base) throw new Error('No Homey address set.');
  if (!apiKey) throw new Error('No Homey API key set.');
  const body = await fetchJson(`${base}/api/manager/devices/device/`, { Authorization: `Bearer ${apiKey}` });
  const list = Array.isArray(body) ? body : Object.values(body || {});
  return list.map((d) => ({
    id: d.id,
    name: d.name,
    class: d.class || d.virtualClass || null,
    zone: d.zoneName || null,
    capabilities: Array.isArray(d.capabilities) ? d.capabilities : Object.keys(d.capabilitiesObj || {}),
    values: Object.fromEntries(Object.entries(d.capabilitiesObj || {}).map(([k, v]) => [k, v?.value ?? null])),
  })).sort((a, b) => {
    const score = (d) => (d.class === 'car' ? 0 : d.capabilities.some((c) => /battery|ev_/.test(c)) ? 1 : 2);
    return score(a) - score(b) || String(a.name).localeCompare(String(b.name));
  });
}

async function readHomey(cfg, apiKey) {
  const base = homeyBase(cfg.url);
  if (!base) throw new Error('No Homey address set.');
  if (!cfg.device_id) throw new Error('No Homey device chosen.');
  if (!apiKey) throw new Error('No Homey API key set.');
  const d = await fetchJson(`${base}/api/manager/devices/device/${encodeURIComponent(cfg.device_id)}`, { Authorization: `Bearer ${apiKey}` });
  const caps = d.capabilitiesObj || {};
  const raw = {};
  let newest = null;
  for (const key of FIELD_KEYS) {
    const cap = cfg.fields?.[key]?.capability;
    if (!cap || !caps[cap]) continue;
    raw[key] = caps[cap].value;
    const lu = caps[cap].lastUpdated;
    if (lu && (!newest || lu > newest)) newest = lu;
  }
  return { raw, updatedAt: newest || new Date().toISOString(), body: { name: d.name, capabilities: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v?.value ?? null])) } };
}

// --- Home Assistant: entity states via the REST API with a long-lived access token. A field maps to
// an entity's state, or to one of its attributes (a device_tracker's latitude/longitude, say).
function haBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '').replace(/\/api$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u;
}

async function haStates(url, token) {
  const base = haBase(url);
  if (!base) throw new Error('No Home Assistant address set.');
  if (!token) throw new Error('No Home Assistant access token set.');
  const body = await fetchJson(`${base}/api/states`, { Authorization: `Bearer ${token}` });
  if (!Array.isArray(body)) throw new Error('Unexpected answer from Home Assistant.');
  return body;
}

// Entities for the picker: id, friendly name, state, unit and the attribute names, most car-like first.
async function listHaEntities(url, token) {
  const states = await haStates(url, token);
  const carish = /battery|soc|range|charg|plug|odometer|mileage|device_tracker|position|location|ev_|car|auto|skoda|vw|tesla|enyaq|octavia|superb/i;
  return states.map((s) => ({
    id: s.entity_id,
    name: s.attributes?.friendly_name || s.entity_id,
    state: s.state,
    unit: s.attributes?.unit_of_measurement || null,
    attributes: Object.keys(s.attributes || {}).filter((k) => !['friendly_name', 'icon', 'entity_picture', 'unit_of_measurement', 'device_class', 'state_class', 'attribution', 'supported_features'].includes(k)),
    carish: carish.test(`${s.entity_id} ${s.attributes?.friendly_name || ''}`),
  })).sort((a, b) => (b.carish - a.carish) || a.id.localeCompare(b.id));
}

// Default mapping from entity ids (only a starting point for the form).
function guessHaFields(entities = []) {
  const ids = entities.map((e) => (typeof e === 'string' ? e : e.id));
  const find = (re, domain) => ids.find((id) => (!domain || id.startsWith(`${domain}.`)) && re.test(id)) || '';
  const tracker = find(/./, 'device_tracker');
  return {
    soc: { entity: find(/battery_(level|percent)|state_of_charge|(^|_)soc($|_)|battery$/i, 'sensor') },
    range_km: { entity: find(/electric_range|ev_range|battery_range|electric.*range/i, 'sensor') },
    total_range_km: { entity: find(/total_range|combined_range|^sensor\.[a-z0-9_]*_range$/i, 'sensor') },
    plugged: { entity: find(/plug|cable|charger_connected|connected/i) },
    charging: { entity: find(/charging(_state)?$|is_charging/i) },
    limit_soc: { entity: find(/target|charge_limit|limit/i) },
    odometer_km: { entity: find(/odometer|mileage/i, 'sensor') },
    latitude: tracker ? { entity: tracker, attribute: 'latitude' } : { entity: '' },
    longitude: tracker ? { entity: tracker, attribute: 'longitude' } : { entity: '' },
    location: tracker ? { entity: tracker } : { entity: '' },
  };
}

function readHaFromStates(cfg, states) {
  const byId = new Map(states.map((s) => [s.entity_id, s]));
  const raw = {};
  let newest = null;
  const missing = [];
  for (const key of FIELD_KEYS) {
    const f = cfg.fields?.[key];
    if (!f?.entity) continue;
    const s = byId.get(f.entity);
    if (!s) { missing.push(f.entity); continue; }
    raw[key] = f.attribute ? s.attributes?.[f.attribute] : s.state;
    const lu = s.last_updated || s.last_changed;
    if (lu && (!newest || lu > newest)) newest = lu;
  }
  return { raw, updatedAt: newest || new Date().toISOString(), missing };
}

async function readHa(cfg, token) {
  const states = await haStates(cfg.url, token);
  const result = readHaFromStates(cfg, states);
  if (!Object.keys(result.raw).length && result.missing.length) throw new Error(`Entity not found: ${result.missing.slice(0, 3).join(', ')}.`);
  return result;
}

// ---- Škoda (official MyŠkoda Public API, https://public.api.connect.skoda-auto.cz/docs)

const SKODA_API = 'https://public.api.connect.skoda-auto.cz';
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

// Pure: the API's vehicle object -> raw fields (+ the newest carCapturedTimestamp).
function parseSkoda(body) {
  const v = body?.vehicle || {};
  const ch = v.charging || {};
  const st = ch.status || {};
  const fuel = v.fuelStatus || {};
  const ranges = [fuel.primaryEngineRange, fuel.secondaryEngineRange].filter(Boolean);
  const elec = ranges.find((r) => r.engineType === 'ELECTRIC') || null;
  const combustion = ranges.find((r) => r.engineType && r.engineType !== 'ELECTRIC') || null;
  const soc = st.battery?.stateOfChargeInPercent ?? elec?.currentSoCInPercent ?? null;
  const rangeM = st.battery?.remainingCruisingRangeInMeters;
  const raw = {
    soc,
    range_km: rangeM !== undefined && rangeM !== null ? Math.round(rangeM / 1000) : (elec?.remainingRangeInKm ?? null),
    total_range_km: fuel.totalRangeInKm ?? null,
    plugged: st.plugConnectionState ? st.plugConnectionState === 'CONNECTED' : null,
    charging: st.state ? st.state === 'CHARGING' : null,
    limit_soc: ch.settings?.targetStateOfChargeInPercent ?? null,
    odometer_km: v.odometer?.mileageInKm ?? null,
    latitude: v.parkingPosition?.gpsCoordinates?.latitude ?? null,
    longitude: v.parkingPosition?.gpsCoordinates?.longitude ?? null,
    location: v.parkingPosition?.state === 'IN_MOTION' ? 'driving' : (v.parkingPosition?.formattedAddress || null),
  };
  const stamps = [v.status, fuel, v.odometer, ch, v.airConditioning, v.parkingPosition].map((x) => x?.carCapturedTimestamp).filter(Boolean).sort();
  const extra = {
    chargeState: st.state || null, chargePowerKw: st.chargePowerInKw ?? null, minutesToFull: st.remainingTimeToFullyChargedInMinutes ?? null,
    fuelPct: combustion?.currentFuelLevelInPercent ?? null, climate: v.airConditioning?.state || null, name: v.name || null, plate: v.licensePlate || null,
    errors: (body?.errors || []).map((e) => e.description || e.type).filter(Boolean),
  };
  return { raw, updatedAt: stamps.length ? stamps[stamps.length - 1] : null, extra };
}

// Problem types of the API -> a sentence for the page and notifications.
function skodaProblem(status, problem) {
  const type = String(problem?.type || '').split('/').pop();
  const msgs = {
    'api-key-expired': 'The Škoda API key has expired — create a new one in the MyŠkoda app and paste it here.',
    'api-key-not-authorized': 'The Škoda API key is not valid for this car (VIN) — check the VIN, or create a key for this car in the MyŠkoda app.',
    'operation-not-authorized': 'The Škoda API key does not allow this.',
    'rate-limit-exceeded': 'Škoda rate limit reached (20 requests per hour per car) — LoxSuite waits and tries again.',
    'vehicle-not-accepting-requests': 'The car is not accepting requests right now (e.g. deep sleep or no connection).',
  };
  if (msgs[type]) return msgs[type];
  if (status === 401) return 'The Škoda API key was refused — check the key.';
  if (status === 404) return 'Škoda does not know this VIN for this API key.';
  return `Škoda API answered HTTP ${status}${problem?.detail ? `: ${String(problem.detail).slice(0, 120)}` : ''}`;
}

async function readSkoda(cfg, apiKey, { fetchFn = fetch } = {}) {
  const vin = String(cfg.vin || '').trim().toUpperCase();
  if (!VIN_RE.test(vin)) throw new Error('Fill in the 17-character VIN of the car.');
  if (!apiKey) throw new Error('No Škoda API key set.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  let res;
  try {
    res = await fetchFn(`${SKODA_API}/api/v1/vehicles/${encodeURIComponent(vin)}`, { headers: { Accept: 'application/json', 'X-API-Key': apiKey }, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`No answer within ${HTTP_TIMEOUT_MS / 1000} s.`);
    throw new Error(`Cannot reach ${new URL(SKODA_API).host} (${err.cause?.code || err.message}).`);
  } finally { clearTimeout(timer); }
  const header = (n) => (res.headers && res.headers.get ? res.headers.get(n) : null);
  const meta = {
    keyExpiresAt: header('X-API-Key-Expires-At'),
    rateRemaining: header('RateLimit-Remaining') !== null ? Number(header('RateLimit-Remaining')) : null,
    retryAfterS: header('Retry-After') !== null ? Number(header('Retry-After')) || null : null,
  };
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const err = new Error(skodaProblem(res.status, body));
    err.meta = { ...meta, retryAfterS: meta.retryAfterS || (res.status === 429 ? 900 : null) };
    throw err;
  }
  if (!body?.vehicle) throw new Error('Unexpected answer from the Škoda API.');
  const parsed = parseSkoda(body);
  return { raw: parsed.raw, updatedAt: parsed.updatedAt || new Date().toISOString(), extra: parsed.extra, meta, body };
}

// One read of a vehicle's source, normalised. Never throws: errors come back as { error }.
async function readVehicle(vehicle, { getTopicValue } = {}) {
  const cfg = parseConfig(vehicle);
  try {
    let result;
    if (vehicle.source_type === 'mqtt') {
      const lookup = getTopicValue || require('./mqttClient').getTopicValue;
      result = readMqtt(cfg, lookup);
      if (!Object.keys(result.raw).length) {
        const why = result.missing.length ? `No message seen yet on ${result.missing.slice(0, 3).join(', ')}${result.missing.length > 3 ? '…' : ''}.` : 'No topics mapped.';
        return { ok: false, error: why, raw: {}, reading: null };
      }
    } else if (sourceKind(vehicle, cfg) === 'skoda') {
      result = await readSkoda(cfg, secretOf(vehicle));
    } else if (vehicle.source_type === 'http') {
      result = await readHttp(cfg, secretOf(vehicle));
    } else if (vehicle.source_type === 'homey') {
      result = await readHomey(cfg, secretOf(vehicle));
    } else if (vehicle.source_type === 'homeassistant') {
      result = await readHa(cfg, secretOf(vehicle));
    } else {
      return { ok: false, error: 'No data source.', raw: {}, reading: null };
    }
    return { ok: true, raw: result.raw, reading: normalizeReading(result.raw, vehicle), sourceUpdatedAt: result.updatedAt, body: result.body, missing: result.missing || [], extra: result.extra || null, meta: result.meta || null };
  } catch (err) {
    return { ok: false, error: err.message, raw: {}, reading: null, meta: err.meta || null };
  }
}

// --------------------------------------------------------------------------- which car is it?

function normTag(t) {
  let hex = String(t || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (/^[0-9A-F]+$/.test(hex)) {
    if (hex.length > 4 && hex.startsWith('EC') && hex.endsWith('EC')) hex = hex.slice(2, -2);
    while (hex.length > 2 && hex.endsWith('00')) hex = hex.slice(0, -2);
  }
  return hex;
}
const lines = (text) => String(text || '').split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean);

// The vehicle a session belongs to: by NFC tag, by Loxone user, by "plugged in" from the cars' own
// data sources, or — with only one car — that car. Null when it can't be told apart.
function identifyVehicle(vehicles, { idTag = null, loxoneUser = null, pluggedIds = [] } = {}) {
  const list = (vehicles || []).filter((v) => v.enabled !== 0);
  if (idTag) {
    const t = normTag(idTag);
    const hit = list.find((v) => lines(v.id_tags).some((x) => normTag(x) === t));
    if (hit) return hit;
  }
  if (loxoneUser) {
    const u = String(loxoneUser).trim().toLowerCase();
    const hit = list.find((v) => lines(v.loxone_users).some((x) => x.toLowerCase() === u));
    if (hit) return hit;
  }
  const plugged = list.filter((v) => pluggedIds.includes(v.id));
  if (plugged.length === 1) return plugged[0];
  if (list.length === 1) return list[0];
  return null;
}

let vehicleCache = [];
function identifyVehicleCached(opts) {
  const plugged = vehicleCache.filter((v) => state.get(v.id)?.reading?.plugged === true).map((v) => v.id);
  return identifyVehicle(vehicleCache, { ...opts, pluggedIds: plugged });
}
async function refreshVehicleCache() {
  try { vehicleCache = await db.prepare('SELECT * FROM vehicles').all(); } catch { /* not migrated yet */ }
  return vehicleCache;
}

// --------------------------------------------------------------------------- runtime

const TICK_MS = 15 * 1000;
const PUBLISH_FIELDS = ['soc', 'range_km', 'total_range_km', 'plugged', 'charging', 'home', 'energy_kwh', 'limit_soc', 'odometer_km'];
const state = new Map(); // vehicle id -> { reading, raw, error, fetchedAt, sourceUpdatedAt, nextPollAt, historyAt }
const lastPublished = new Map(); // topic -> string
let timer = null;
let ticking = false;
let wallboxConnected = false;
let burstTimers = [];

function vehicleTopics(id) {
  return Object.fromEntries(PUBLISH_FIELDS.map((k) => [k, `loxsuite/vehicles/${id}/${k}`]));
}

const TOPIC_LABELS = {
  soc: 'State of charge (%)', range_km: 'Electric range (km)', total_range_km: 'Total range incl. fuel (km)', plugged: 'Plugged in', charging: 'Charging', home: 'At home',
  energy_kwh: 'Energy in battery (kWh)', limit_soc: 'Charge limit (%)', odometer_km: 'Odometer (km)',
};

function publishReading(id, reading) {
  let mqttClient;
  try { mqttClient = require('./mqttClient'); } catch { return; }
  const client = mqttClient.getClient();
  if (!client || !mqttClient.state?.connected || !reading) return;
  for (const [key, topic] of Object.entries(vehicleTopics(id))) {
    const v = reading[key];
    if (v === null || v === undefined) continue;
    const s = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    if (lastPublished.get(topic) === s) continue;
    lastPublished.set(topic, s);
    client.publish(topic, s, { qos: 0, retain: true });
  }
}

async function storeReading(vehicle, result, nowMs) {
  const st = state.get(vehicle.id) || {};
  const prev = st.reading || null;
  const next = result.reading;
  const nowIso = new Date(nowMs).toISOString();
  if (readingChanged(prev, next, st.historyAt || 0, nowMs)) {
    await db.prepare(
      'INSERT INTO vehicle_readings (vehicle_id, ts, soc, range_km, plugged, charging, home, odometer_km) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(vehicle.id, nowIso, next.soc, next.range_km,
      next.plugged === null ? null : next.plugged ? 1 : 0, next.charging === null ? null : next.charging ? 1 : 0,
      next.home === null ? null : next.home ? 1 : 0, next.odometer_km);
    await db.prepare('UPDATE vehicles SET last_reading = ?, last_reading_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...next, source_updated_at: result.sourceUpdatedAt || null }), nowIso, vehicle.id);
    st.historyAt = nowMs;
  }
  Object.assign(st, { reading: next, raw: result.raw, error: null, fetchedAt: nowIso, sourceUpdatedAt: result.sourceUpdatedAt || null });
  state.set(vehicle.id, st);
  publishReading(vehicle.id, next);
}

const SOURCE_LABELS = { mqtt: 'MQTT', http: 'HTTP', homey: 'Homey', homeassistant: 'Home Assistant', skoda: 'Škoda', none: 'none' };
const MQTT_GRACE_MS = 10 * 60 * 1000;

function staleAfterH(cfg) {
  const n = Number(cfg?.stale_after_h);
  return Number.isFinite(n) && n >= 0 ? n : 24;
}

function fmtAge(ms) {
  const min = Math.round(ms / 60000);
  if (min < 120) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

// Health of a vehicle's data source, from what the runtime saw: 'ok' or 'failing' with a reason.
// Failing = reading keeps failing (twice in a row for a polled source; for MQTT, no usable
// message for 10 minutes — retained topics arrive right after a broker reconnect, so a short gap
// right after a restart isn't a fault), or the source answers but its data hasn't changed for
// longer than stale_after_h (0 = don't check; a parked car that's asleep may legitimately not
// report for hours, hence the generous 24 h default).
function sourceHealth(vehicle, st, nowMs, cfg = parseConfig(vehicle)) {
  if (!st) return { status: 'unknown', detail: 'not read yet' };
  if (st.error) {
    const longEnough = vehicle.source_type === 'mqtt'
      ? (st.errorSince && nowMs - st.errorSince >= MQTT_GRACE_MS)
      : (st.failCount || 0) >= 2;
    if (longEnough) return { status: 'failing', detail: st.error };
    return { status: st.reading ? 'ok' : 'unknown', detail: st.error };
  }
  const limitH = staleAfterH(cfg);
  const ts = st.sourceUpdatedAt ? Date.parse(st.sourceUpdatedAt) : NaN;
  if (limitH > 0 && Number.isFinite(ts) && nowMs - ts > limitH * 3600 * 1000) {
    return { status: 'failing', detail: `no update for ${fmtAge(nowMs - ts)} (limit ${limitH} h)` };
  }
  return { status: 'ok', detail: null };
}

async function reportHealth(vehicle, st, nowMs) {
  const h = sourceHealth(vehicle, st, nowMs);
  st.health = h;
  if (h.status === 'unknown' || st.reportedHealth === h.status) return;
  st.reportedHealth = h.status;
  try {
    const { checkVehicleSourceStatus } = require('./notifications');
    await checkVehicleSourceStatus(vehicle, h.status, h.detail, SOURCE_LABELS[sourceKind(vehicle)] || vehicle.source_type);
  } catch (err) {
    console.error(`[vehicles] notification for ${vehicle.name} failed: ${err.message}`);
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await refreshVehicleCache();
    let vehicles;
    try { vehicles = await db.prepare('SELECT * FROM vehicles WHERE enabled = 1 AND source_type <> ?').all('none'); } catch { return; }
    const nowMs = Date.now();
    const seen = new Set();
    for (const v of vehicles) {
      seen.add(v.id);
      const st = state.get(v.id) || {};
      if (v.source_type !== 'mqtt' && st.nextPollAt && nowMs < st.nextPollAt) continue;
      const fast = wallboxConnected || st.reading?.plugged === true || st.reading?.charging === true;
      st.nextPollAt = nowMs + pollIntervalS(v, parseConfig(v), { fast }) * 1000;
      state.set(v.id, st);
      const result = await readVehicle(v);
      if (result.meta) {
        st.meta = { ...(st.meta || {}), ...Object.fromEntries(Object.entries(result.meta).filter(([, x]) => x !== null && x !== undefined)) };
        if (result.meta.retryAfterS) st.nextPollAt = Math.max(st.nextPollAt || 0, nowMs + result.meta.retryAfterS * 1000);
      }
      if (result.extra) st.extra = result.extra;
      if (result.ok) {
        st.failCount = 0;
        st.errorSince = null;
        await storeReading(v, result, nowMs).catch((err) => console.error(`[vehicles] ${v.name}: ${err.message}`));
      } else {
        st.failCount = (st.failCount || 0) + 1;
        if (!st.errorSince) st.errorSince = nowMs;
        Object.assign(st, { error: result.error, fetchedAt: new Date(nowMs).toISOString() });
      }
      await reportHealth(v, state.get(v.id) || st, nowMs);
    }
    for (const id of state.keys()) if (!seen.has(id)) state.delete(id);
  } finally {
    ticking = false;
  }
}

// Forget cached state for one vehicle (after its settings change) and read it right away.
function refreshVehicle(id) {
  state.delete(Number(id));
  tick().catch(() => {});
}

// The Wallbox (Loxone) saw a car plug in or unplug: read every polled source now, and again after
// 1 and 3 minutes (a car's cloud often reports the new state a little later than the Wallbox).
function notifyWallbox(connected) {
  const c = !!connected;
  if (c === wallboxConnected) return;
  wallboxConnected = c;
  const readAll = () => { for (const st of state.values()) st.nextPollAt = 0; tick().catch(() => {}); };
  burstTimers.forEach(clearTimeout);
  burstTimers = [60 * 1000, 180 * 1000].map((ms) => { const t = setTimeout(readAll, ms); t.unref?.(); return t; });
  readAll();
}

function getVehicleStatus(vehicle) {
  const st = state.get(vehicle.id);
  let stored = null;
  try { stored = vehicle.last_reading ? JSON.parse(vehicle.last_reading) : null; } catch { stored = null; }
  return {
    enabled: !!vehicle.enabled,
    sourceType: vehicle.source_type,
    reading: st?.reading || stored,
    raw: st?.raw || null,
    error: st?.error || null,
    fetchedAt: st?.fetchedAt || vehicle.last_reading_at || null,
    sourceUpdatedAt: st?.sourceUpdatedAt || stored?.source_updated_at || null,
    live: !!st?.reading,
    sourceKind: sourceKind(vehicle),
    extra: st?.extra || null,
    keyExpiresAt: st?.meta?.keyExpiresAt || null,
    rateRemaining: st?.meta?.rateRemaining ?? null,
    nextPollAt: st?.nextPollAt ? new Date(st.nextPollAt).toISOString() : null,
    health: st?.health || (vehicle.source_type === 'none' ? null : { status: 'unknown', detail: 'not read yet' }),
    staleAfterH: staleAfterH(parseConfig(vehicle)),
  };
}

function startVehicles() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
  setTimeout(() => { tick().catch(() => {}); }, 5000).unref?.();
}

function stopVehicles() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  identifyVehicle,
  identifyVehicleCached,
  refreshVehicleCache,
  normTag,
  FIELDS,
  FIELD_KEYS,
  MQTT_PRESETS,
  TOPIC_LABELS,
  parseNumber,
  parseBool,
  getPath,
  distanceM,
  normalizeReading,
  readingChanged,
  sourceHealth,
  staleAfterH,
  SOURCE_LABELS,
  sourceKind,
  parseSkoda,
  readSkoda,
  skodaProblem,
  VIN_RE,
  guessHomeyFields,
  parseHeaderLines,
  parseConfig,
  pollIntervalS,
  homeyBase,
  readMqtt,
  readVehicle,
  listHomeyDevices,
  listHaEntities,
  guessHaFields,
  readHaFromStates,
  haBase,
  vehicleTopics,
  getVehicleStatus,
  refreshVehicle,
  notifyWallbox,
  startVehicles, stopVehicles,
  tick,
};
