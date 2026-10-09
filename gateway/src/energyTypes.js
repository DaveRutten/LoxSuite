// Device types for the energy manager's modules (example, see docs/voorstel-energiemodules.md): per
// module kind a list of ROLES — what the module reads and what it may send — and per make/model a JSON
// file that says which register plays which role, how it scales and which can be written.
//
//   gateway/energy-types/<kind>/*.json            built in (Mitsubishi Ecodan, SolarEdge …)
//   device-templates/user/energy/<kind>/*.json     the user's own, same shape; the same key replaces one
//   customType(kind)                               "Own / other make": every role, no registers — the
//                                                  user links a Loxone state or virtual input per role
//
// LoxSuite never talks Modbus itself: it reads the Loxone states and sets virtual inputs that Loxone
// wires to the Modbus actuators. The registers in a type are there so the module knows what a value
// means (scale, enumeration, limits) and so the setup page can say which Loxone object to link.
const fs = require('fs');
const path = require('path');

const BUILT_IN = path.join(__dirname, '..', 'energy-types');
const USER = path.join(process.env.DEVICE_TEMPLATES_PATH || path.join(__dirname, '../device-templates'), 'user', 'energy');
const r2 = (x) => Math.round(x * 100) / 100;

// rw: 'r' read, 'w' write, 'rw' both. need: groups of roles; the module needs one of each group
// (for a role it writes: a writable register).
const ROLES = {
  heatpump: {
    prefix: 'WP',
    roles: {
      tankTemp: { label: 'Tap-water temperature', unit: '°C', rw: 'r' },
      valveDhw: { label: '3-way valve on tap water (1/0)', rw: 'r' },
      running: { label: 'Running (1/0)', rw: 'r' },
      compressorHz: { label: 'Compressor frequency', unit: 'Hz', rw: 'r' },
      defrost: { label: 'Defrost (2 = defrosting)', rw: 'r' },
      fault: { label: 'Fault (1/0)', rw: 'r' },
      errorCode: { label: 'Error code', rw: 'r' },
      outdoorTemp: { label: 'Outdoor temperature', unit: '°C', rw: 'r' },
      flowTemp: { label: 'Flow temperature', unit: '°C', rw: 'r' },
      returnTemp: { label: 'Return temperature', unit: '°C', rw: 'r' },
      flowRate: { label: 'Flow', unit: 'l/min', rw: 'r' },
      dhwFlowRate: { label: 'Flow in the tap-water circuit (own sensor)', unit: 'l/min', rw: 'r' },
      dhwFlowTemp: { label: 'Flow temperature of the tap-water circuit (own sensor)', unit: '°C', rw: 'r' },
      dhwReturnTemp: { label: 'Return temperature of the tap-water circuit (own sensor)', unit: '°C', rw: 'r' },
      pumpOn: { label: 'Circulation pump (1/0)', rw: 'r' },
      refrigerantTemp: { label: 'Refrigerant liquid temperature', unit: '°C', rw: 'r' },
      bufferFlowTemp: { label: 'Flow after the buffer tank', unit: '°C', rw: 'r' },
      bufferReturnTemp: { label: 'Return after the buffer tank', unit: '°C', rw: 'r' },
      operatingHours: { label: 'Operating hours', unit: 'h', rw: 'r' },
      heatingMode: { label: 'Operating mode', rw: 'rw', vi: 'Bedrijfsmodus' },
      dhwSetpoint: { label: 'Tap-water setpoint', unit: '°C', rw: 'rw', vi: 'Tapwater_Setpoint' },
      flowSetpoint: { label: 'Flow setpoint', unit: '°C', rw: 'rw', vi: 'Aanvoer_Setpoint' },
      flowSetpointZone2: { label: 'Flow setpoint zone 2', unit: '°C', rw: 'rw', vi: 'Aanvoer_Setpoint_Z2' },
      heatingBlock: { label: 'Block space heating (1/0)', rw: 'rw', vi: 'Blokkering' },
      systemOn: { label: 'System on (1/0)', rw: 'rw', vi: 'Aan' },
      forceDhw: { label: 'Heat tap water now (1/0)', rw: 'rw', vi: 'Tapwater_Nu' },
      dhwDrop: { label: 'Tap-water hysteresis (drop before it heats)', unit: '°C', rw: 'r' },
      dhwMode: { label: 'Tap-water mode (normal / eco)', rw: 'rw', vi: 'Tapwater_Modus' },
      roomSetpoint: { label: 'Room setpoint zone 1', unit: '°C', rw: 'rw', vi: 'Kamer_Setpoint' },
      roomTemp: { label: 'Room temperature zone 1', unit: '°C', rw: 'r' },
      roomTarget: { label: 'Room target temperature (Loxone room controller)', unit: '°C', rw: 'r' },
      roomHumidity: { label: 'Room humidity', unit: '%', rw: 'r' },
      boosterHeater: { label: 'Booster heater (1/0)', rw: 'r' },
      immersionHeater: { label: 'Immersion heater (1/0)', rw: 'r' },
      heatSource: { label: 'Heat source (0 = heat pump, else electric / boiler)', rw: 'r' },
      legionella: { label: 'Legionella prevention', rw: 'r' },
      electricPower: { label: 'Electric power', unit: 'kW', rw: 'r' },
      thermalPower: { label: 'Heat output', unit: 'kW', rw: 'r' },
      powerStep: { label: 'Power step (0 = full … 2 = calmest)', rw: 'r' },
      powerLimit1: { label: 'Power limit relay 1 (1/0)', rw: 'rw', vi: 'Vermogen_1' },
      powerLimit2: { label: 'Power limit relay 2 (1/0)', rw: 'rw', vi: 'Vermogen_2' },
      ntcMode: { label: 'Outdoor sensor (NTC): 0 = real, 1 = fixed value A, 2 = fixed value B', rw: 'r' },
      ntcRelay1: { label: 'NTC resistor relay 1 (1/0)', rw: 'rw', vi: 'Weerstand_1' },
      ntcRelay2: { label: 'NTC resistor relay 2 (1/0)', rw: 'rw', vi: 'Weerstand_2' },
      logicFlowC: { label: 'Flow setpoint of your own Loxone logic (fixed-flow mode)', unit: '°C', rw: 'r' },
      outdoorRh: { label: 'Outdoor humidity', unit: '%', rw: 'r' },
      dhwPipeTemp: { label: 'Hot-water pipe temperature (towards the taps)', unit: '°C', rw: 'r' },
      heatMeterPower: { label: 'Heat meter: power (e.g. Kamstrup in the heating pipe)', unit: 'kW', rw: 'r' },
      heatMeterEnergy: { label: 'Heat meter: energy', unit: 'kWh', rw: 'r' },
    },
    // the module needs each group: one of its roles (a writable one where it writes)
    need: [['tankTemp'], ['forceDhw', 'dhwSetpoint']],
  },
  solar: {
    prefix: 'PV',
    roles: {
      acPower: { label: 'Inverter AC power', unit: 'kW', rw: 'r' },
      limitActive: { label: 'Power control active (1/0)', rw: 'r' },
      powerLimitPct: { label: 'Active power limit', unit: '%', rw: 'rw', vi: 'Limiet' },
      powerControlEnable: { label: 'Enable power control (its own on-value, e.g. 4 for SolarEdge)', rw: 'rw', vi: 'Regeling' },
      reactivePowerConfig: { label: 'Reactive power config (its own on-value, e.g. 1)', rw: 'rw', vi: 'Reactief' },
      dcPower: { label: 'DC power (solar + battery)', unit: 'kW', rw: 'r' },
      gridPower: { label: 'Grid power at the meter', unit: 'kW', rw: 'r' },
      exportEnergy: { label: 'Exported energy', unit: 'kWh', rw: 'r' },
      importEnergy: { label: 'Imported energy', unit: 'kWh', rw: 'r' },
      status: { label: 'Inverter status', rw: 'r' },
      batterySoc: { label: 'Battery state of charge', unit: '%', rw: 'r' },
      batteryPower: { label: 'Battery power (+ charging)', unit: 'kW', rw: 'r' },
    },
    need: [['powerLimitPct']],
  },
};

function readDir(dir) {
  const out = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort() : []) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (t.key && Array.isArray(t.registers)) out.push({ ...t, file: f });
      else console.error(`[energy types] ${f}: needs a key and registers`);
    } catch (e) { console.error(`[energy types] ${f}: ${e.message}`); }
  }
  return out;
}

// The "own / other make" type: every role of the kind, linked by hand.
function customType(kind) {
  const def = ROLES[kind];
  if (!def) return null;
  return { key: 'custom', label: 'Own / other make', custom: true, values: 'loxone', registers: Object.entries(def.roles).map(([role, r]) => ({ key: role, role, label: r.label, rw: r.rw, unit: r.unit, scale: 1 })) };
}

// Built-in types, then the user's (same key replaces), then "own / other make".
function loadTypes(kind, { builtIn = BUILT_IN, user = USER } = {}) {
  const by = new Map();
  for (const t of readDir(path.join(builtIn, kind))) by.set(t.key, { ...t, origin: 'built-in' });
  for (const t of readDir(path.join(user, kind))) by.set(t.key, { ...t, origin: 'user' });
  return [...by.values(), customType(kind)].filter(Boolean);
}

const byRole = (type, role) => type.registers.find((r) => r.role === role) || null;
const viName = (kind, role) => `${ROLES[kind]?.prefix || kind}_${ROLES[kind]?.roles?.[role]?.vi || role}`;

// Pure: which roles a type misses that the module needs, and roles in it the module doesn't know.
const writable = (r) => /w/.test(r?.rw || '');
function check(kind, type) {
  const def = ROLES[kind] || { roles: {}, need: [] };
  const missing = (def.need || []).filter((group) => !group.some((role) => byRole(type, role))).map((group) => group.join(' / '));
  const notWritable = (def.need || []).filter((group) => group.some((role) => byRole(type, role)) && !group.some((role) => byRole(type, role) && (def.roles[role]?.rw === 'r' || writable(byRole(type, role))))).map((group) => group.join(' / '));
  const unknown = type.registers.filter((r) => r.role && !def.roles[r.role]).map((r) => r.role);
  return { ok: !missing.length && !notWritable.length, missing, unknown, notWritable };
}

// Pure: a temperature that looks ×100 (3250) or ×10 (325) of a sensible °C value, as °C (above 1000: ×100,
// above 100: ×10 — a heat pump's temperatures stay below 100 °C).
function plainC(v) { if (!Number.isFinite(v)) return v; const a = Math.abs(v); return a > 1000 ? r2(v / 100) : a > 100 ? r2(v / 10) : v; }
const kindOfType = (type) => (type?.kind || (type?.registers || []).some((x) => /^(tankTemp|dhwSetpoint|forceDhw)$/.test(x.role)) ? 'heatpump' : 'solar');

// Pure: raw values by register key -> { role: number } plus { role + 'Text': label } for enumerations.
function fromRaw(type, raw) {
  const out = {};
  for (const r of type.registers) {
    const v = Number(raw?.[r.key]);
    if (!r.role || raw?.[r.key] === undefined || raw?.[r.key] === null || !Number.isFinite(v)) continue;
    // values read through Loxone are already scaled by the Loxone template; a SunSpec raw value
    // still needs its scale factor (RAW × 10^SF, then W -> kW when the template says / 1000)
    const sfReg = r.sf ? type.registers.find((x) => x.key === r.sf) : null;
    const sf = sfReg ? Number(raw?.[sfReg.key]) : NaN;
    if (r.sf && !Number.isFinite(sf)) continue;
    const base = type.values === 'loxone' ? v : v / (r.scale || 1);
    out[r.role] = r.sf ? Math.round((base * 10 ** sf) / (r.div || 1) * 1000) / 1000 : r2(base);
    // a temperature that comes in ×100 or ×10 (own Loxone logic passing a Modbus value on): back to °C
    if (ROLES[kindOfType(type)]?.roles?.[r.role]?.unit === '°C') out[r.role] = plainC(out[r.role]);
    if (r.map) out[`${r.role}Text`] = r.map[String(v)] ?? String(v);
  }
  return out;
}

// Pure: wanted values [{ role, value, why }] -> what to send: clamped to the register's limits, only
// what changed (dead band), at most maxWritesPerHour (a Modbus gateway may write to the unit's memory).
function writes(kind, type, want, { now = {}, last = {}, nowMs = Date.now(), maxWritesPerHour = 6 } = {}) {
  const recent = Object.values(last).filter((w) => nowMs - w.ms < 3600000).length;
  let budget = Math.max(0, maxWritesPerHour - recent);
  const out = [];
  for (const w of want) {
    const r = byRole(type, w.role);
    if (!r || !writable(r)) continue;
    const value = Math.min(r.max ?? Infinity, Math.max(r.min ?? -Infinity, w.value));
    const current = last[w.role]?.value ?? now[w.role];
    const band = r.unit === '°C' ? 0.5 : r.unit === '%' ? 2 : 0.01;
    if (current !== undefined && Math.abs(current - value) < band) continue;
    if (budget <= 0) { out.push({ ...w, value, skipped: 'write limit per hour' }); continue; }
    budget--;
    // direct to the Loxone control (its uuidAction), or a virtual input — the user's choice per role
    // (link()); without a choice: direct when there is a control to send to
    const direct = r.via ? r.via === 'direct' && r.action : !!r.action;
    out.push({ ...w, value, reg: r.reg ?? null, raw: Math.round(value * (r.scale || 1)), ...(direct ? { action: r.action, ...(r.writeMs || r.ms ? { ms: r.writeMs || r.ms } : {}) } : { vi: r.vi || viName(kind, w.role) }) });
  }
  return out;
}

// Pure: the user's own links on top of a type (found in Loxone, built in or imported), per role:
//   read   { uuid, name }   a Loxone state of their choice (an object, a virtual output …)
//   write  { via: 'direct', action, name } | { via: 'vi', vi } | { via: 'off' }
// A role the type doesn't have is added; 'off' makes a role read-only (LoxSuite never sends it).
function link(kind, type, links = {}) {
  const def = ROLES[kind]?.roles || {};
  const regs = type.registers.map((r) => ({ ...r }));
  for (const [role, l] of Object.entries(links || {})) {
    if (!def[role]) continue;
    let r = regs.find((x) => x.role === role);
    if (!r) { r = { key: role, role, label: l.read?.name || l.write?.name || def[role].label, rw: 'r', added: true }; regs.push(r); }
    if (l.read?.uuid) { r.state = l.read.uuid; r.control = l.read.control || null; r.ms = l.read.ms ?? null; r.label = l.read.name || r.label; r.linked = true; }
    const w = l.write;
    if (w && /w/.test(def[role].rw)) {
      if (w.via === 'off') { r.via = 'off'; r.rw = r.rw.includes('r') || r.state ? 'r' : ''; }
      else if (w.via === 'vi') { r.via = 'vi'; r.vi = w.vi || viName(kind, role); r.rw = 'rw'; }
      else if (w.via === 'direct' && (w.action || r.action)) { r.via = 'direct'; r.action = w.action || r.action; if (w.ms) r.writeMs = w.ms; if (w.name) r.writeLabel = w.name; r.rw = 'rw'; }
    }
  }
  return { ...type, registers: regs.filter((r) => r.rw), linked: true };
}

module.exports = { plainC, ROLES, loadTypes, customType, byRole, viName, check, fromRaw, writes, link };
