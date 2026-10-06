// Vehicles (see vehicles.js and migration 020): the cars charged at home and where their live data
// (state of charge, range, plugged in, location) comes from. Gated like the OCPP pages: viewing
// needs miniservers/view, every change miniservers/edit (a source can hold an API key or token).
const express = require('express');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { requirePermission } = require('../middleware/requirePermission');
const { encrypt, decrypt } = require('../secretCrypto');
const { logSystemEvent } = require('../auditLog');
const vehicles = require('../vehicles');
const mqttClient = require('../mqttClient');

const router = express.Router();

const TYPES = ['bev', 'phev'];
const SOURCES = ['none', 'mqtt', 'http', 'homey', 'homeassistant', 'skoda'];

function num(v, { min = -Infinity, max = Infinity } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) return NaN;
  return n;
}

// Form -> column values. Works for both the urlencoded form post and the JSON body the "Test"
// button sends (the same fields, serialised client-side), so a test always reads exactly what
// would be saved.
function parseForm(body) {
  const type = TYPES.includes(body.type) ? body.type : 'bev';
  const sourceType = SOURCES.includes(body.source_type) ? body.source_type : 'none';
  const values = {
    name: String(body.name || '').trim(),
    type,
    enabled: body.enabled ? 1 : 0,
    battery_kwh: num(body.battery_kwh, { min: 1, max: 300 }),
    charge_limit_pct: num(body.charge_limit_pct, { min: 20, max: 100 }) ?? 100,
    reserve_pct: num(body.reserve_pct, { min: 0, max: 90 }) ?? (type === 'phev' ? 0 : 15),
    kwh_per_km: num(body.kwh_per_km, { min: 0.05, max: 1 }),
    fuel_l_per_100km: num(body.fuel_l_per_100km, { min: 0.5, max: 30 }),
    source_type: sourceType === 'skoda' ? 'http' : sourceType, // Škoda = 'http' + provider (see vehicles.js)
    home_lat: num(body.home_lat, { min: -90, max: 90 }),
    home_lon: num(body.home_lon, { min: -180, max: 180 }),
    home_radius_m: num(body.home_radius_m, { min: 20, max: 5000 }) ?? 150,
    home_value: String(body.home_value || '').trim() || null,
    id_tags: String(body.id_tags || '').trim().slice(0, 500) || null,
    loxone_users: String(body.loxone_users || '').trim().slice(0, 500) || null,
    ocpp_report: body.ocpp_report ? 1 : 0,
    secret: '',
  };
  for (const k of ['battery_kwh', 'charge_limit_pct', 'reserve_pct', 'kwh_per_km', 'fuel_l_per_100km', 'home_lat', 'home_lon', 'home_radius_m']) {
    if (Number.isNaN(values[k])) return { error: `"${k.replace(/_/g, ' ')}" is out of range.` };
  }
  if (!values.name) return { error: 'Name is required.' };
  if ((values.home_lat === null) !== (values.home_lon === null)) return { error: 'Fill in both home latitude and longitude (or neither).' };

  const interval = num(body.poll_interval_s, { min: 60, max: 86400 });
  const staleH = num(body.stale_after_h, { min: 0, max: 720 });
  if (Number.isNaN(interval)) return { error: 'Poll interval must be between 60 and 86400 seconds.' };
  if (Number.isNaN(staleH)) return { error: '"Alert when no update for" must be between 0 and 720 hours.' };
  const cfg = { fields: {}, stale_after_h: staleH ?? 24 };
  const field = (prefix, key) => String(body[`${prefix}_${key}`] || '').trim();
  if (sourceType === 'mqtt') {
    for (const key of vehicles.FIELD_KEYS) {
      const topic = field('mqtt_topic', key);
      if (topic) cfg.fields[key] = { topic, path: field('mqtt_path', key) };
    }
    if (!Object.keys(cfg.fields).length) return { error: 'Map at least one MQTT topic.' };
  } else if (sourceType === 'http') {
    cfg.url = String(body.http_url || '').trim();
    if (!/^https?:\/\/.+/i.test(cfg.url)) return { error: 'The URL must start with http:// or https://.' };
    cfg.interval_s = interval ?? 300;
    for (const key of vehicles.FIELD_KEYS) {
      const path = field('http_path', key);
      if (path) cfg.fields[key] = { path };
    }
    values.secret = String(body.http_headers || '');
  } else if (sourceType === 'homey') {
    cfg.url = String(body.homey_url || '').trim();
    cfg.device_id = String(body.homey_device_id || '').trim();
    cfg.device_name = String(body.homey_device_name || '').trim() || null;
    cfg.interval_s = interval ?? 300;
    if (!cfg.url) return { error: 'Fill in the Homey address.' };
    for (const key of vehicles.FIELD_KEYS) {
      const capability = field('homey_cap', key);
      if (capability) cfg.fields[key] = { capability };
    }
    values.secret = String(body.homey_key || '');
  } else if (sourceType === 'skoda') {
    cfg.provider = 'skoda';
    cfg.vin = String(body.skoda_vin || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!vehicles.VIN_RE.test(cfg.vin)) return { error: 'Fill in the 17-character VIN of the car (letters and digits, no I, O or Q).' };
    cfg.interval_s = Math.max(interval ?? 600, 240); // Škoda allows 20 requests per hour per car
    values.secret = String(body.skoda_key || '').trim();
  } else if (sourceType === 'homeassistant') {
    cfg.url = String(body.ha_url || '').trim();
    cfg.interval_s = interval ?? 300;
    if (!cfg.url) return { error: 'Fill in the Home Assistant address.' };
    for (const key of vehicles.FIELD_KEYS) {
      const entity = field('ha_entity', key);
      if (entity) cfg.fields[key] = { entity, attribute: field('ha_attr', key) };
    }
    values.secret = String(body.ha_token || '');
  }
  values.source_config = sourceType === 'none' ? null : JSON.stringify(cfg);
  values.source_kind = sourceType;
  return { values };
}

// The secret to store: a newly typed one, else the existing one as long as the source type didn't
// change (a Homey key is no use as Home Assistant token).
function secretToStore(values, existing) {
  if (values.secret) return encrypt(values.secret);
  if (existing && vehicles.sourceKind(existing) === (values.source_kind || values.source_type)) return existing.secret;
  return null;
}

function decryptSafe(v) {
  try { return v ? decrypt(v) : ''; } catch { return ''; }
}

async function loadVehicle(id) {
  return db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
}

const DEFAULTS = { type: 'phev', enabled: 1, charge_limit_pct: 100, reserve_pct: 0, home_radius_m: 150, source_type: 'none', ocpp_report: 1 };

function viewModel(v) {
  return { ...v, config: vehicles.parseConfig(v), hasSecret: !!v.secret, source_kind: vehicles.sourceKind(v) };
}

router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM vehicles ORDER BY name').all();
  res.render('vehicles', {
    vehicles: rows.map((v) => ({ ...v, status: vehicles.getVehicleStatus(v) })),
    v: { ...DEFAULTS, config: {} }, fields: vehicles.FIELDS, presets: vehicles.MQTT_PRESETS,
    sourceLabels: vehicles.SOURCE_LABELS, error: req.query.error || null,
  });
}));

router.post('/', requirePermission('vehicles', 'edit'), asyncHandler(async (req, res) => {
  const { values, error } = parseForm(req.body);
  if (error) return res.redirect(`/vehicles?error=${encodeURIComponent(error)}`);
  const now = new Date().toISOString();
  const id = await db.insertReturningId(
    `INSERT INTO vehicles (name, type, enabled, battery_kwh, charge_limit_pct, reserve_pct, kwh_per_km, fuel_l_per_100km,
       source_type, source_config, secret, home_lat, home_lon, home_radius_m, home_value, id_tags, loxone_users, ocpp_report, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [values.name, values.type, values.enabled, values.battery_kwh, values.charge_limit_pct, values.reserve_pct, values.kwh_per_km,
      values.fuel_l_per_100km, values.source_type, values.source_config, secretToStore(values, null), values.home_lat, values.home_lon,
      values.home_radius_m, values.home_value, values.id_tags, values.loxone_users, values.ocpp_report, now, now]
  );
  await logSystemEvent(`Vehicle "${values.name}" added (source: ${values.source_type}) by ${req.session?.username || 'unknown user'}`).catch(() => {});
  vehicles.refreshVehicle(id);
  vehicles.refreshVehicleCache().catch(() => {});
  return res.redirect(`/vehicles/${id}`);
}));

// Every MQTT topic the broker has carried (latest value), for the topic pickers. LoxSuite's own
// published vehicle topics are left out — mapping a vehicle onto its own output would loop.
router.get('/topics.json', requirePermission('vehicles', 'edit'), asyncHandler(async (req, res) => {
  const topics = mqttClient.getTopicOverview()
    .filter((t) => !t.topic.startsWith('loxsuite/vehicles/') && !t.topic.startsWith('$'))
    .slice(0, 3000)
    .map((t) => ({ topic: t.topic, value: String(t.value ?? '').slice(0, 80), lastSeen: t.lastSeen }));
  res.json({ ok: true, topics });
}));

// Homey devices / Home Assistant entities for the pickers. JSON POSTs (CSRF-exempt like the other
// JSON endpoints); a blank key/token falls back to the one saved on the vehicle being edited.
router.post('/homey-devices.json', requirePermission('vehicles', 'edit'), asyncHandler(async (req, res) => {
  let key = String(req.body?.key || '');
  if (!key && req.body?.vehicle_id) {
    const v = await loadVehicle(req.body.vehicle_id);
    if (v?.source_type === 'homey') key = decryptSafe(v.secret);
  }
  try {
    const devices = await vehicles.listHomeyDevices(req.body?.url, key);
    res.json({ ok: true, devices: devices.map((d) => ({ ...d, guess: vehicles.guessHomeyFields(d.capabilities, req.body?.type) })) });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
}));

router.post('/ha-entities.json', requirePermission('vehicles', 'edit'), asyncHandler(async (req, res) => {
  let token = String(req.body?.token || '');
  if (!token && req.body?.vehicle_id) {
    const v = await loadVehicle(req.body.vehicle_id);
    if (v?.source_type === 'homeassistant') token = decryptSafe(v.secret);
  }
  try {
    const entities = await vehicles.listHaEntities(req.body?.url, token);
    res.json({ ok: true, entities: entities.slice(0, 3000), guess: vehicles.guessHaFields(entities) });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
}));

// Reads the source once with the settings as they are in the form right now (not yet saved) and
// returns the raw values next to the normalised reading.
router.post('/test', requirePermission('vehicles', 'edit'), asyncHandler(async (req, res) => {
  const { values, error } = parseForm(req.body || {});
  if (error) return res.json({ ok: false, message: error });
  if (values.source_type === 'none') return res.json({ ok: false, message: 'Choose a data source first.' });
  const existing = req.body?.vehicle_id ? await loadVehicle(req.body.vehicle_id) : null;
  const probe = { ...values, id: existing?.id || 0, secret: secretToStore(values, existing) };
  if (vehicles.sourceKind(probe) === 'skoda' && probe.id) {
    // a test counts toward the car's Škoda budget too — refuse it rather than get the car blocked
    const list = await vehicles.skodaRequests(probe.id);
    const free = vehicles.skodaNextFree(list, Date.now());
    if (free > Date.now()) return res.json({ ok: false, message: `Škoda budget used (${vehicles.SKODA_BUDGET_PER_H} requests per hour) — try again after ${new Date(free).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}.` });
    await vehicles.skodaSpend(probe.id);
  }
  const result = await vehicles.readVehicle(probe);
  res.json({ ok: result.ok, message: result.error || null, raw: result.raw, reading: result.reading, missing: result.missing || [], sourceUpdatedAt: result.sourceUpdatedAt || null });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const v = await loadVehicle(req.params.id);
  if (!v) return res.redirect('/vehicles');
  res.render('vehicle-edit', {
    v: viewModel(v), fields: vehicles.FIELDS, presets: vehicles.MQTT_PRESETS, topics: vehicles.vehicleTopics(v.id),
    monitored: await require('../monitorPicks').monitoredMap(vehicles.vehicleTopics(v.id)),
    topicLabels: vehicles.TOPIC_LABELS, sourceLabels: vehicles.SOURCE_LABELS,
    error: req.query.error || null, saved: !!req.query.saved,
  });
}));

router.get('/:id/status.json', asyncHandler(async (req, res) => {
  const v = await loadVehicle(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found.' });
  res.json(vehicles.getVehicleStatus(v));
}));

// Adds the chosen published values as MQTT monitors (same as the OCPP statistics).
router.post('/:id/monitor', requirePermission('monitor', 'edit'), asyncHandler(async (req, res) => {
  const v = await loadVehicle(req.params.id);
  if (!v) return res.status(404).json({ ok: false, message: 'Not found.' });
  const topics = vehicles.vehicleTopics(v.id);
  const wanted = (Array.isArray(req.body?.metrics) ? req.body.metrics : []).filter((k) => topics[k]);
  if (!wanted.length) return res.json({ ok: false, message: 'Pick at least one value.' });
  const r = await require('../monitorPicks').addMonitors(topics, wanted, (key) => `${v.name} – ${vehicles.TOPIC_LABELS[key]}`);
  return res.json({ ok: true, ...r });
}));

router.post('/:id/update', requirePermission('vehicles', 'edit'), asyncHandler(async (req, res) => {
  const existing = await loadVehicle(req.params.id);
  if (!existing) return res.redirect('/vehicles');
  const { values, error } = parseForm(req.body);
  if (error) return res.redirect(`/vehicles/${existing.id}?error=${encodeURIComponent(error)}`);
  await db.prepare(
    `UPDATE vehicles SET name = ?, type = ?, enabled = ?, battery_kwh = ?, charge_limit_pct = ?, reserve_pct = ?, kwh_per_km = ?,
       fuel_l_per_100km = ?, source_type = ?, source_config = ?, secret = ?, home_lat = ?, home_lon = ?, home_radius_m = ?,
       home_value = ?, id_tags = ?, loxone_users = ?, ocpp_report = ?, updated_at = ?
     WHERE id = ?`
  ).run(values.name, values.type, values.enabled, values.battery_kwh, values.charge_limit_pct, values.reserve_pct, values.kwh_per_km,
    values.fuel_l_per_100km, values.source_type, values.source_config, secretToStore(values, existing), values.home_lat,
    values.home_lon, values.home_radius_m, values.home_value, values.id_tags, values.loxone_users, values.ocpp_report,
    new Date().toISOString(), existing.id);
  vehicles.refreshVehicle(existing.id);
  vehicles.refreshVehicleCache().catch(() => {});
  return res.redirect(`/vehicles/${existing.id}?saved=1`);
}));

router.post('/:id/delete', requirePermission('vehicles', 'edit'), asyncHandler(async (req, res) => {
  const existing = await loadVehicle(req.params.id);
  await db.prepare('DELETE FROM vehicle_readings WHERE vehicle_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM vehicles WHERE id = ?').run(req.params.id);
  if (existing) await logSystemEvent(`Vehicle "${existing.name}" deleted`).catch(() => {});
  vehicles.refreshVehicle(req.params.id);
  res.redirect('/vehicles');
}));

module.exports = router;
module.exports.parseForm = parseForm;
