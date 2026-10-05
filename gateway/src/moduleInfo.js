// Per module (modules.js): its status ("stand"), a Getting started checklist, an export of its data
// (zip with JSON + CSV per table) and wiping its data — only allowed while the module is off.
//
// `data` per module: the tables (parents first) that hold its data, optionally with a WHERE for a
// shared table. `wipe: false` = exported but never wiped (shared or used by the core, e.g. monitors
// that dashboards point at — only their history is wiped).
//
// Secrets never leave LoxSuite through an export: columns whose name looks like a password, token,
// key, secret or calendar URL are replaced by "[removed]" (they are stored encrypted anyway, and an
// encrypted value is useless elsewhere).
const AdmZip = require('adm-zip');
const db = require('./db');

const SECRET = /pass(word)?|secret|token|api_?key|ics_?url|credential|private/i;
const MAX_ROWS = 100000;

const count = async (sql, ...p) => { try { return Number((await db.prepare(sql).get(...p))?.n || 0); } catch { return 0; } };
const exists = async (sql, ...p) => (await count(sql, ...p)) > 0;
const since = (ms) => new Date(Date.now() - ms).toISOString();
async function setting(key) {
  try { const v = await require('./wallboxSettings').get(key, {}); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

const DATA = {
  mqtt: [
    { table: 'mappings_mqtt_to_loxone', label: 'MQTT → Loxone mappings' },
    { table: 'mapping_translations', label: 'Value translations (MQTT → Loxone)' },
    { table: 'mappings_loxone_to_mqtt', label: 'Loxone → MQTT mappings' },
    { table: 'loxone_mapping_translations', label: 'Value translations (Loxone → MQTT)' },
    { table: 'log_entries', where: "source = 'mqtt'", label: 'MQTT broker log' },
  ],
  monitor: [
    { table: 'monitors', label: 'Monitors', wipe: false },
    { table: 'monitor_history', label: 'Monitor history' },
  ],
  loxone_logs: [{ table: 'log_entries', where: "source = 'loxone'", label: 'Miniserver log lines' }],
  ai: [
    { table: 'ai_conversations', label: 'Conversations' },
    { table: 'ai_messages', label: 'Messages' },
    { table: 'ai_settings', label: 'Settings', wipe: false },
  ],
  energy: [
    { table: 'energy_meters', label: 'Meters' },
    { table: 'energy_samples', label: 'Per-minute samples' },
    { table: 'energy_hourly', label: 'Hourly values' },
    { table: 'energy_prices', label: 'Energy prices' },
    { table: 'solar_forecast', label: 'Solar forecast' },
  ],
  vehicles: [
    { table: 'vehicles', label: 'Vehicles' },
    { table: 'vehicle_readings', label: 'Vehicle readings' },
  ],
  charging: [
    { table: 'charging_sessions', label: 'Charging sessions' },
    { table: 'charge_log', label: 'Charge log' },
    { table: 'calendars', label: 'Calendars' },
    { table: 'calendar_events', label: 'Calendar events' },
    { table: 'event_overrides', label: 'Event choices' },
    { table: 'trips', label: 'Trips' },
    { table: 'geo_cache', label: 'Address lookups' },
    { table: 'wallbox_settings', label: 'Settings (planner, prices, ...)', wipe: false },
  ],
  ocpp: [
    { table: 'ocpp_bridges', label: 'OCPP bridges' },
    { table: 'ocpp_bridge_sessions', label: 'Reported sessions' },
    { table: 'ocpp_tariffs', label: 'Reimbursement tariffs' },
  ],
  energy_manager: [
    { table: 'energy_loads', label: 'Consumers' },
    { table: 'load_hourly', label: 'Hourly values per consumer' },
    { table: 'load_runs', label: 'Appliance runs' },
    { table: 'em_log', label: 'Shadow signal log' },
  ],
};

// Getting started: what still has to be done before the module does its job. done = true/false.
const CHECKLIST = {
  mqtt: async () => {
    const mqttClient = require('./mqttClient');
    return [
      { label: 'LoxSuite is connected to the broker', done: !!mqttClient.state?.connected, href: '/admin/settings' },
      { label: 'At least one MQTT user for your devices', done: true, href: '/mqtt-users', optional: true },
      { label: 'A first mapping (MQTT → Loxone or Loxone → MQTT)', done: await exists('SELECT COUNT(*) AS n FROM mappings_mqtt_to_loxone') || await exists('SELECT COUNT(*) AS n FROM mappings_loxone_to_mqtt'), href: '/mappings' },
    ];
  },
  monitor: async () => [
    { label: 'A first monitor', done: await exists('SELECT COUNT(*) AS n FROM monitors'), href: '/monitor' },
    { label: 'Values coming in (last 24 h)', done: await exists('SELECT COUNT(*) AS n FROM monitor_history WHERE recorded_at >= ?', since(86400000)), href: '/monitor' },
    { label: 'A dashboard of your own', done: await exists('SELECT COUNT(*) AS n FROM custom_dashboards'), href: '/', optional: true },
  ],
  loxone_logs: async () => [
    { label: 'A Miniserver added', done: await exists('SELECT COUNT(*) AS n FROM miniservers'), href: '/miniservers' },
    { label: 'Log lines read (last 24 h)', done: await exists("SELECT COUNT(*) AS n FROM log_entries WHERE source = 'loxone' AND recorded_at >= ?", since(86400000)), href: '/logs/loxone' },
  ],
  ai: async () => [
    { label: 'A provider and API key (or Ollama) set', done: await exists('SELECT COUNT(*) AS n FROM ai_settings WHERE enabled = 1'), href: '/admin/ai' },
    { label: 'Access for a role (Access Roles → AI Assistant)', done: true, href: '/admin/roles', optional: true },
  ],
  energy: async () => [
    { label: 'Grid meter linked', done: await exists("SELECT COUNT(*) AS n FROM energy_meters WHERE role = 'grid' AND enabled = 1"), href: '/energy' },
    { label: 'Solar meter linked', done: await exists("SELECT COUNT(*) AS n FROM energy_meters WHERE role = 'pv' AND enabled = 1"), href: '/energy', optional: true },
    { label: 'Wallbox meter linked', done: await exists("SELECT COUNT(*) AS n FROM energy_meters WHERE role = 'wallbox' AND enabled = 1"), href: '/energy' },
    { label: 'Hourly values recorded (last 24 h)', done: await exists('SELECT COUNT(*) AS n FROM energy_hourly WHERE hour >= ?', since(86400000)), href: '/energy' },
    { label: 'Energy prices for today', done: await exists('SELECT COUNT(*) AS n FROM energy_prices WHERE end_at >= ?', new Date().toISOString()), href: '/energy' },
    { label: 'Solar forecast', done: await exists('SELECT COUNT(*) AS n FROM solar_forecast WHERE hour >= ?', since(3600000)), href: '/energy', optional: true },
  ],
  vehicles: async () => [
    { label: 'A vehicle added', done: await exists('SELECT COUNT(*) AS n FROM vehicles'), href: '/vehicles' },
    { label: 'Live data from the car (last 6 h)', done: await exists('SELECT COUNT(*) AS n FROM vehicle_readings WHERE ts >= ?', since(6 * 3600000)), href: '/vehicles' },
    { label: 'Odometer readings for cost per km', done: await exists('SELECT COUNT(*) AS n FROM vehicle_readings WHERE odometer_km IS NOT NULL'), href: '/driving', optional: true },
  ],
  charging: async () => {
    const cfg = await setting('planner');
    return [
      { label: 'Smart charging settings saved', done: Object.keys(cfg).length > 0, href: '/planner' },
      { label: 'Virtual input for the power set (Wallbox Lm1)', done: !!cfg.vi_setpoint, href: '/planner' },
      { label: 'Output switched to Live', done: cfg.output === 'live', href: '/planner' },
      { label: 'A charging session recorded', done: await exists('SELECT COUNT(*) AS n FROM charging_sessions'), href: '/planner/log' },
      { label: 'A calendar for trips', done: await exists('SELECT COUNT(*) AS n FROM calendars'), href: '/agenda', optional: true },
    ];
  },
  ocpp: async () => [
    { label: 'An OCPP bridge for your Wallbox', done: await exists('SELECT COUNT(*) AS n FROM ocpp_bridges'), href: '/ocpp' },
    { label: 'Bridge reporting live', done: await exists("SELECT COUNT(*) AS n FROM ocpp_bridges WHERE enabled = 1 AND mode = 'live'"), href: '/ocpp' },
    { label: 'Reimbursement tariff set', done: await exists('SELECT COUNT(*) AS n FROM ocpp_tariffs'), href: '/ocpp', optional: true },
  ],
  energy_manager: async () => [
    { label: 'A consumer added', done: await exists('SELECT COUNT(*) AS n FROM energy_loads'), href: '/energy-manager' },
    { label: 'Its meter linked', done: await exists('SELECT COUNT(*) AS n FROM energy_loads WHERE meter_uuid IS NOT NULL'), href: '/energy-manager' },
    { label: 'Hourly values per consumer (last 24 h)', done: await exists('SELECT COUNT(*) AS n FROM load_hourly WHERE hour >= ?', since(86400000)), href: '/energy-manager' },
  ],
};

const tableSql = (d) => `FROM ${d.table}${d.where ? ` WHERE ${d.where}` : ''}`;

// Status: rows per table, and the checklist with how far along it is.
async function status(key) {
  const tables = [];
  for (const d of DATA[key] || []) tables.push({ table: d.table, label: d.label, rows: await count(`SELECT COUNT(*) AS n ${tableSql(d)}`), wipe: d.wipe !== false });
  let checklist = [];
  try { checklist = CHECKLIST[key] ? await CHECKLIST[key]() : []; } catch { checklist = []; }
  const required = checklist.filter((c) => !c.optional);
  return { tables, checklist, ready: required.every((c) => c.done), done: required.filter((c) => c.done).length, total: required.length };
}

function redact(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = SECRET.test(k) && v !== null && v !== '' ? '[removed]' : v;
  return out;
}
function csv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => { if (v === null || v === undefined) return ''; const s = String(v); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(';'), ...rows.map((r) => cols.map((c) => cell(r[c])).join(';'))].join('\r\n') + '\r\n';
}

// Zip: manifest.json + <table>.json + <table>.csv per table.
async function exportZip(key, { version = null } = {}) {
  const mod = require('./modules').MODULES.find((m) => m.key === key);
  if (!mod) throw new Error(`Unknown module "${key}".`);
  const zip = new AdmZip();
  const manifest = { module: key, label: mod.label, exportedAt: new Date().toISOString(), loxsuite: version, tables: [] };
  for (const d of DATA[key] || []) {
    let rows = [];
    try { rows = await db.prepare(`SELECT * ${tableSql(d)} LIMIT ${MAX_ROWS + 1}`).all(); } catch { rows = []; }
    const truncated = rows.length > MAX_ROWS;
    rows = rows.slice(0, MAX_ROWS).map(redact);
    manifest.tables.push({ table: d.table, label: d.label, rows: rows.length, truncated, filter: d.where || null });
    zip.addFile(`${d.table}.json`, Buffer.from(JSON.stringify(rows, null, 1)));
    zip.addFile(`${d.table}.csv`, Buffer.from(csv(rows)));
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  return zip.toBuffer();
}

// Deletes the module's data (children first). Refused while the module is on.
async function wipe(key) {
  const modules = require('./modules');
  if (!DATA[key]) throw new Error(`Unknown module "${key}".`);
  if (modules.isOn(key)) throw new Error('Switch the module off first.');
  const done = [];
  for (const d of [...DATA[key]].reverse()) {
    if (d.wipe === false) continue;
    const n = await count(`SELECT COUNT(*) AS n ${tableSql(d)}`);
    try { await db.prepare(`DELETE ${tableSql(d)}`).run(); done.push({ table: d.table, rows: n }); } catch (e) { done.push({ table: d.table, error: e.message }); }
  }
  return done;
}

module.exports = { DATA, CHECKLIST, status, exportZip, wipe, redact, csv };
