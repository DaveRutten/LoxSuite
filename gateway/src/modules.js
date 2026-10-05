// Modules: LoxSuite as a fixed core plus parts you switch on or off per installation
// (Administration > Modules). A module that is off is hidden from the menu, its pages answer
// "this module is off", and its background work is stopped — its data stays, so switching it on
// again brings everything back.
//
// Per module: key, label, what it is for, the group it is shown in, the modules it needs (switched
// on along with it), whether a NEW installation starts with it, the URL prefixes it owns, its
// background workers (start/stop, required lazily so this file loads without side effects) and a
// check "is this already in use?" for existing installations: on the first start after the update
// every module that is in use is switched on, so nothing disappears.
//
// State: table app_modules (module_key, enabled). In memory after init(); setEnabled() updates both
// and starts/stops the workers right away, no restart needed.
const db = require('./db');

const lazy = (file, fn) => (...a) => require(file)[fn](...a);
const count = async (sql, ...p) => { try { return Number((await db.prepare(sql).get(...p))?.n || 0); } catch { return 0; } };

const GROUPS = [
  { key: 'integration', label: 'Integration & insight' },
  { key: 'energy', label: 'Energy & charging' },
];

const MODULES = [
  {
    key: 'mqtt', group: 'integration', label: 'MQTT bridge', defaultOn: true, requires: [],
    description: 'Mosquitto broker and the two-way bridge between MQTT and Loxone virtual inputs/outputs.',
    parts: ['Broker, MQTT users and roles', 'Mappings MQTT → Loxone and Loxone → MQTT', 'Transformations, common commands', 'Live Data (MQTT), Client Activity', 'Logs: MQTT broker, Loxone commands'],
    routes: ['/mappings', '/incoming', '/mqtt-users', '/mqtt-roles', '/transformations', '/logs/mqtt', '/logs/loxone-commands'],
    inUse: async () => true,
  },
  {
    key: 'monitor', group: 'integration', label: 'Monitor & dashboards', defaultOn: true, requires: ['mqtt'],
    description: 'Follow values over time in charts and put them on your own dashboards.',
    parts: ['Monitor (charts, CSV)', 'My Dashboards, favourites, sharing'],
    routes: ['/monitor'],
    inUse: async () => true,
  },
  {
    key: 'loxone_logs', group: 'integration', label: 'Loxone logs', defaultOn: true, requires: [],
    description: 'Collect and read the log of every Miniserver.',
    parts: ['Logs per Miniserver'],
    routes: ['/logs/loxone'],
    inUse: async () => true,
  },
  {
    key: 'ai', group: 'integration', label: 'AI assistant', defaultOn: false, requires: [],
    description: 'Chat with an AI that knows your installation, with providers and MCP tools.',
    parts: ['AI chat (widget and page)', 'Provider and model settings'],
    routes: ['/ai-chat', '/admin/ai'],
    inUse: async () => (await count('SELECT COUNT(*) AS n FROM ai_settings WHERE enabled = 1')) > 0,
  },
  {
    key: 'energy', group: 'energy', label: 'Energy', defaultOn: false, requires: [],
    description: 'Meters for grid, solar, Wallbox and home battery, hourly values, energy prices and the solar forecast. The base for charging and the energy manager.',
    parts: ['Meters and hourly values, import from Loxone', 'Energy prices (dynamic or fixed)', 'Solar forecast with learned correction', 'House consumption profile'],
    routes: ['/energy'],
    workers: [
      { start: lazy('./energyMeters', 'startEnergyMeters'), stop: lazy('./energyMeters', 'stopEnergyMeters') },
      { start: lazy('./prices', 'startPrices'), stop: lazy('./prices', 'stopPrices') },
      { start: lazy('./solarForecast', 'startSolarForecast'), stop: lazy('./solarForecast', 'stopSolarForecast') },
    ],
    inUse: async () => (await count('SELECT COUNT(*) AS n FROM energy_meters')) > 0,
  },
  {
    key: 'vehicles', group: 'energy', label: 'Vehicles', defaultOn: false, requires: [],
    description: 'Your cars with live data from Homey, Home Assistant, MQTT or HTTP, trips and cost per km.',
    parts: ['Vehicles and their data source', 'Driving & costs (trips, learned consumption)'],
    routes: ['/vehicles', '/driving'],
    workers: [
      { start: lazy('./vehicles', 'startVehicles'), stop: lazy('./vehicles', 'stopVehicles') },
      { start: lazy('./driving', 'startDriving'), stop: lazy('./driving', 'stopDriving') },
    ],
    inUse: async () => (await count('SELECT COUNT(*) AS n FROM vehicles')) > 0,
  },
  {
    key: 'charging', group: 'energy', label: 'Smart charging', defaultOn: false, requires: ['energy', 'vehicles'],
    description: 'Charge at the cheapest and sunniest moments, ready before you leave, with a log of every session.',
    parts: ['Smart charging (planner, output to the Wallbox)', 'Charge log with automatic checks', 'Learned departures and energy per trip', 'Agenda (calendars, trips)', 'Plug-in reminders, fuel price'],
    routes: ['/planner', '/learned', '/agenda'],
    workers: [
      { start: lazy('./planner', 'startPlanner'), stop: lazy('./planner', 'stopPlanner') },
      { start: lazy('./chargeLog', 'startChargeLog'), stop: lazy('./chargeLog', 'stopChargeLog') },
      { start: lazy('./learning', 'startLearning'), stop: lazy('./learning', 'stopLearning') },
      { start: lazy('./agenda', 'startAgenda'), stop: lazy('./agenda', 'stopAgenda') },
      { start: lazy('./reminders', 'startReminders'), stop: lazy('./reminders', 'stopReminders') },
      { start: lazy('./fuelPrice', 'startFuelPrice'), stop: lazy('./fuelPrice', 'stopFuelPrice') },
    ],
    inUse: async () => (await count('SELECT COUNT(*) AS n FROM charging_sessions')) > 0
      || (await count("SELECT COUNT(*) AS n FROM wallbox_settings WHERE setting_key = 'planner'")) > 0,
  },
  {
    key: 'ocpp', group: 'energy', label: 'OCPP & charging costs', defaultOn: false, requires: [],
    description: 'Report Wallbox sessions to an OCPP backend such as Laadloon, with statistics and quarterly export.',
    parts: ['OCPP bridges (Wallbox → OCPP 1.6)', 'Charging statistics and MQTT topics', 'Quarterly export'],
    routes: ['/ocpp'],
    workers: [
      { start: lazy('./ocppBridge', 'startOcppBridges'), stop: lazy('./ocppBridge', 'stopOcppBridges') },
      { start: lazy('./ocppStats', 'startStatsPublisher'), stop: lazy('./ocppStats', 'stopStatsPublisher') },
    ],
    inUse: async () => (await count('SELECT COUNT(*) AS n FROM ocpp_bridges')) > 0,
  },
  {
    key: 'energy_manager', group: 'energy', label: 'Energy manager', defaultOn: false, requires: ['energy'],
    description: 'Plan other big consumers (tap water, heat pump, washer, dryer) together with the car — shadow mode first.',
    parts: ['Consumers with their own meter', 'Shadow plan and signals', 'Daily overview and savings'],
    routes: ['/energy-manager'],
    workers: [
      { start: lazy('./energyManager', 'startEnergyManager'), stop: lazy('./energyManager', 'stopEnergyManager') },
    ],
    inUse: async () => (await count('SELECT COUNT(*) AS n FROM energy_loads')) > 0,
  },
];

const byKey = new Map(MODULES.map((m) => [m.key, m]));
const state = new Map(); // key -> boolean
const running = new Set();
let ready = false;

// Dependencies: what has to be on with `key` (recursively), and what depends on `key`.
function requiredBy(key, set = new Set()) {
  for (const r of byKey.get(key)?.requires || []) { if (!set.has(r)) { set.add(r); requiredBy(r, set); } }
  return set;
}
function dependents(key, set = new Set()) {
  for (const m of MODULES) if (m.requires.includes(key) && !set.has(m.key)) { set.add(m.key); dependents(m.key, set); }
  return set;
}

// Pure: apply a switch to a state map, cascading dependencies. Returns the new map and what changed.
function applySwitch(current, key, on) {
  const next = new Map(current);
  const changed = [];
  const set = (k, v) => { if (next.get(k) !== v) { next.set(k, v); changed.push({ key: k, enabled: v }); } };
  if (on) { set(key, true); for (const r of requiredBy(key)) set(r, true); } else { set(key, false); for (const d of dependents(key)) set(d, false); }
  return { next, changed };
}

function isOn(key) {
  if (!byKey.has(key)) return true; // unknown key = core
  if (!ready) return true; // before init: don't hide anything
  return state.get(key) === true;
}

// First start after the update: on = in use (existing installs) or the default (new installs).
async function seed() {
  const fresh = (await count('SELECT COUNT(*) AS n FROM miniservers')) === 0;
  let map = new Map();
  for (const m of MODULES) map.set(m.key, fresh ? !!m.defaultOn : (m.defaultOn || await m.inUse().catch(() => false)));
  for (const m of MODULES) if (map.get(m.key)) map = applySwitch(map, m.key, true).next;
  const now = new Date().toISOString();
  for (const [k, v] of map) await db.upsert('app_modules', { module_key: k, enabled: v ? 1 : 0, updated_at: now }, ['module_key']);
  return map;
}

async function init() {
  let rows = [];
  try { rows = await db.prepare('SELECT module_key, enabled FROM app_modules').all(); } catch { rows = []; }
  if (!rows.length) {
    const map = await seed().catch(() => null);
    if (map) for (const [k, v] of map) state.set(k, v);
  } else {
    for (const r of rows) state.set(r.module_key, !!r.enabled);
    // A module added in a later version: its default (or in use).
    for (const m of MODULES) {
      if (state.has(m.key)) continue;
      const v = !!m.defaultOn || await m.inUse().catch(() => false);
      state.set(m.key, v);
      await db.upsert('app_modules', { module_key: m.key, enabled: v ? 1 : 0, updated_at: new Date().toISOString() }, ['module_key']).catch(() => {});
    }
  }
  ready = true;
  return Object.fromEntries(state);
}

function startWorkers(key) {
  if (running.has(key)) return;
  running.add(key);
  for (const w of byKey.get(key)?.workers || []) {
    try { const r = w.start(); if (r && r.catch) r.catch((e) => console.error(`[modules] ${key} start: ${e.message}`)); } catch (e) { console.error(`[modules] ${key} start: ${e.message}`); }
  }
}
async function stopWorkers(key) {
  if (!running.has(key)) return;
  running.delete(key);
  for (const w of byKey.get(key)?.workers || []) {
    try { await w.stop(); } catch (e) { console.error(`[modules] ${key} stop: ${e.message}`); }
  }
}
function startEnabledWorkers() { for (const m of MODULES) if (isOn(m.key)) startWorkers(m.key); }

async function setEnabled(key, on, { by = null } = {}) {
  if (!byKey.has(key)) throw new Error(`Unknown module "${key}".`);
  const { next, changed } = applySwitch(state, key, !!on);
  const now = new Date().toISOString();
  for (const c of changed) {
    await db.upsert('app_modules', { module_key: c.key, enabled: c.enabled ? 1 : 0, updated_at: now }, ['module_key']);
    state.set(c.key, c.enabled);
  }
  for (const c of changed) { if (c.enabled) startWorkers(c.key); else await stopWorkers(c.key); }
  if (changed.length) {
    const { logSystemEvent } = require('./auditLog');
    logSystemEvent(`Modules: ${changed.map((c) => `${byKey.get(c.key).label} ${c.enabled ? 'on' : 'off'}`).join(', ')}${by ? ` by ${by}` : ''}`).catch(() => {});
  }
  void next;
  return changed;
}

// The module that owns a request path, if any.
function moduleForPath(path) {
  const p = String(path || '').split('?')[0];
  for (const m of MODULES) for (const r of m.routes || []) if (p === r || p.startsWith(`${r}/`)) return m;
  return null;
}

// Express middleware: `moduleOn(key)` for the views, and a "module is off" answer for its pages.
function middleware() {
  return (req, res, next) => {
    res.locals.moduleOn = isOn;
    const m = moduleForPath(req.path);
    if (!m || isOn(m.key)) return next();
    res.status(404);
    if (req.method !== 'GET' || /\.json$/.test(req.path) || req.xhr || (req.get('accept') || '').includes('application/json')) {
      return res.json({ ok: false, error: `The module "${m.label}" is switched off.`, module: m.key });
    }
    return res.render('module-off', { module: m, isAdminUser: !!req.user?.isAdmin });
  };
}

// For the Modules page: each module with its state, what it needs and what needs it.
function overview() {
  return GROUPS.map((g) => ({
    ...g,
    modules: MODULES.filter((m) => m.group === g.key).map((m) => ({
      key: m.key, label: m.label, description: m.description, parts: m.parts, enabled: isOn(m.key), running: running.has(m.key),
      requires: m.requires.map((r) => byKey.get(r).label), neededBy: [...dependents(m.key)].map((d) => byKey.get(d).label),
      hasWorkers: !!(m.workers || []).length,
    })),
  }));
}

function _reset(map = null) { state.clear(); running.clear(); ready = !!map; if (map) for (const [k, v] of Object.entries(map)) state.set(k, v); }

module.exports = { MODULES, GROUPS, isOn, init, setEnabled, startEnabledWorkers, moduleForPath, middleware, overview, applySwitch, requiredBy, dependents, _reset };
