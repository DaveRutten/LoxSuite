// Demo mode (LOXSUITE_DEMO=1, never in a normal install): a "Demo Miniserver" that exists only in
// memory, so the energy-manager modules can be tried and tested locally without a real Loxone.
//
//   patch()   before anything talks to a Miniserver: the demo Miniserver's structure file comes from
//             here, its live values from the simulation, and what LoxSuite sends to it (a virtual input
//             or a control's action) goes into the simulation instead of over the network
//   seed()    after the database is up: the demo Miniserver, the energy modules switched on, a site
//             for the solar forecast, and 14 days of simulated tank temperatures to learn from
//
// The simulation: a Mitsubishi Ecodan over the MelcoBEMS MINI (A1M) as the Loxone Library template
// shows it — tap water heated by its own logic (below setpoint − drop) or by Force DHW, the booster
// above 55 °C, showers at 07:00 and the dishes at 19:30, defrosting around freezing in damp air — and a SolarEdge inverter with the two
// power-control outputs a user adds in Loxone, following the limit LoxSuite sets.
const HOST = 'demo.loxsuite.invalid';
const NAME = 'Demo Miniserver';
const MIN = 60000;
const DAY = 86400000;
let demoId = null;
const log = (...a) => console.log('[demo]', ...a);
const isDemo = (ms) => ms && (ms.host === HOST || ms.id === demoId);

// ------------------------------------------------------------------ structure (LoxAPP3.json)

const controls = {};
const keyOfUuid = new Map(); // state or action uuid -> sim key
const keyOfControl = new Map(); // control uuid -> sim key
const roomControllers = new Map(); // room controller uuid -> its statistics outputs (sim keys)
const NO_STATS = new Set(['Booster Heater 1', 'Warmtepomp Weerstand', 'Display Error Code Digit 1', 'Modbus Counter']);
const history = new Map(); // sim key -> [{ ms, v }] every 5 minutes (the demo's "statistics")
let n = 0;
function add(prefix, name, key, { action = false, room = 'tech', cat = 'heat', type = 'InfoOnlyAnalog' } = {}) {
  n += 1;
  const uuid = `${prefix}-${String(n).padStart(4, '0')}-0001-ffffdemo`;
  const state = `${uuid}-v`;
  // most objects keep statistics in Loxone, not all (as in a real installation)
  const stats = !action && !NO_STATS.has(name);
  controls[uuid] = { name, type, room, cat, states: { value: state }, ...(action ? { uuidAction: `${uuid}-a` } : {}), ...(stats ? { statisticV2: { groups: [{ id: 1, dataPoints: [{ output: 'value' }] }] } } : {}) };
  keyOfUuid.set(state, key);
  keyOfControl.set(uuid, key);
  if (action) keyOfUuid.set(`${uuid}-a`, key);
}
function buildStructure() {
  const HP = '20aa0001';
  // the Library template's sensors (as the user has them in Loxone) ...
  [['Flow Temp', 'flowTemp'], ['Return Temp', 'returnTemp'], ['Tank Water Temp Actual', 'tank'], ['Tank Water Temp Target', 'setpoint'],
    ['Heat Pump On-Off', 'running'], ['Ecodan On-Off', 'systemOn'], ['Operating Mode DHW', 'dhwMode'], ['Heating Mode – Zone 1', 'heatingMode'],
    ['Water Pump 1', 'pump'], ['Flow Rate', 'flowRate'], ['DHW Temperature Drop', 'drop'], ['Booster Heater 1', 'booster'],
    ['Heat Source Phase DHW', 'heatSource'], ['Flow Temp Setpoint Zone 1', 'zoneTarget'], ['Legionella Prevention', 'legionella'], ['Consumed Power (actual)', 'elec'], ['Produced Power (actual)', 'heat'],
    ['Display Error Code Digit 1', 'err'], ['Force DHW', 'force'], ['Holiday', 'holiday'], ['DHW Prohibited', 'prohibit'],
    // ... and two the user added from the A1M register list
    ['3-Way Valve', 'valve'], ['Heat Pump Frequency', 'hz'], ['Outdoor Ambient Temperature', 'outdoor'], ['Defrost', 'defrost']].forEach(([name, key]) => add(HP, name, key));
  // the actuators that are visible in the app
  [['Set Tank Water Temperature', 'setpoint'], ['Force DHW', 'force'], ['Set Zone 1 Thermostat', 'zoneTarget'], ['Set DHW Mode', 'dhwMode']]
    .forEach(([name, key]) => add(HP, name, key, { action: true }));
  const PV = '30bb0001';
  [['I_DC_Power_RAW', 'dcRaw'], ['I_DC_Power_SF', 'sf0'], ['I_Status', 'pvStatus'], ['M_AC_Power_RAW', 'gridRaw'], ['M_AC_Power_SF', 'sf0b'],
    ['M_Exported_Energy_RAW', 'exportWh'], ['M_Imported_Energy_RAW', 'importWh'], ['M_Energy_SF', 'sf0c']].forEach(([name, key]) => add(PV, name, key, { room: 'meter', cat: 'energy' }));
  // the three power-control outputs a user adds in Loxone (0–100 %, enable 0/4, reactive 0/1)
  add(PV, 'Active Power Limit', 'limitPct', { action: true, room: 'meter', cat: 'energy' });
  add(PV, 'AdvancedPwrControlEn', 'advEn', { action: true, room: 'meter', cat: 'energy' });
  add(PV, 'ReactivePwrConfig', 'reactive', { action: true, room: 'meter', cat: 'energy' });
  // the user's own Loxone logic: outdoor sensors, and a sequential controller that steps the heat pump's
  // power down (two relays) and shows it a fixed outdoor temperature through its NTC (two relays)
  add('50ee0001', 'Buitentemperatuur', 'outdoor', { room: 'living', cat: 'heat' });
  add('51ee0001', 'Buitenluchtvochtigheid', 'rh', { room: 'living', cat: 'heat' });
  add('52ee0001', 'Warmtepomp Vermogen 1', 'q1', { room: 'tech', cat: 'heat', type: 'Switch', action: true });
  add('53ee0001', 'Warmtepomp Vermogen 2', 'q2', { room: 'tech', cat: 'heat', type: 'Switch', action: true });
  add('54ee0001', 'Warmtepomp Weerstand 1', 'q3', { room: 'tech', cat: 'heat', type: 'Switch', action: true });
  add('55ee0001', 'Warmtepomp Weerstand 2', 'q4', { room: 'tech', cat: 'heat', type: 'Switch', action: true });
  add('56ee0001', 'Warmtepomp Vermogen', 'step', { room: 'tech', cat: 'heat' });
  add('57ee0001', 'Warmtepomp Weerstand', 'ntc', { room: 'tech', cat: 'heat' });
  add('58ee0001', 'Warmtepomp Setpoint Ta', 'zoneTarget', { room: 'tech', cat: 'heat' });
  // a temperature sensor on the hot-water pipe towards the bathroom, and a Kamstrup heat meter in the heating pipe
  add('59ee0001', 'Leidingtemperatuur badkamer', 'pipe', { room: 'tech', cat: 'heat' });
  add('5aee0001', 'Kamstrup vermogen', 'kamKw', { room: 'tech', cat: 'heat' });
  add('5bee0001', 'Kamstrup energie', 'kamKwh', { room: 'tech', cat: 'heat' });
  // some ordinary controls around them
  add('40cc0001', 'Woonkamer plafond', 'light1', { room: 'living', cat: 'light', type: 'Switch', action: true });
  // Loxone's own room controllers (Intelligent room controller): Woonkamer and Keuken
  for (const [prefix, name, room] of [['60aa0001', 'Woonkamer', 'living'], ['60aa0002', 'Keuken', 'kitchen']]) {
    const uuid = `${prefix}-0001-0001-ffffdemo`;
    controls[uuid] = { name, type: 'IRoomControllerV2', room, cat: 'heat', states: { tempActual: `${uuid}-ta`, tempTarget: `${uuid}-tt`, comfortTemperature: `${uuid}-ct`, humidityActual: `${uuid}-hu` },
      statisticV2: { groups: [{ id: 1, dataPoints: [{ output: 'tempActual' }, { output: 'tempTarget' }] }] } };
    keyOfUuid.set(`${uuid}-ta`, 'roomTemp'); keyOfUuid.set(`${uuid}-tt`, 'ircTarget'); keyOfUuid.set(`${uuid}-ct`, 'comfortC'); keyOfUuid.set(`${uuid}-hu`, 'ircHum');
    roomControllers.set(uuid, ['roomTemp', 'ircTarget']);
  }
  return {
    msInfo: { serialNr: 'DEMO00000001', msName: NAME },
    rooms: { tech: { name: 'Technische ruimte' }, meter: { name: 'Meterkast' }, living: { name: 'Woonkamer' }, kitchen: { name: 'Keuken' } },
    cats: { heat: { name: 'Verwarming' }, energy: { name: 'Energie' }, light: { name: 'Verlichting' } },
    controls,
  };
}
let structure = null;

// ------------------------------------------------------------------ simulation

const sim = {
  tank: 50, setpoint: 50, drop: 5, force: 0, dhwActive: false, booster: 0, heatSource: 0, valve: 0, hz: 0, running: 1, systemOn: 1,
  dhwMode: 0, heatingMode: 1, pump: 1, flowRate: 0, flowTemp: 30, returnTemp: 28, elec: 0, heat: 0, legionella: 0, err: 0, holiday: 0, prohibit: 0,
  comfortC: 20.5, zoneTarget: 35, flowActual: 30, hpOn: false, ice: 0, defrostLeft: 0, override: 0, ircTarget: 19, ircHum: 55, roomTemp: 19.2, sf0: 0, sf0b: 0, sf0c: 0, dcRaw: 0, gridRaw: 0, exportWh: 1250000, importWh: 2890000, pvStatus: 2,
  limitPct: 100, advEn: 0, reactive: 0, light1: 0, outdoor: 3, rh: 90, defrost: 0, q1: 0, q2: 0, q3: 0, q4: 0, step: 0, ntc: 0, ta: 3, pipe: 20, kamKw: 0, kamKwh: 18250, at: null,
};
function localHourMin(ms) {
  const { localParts } = require('../localTime');
  const p = localParts(ms, 'Europe/Amsterdam'); // the demo's own clock (the display time zone is loaded later)
  return { h: p.hour, m: p.minute, doy: Math.floor((ms / DAY) % 365) };
}
// one step of dtMin minutes at time ms
function step(ms, dtMin, s = sim) {
  const { h, m } = localHourMin(ms);
  const t = h + m / 60;
  // a cold, damp autumn: around freezing at night, foggy mornings — an air source heat pump defrosts
  const day = Math.floor(ms / DAY);
  const outdoor = 2.5 + (day % 3) - 0.5 + 4 * Math.sin(((t - 9) / 24) * 2 * Math.PI);
  const rh = Math.round(Math.min(99, 88 - 12 * Math.sin(((t - 9) / 24) * 2 * Math.PI) + (day % 2) * 4));
  s.outdoor = Math.round(outdoor * 10) / 10; s.rh = rh;
  // the comfort schedule of the Loxone room controller (weekdays 06:30, weekend 08:00, until 22:30)
  const wd = new Date(ms + 2 * 3600000).getUTCDay(); const weekend = wd === 0 || wd === 6;
  s.ircTarget = t >= (weekend ? 8 : 6.5) && t < 22.5 ? 20.5 : 19;
  // ice on the outdoor coil grows while it runs in cold, damp air — faster the harder it pulls
  const iceRisk = Math.max(0, 1 - Math.abs(outdoor - 1) / 5) * Math.max(0, (rh - 75) / 25);
  // tap-water draws
  let draw = 0;
  if (h === 7 && m < 8) draw = 0.75;
  if (h === 19 && m >= 30 && m < 40) draw = 0.4;
  if (h === 12 && m >= 15 && m < 17) draw = 0.3;
  // the Ecodan's own tap-water logic, or Force DHW
  if (!s.dhwActive && (s.force === 1 || s.tank < s.setpoint - s.drop)) s.dhwActive = true;
  if (s.dhwActive && s.tank >= s.setpoint) { s.dhwActive = false; s.force = 0; }
  s.booster = 0; s.heatSource = 0;
  if (s.dhwActive) {
    s.valve = 1; s.hz = 52; s.flowTemp = Math.min(60, s.tank + 6); s.returnTemp = s.tank; s.flowRate = 16;
    if (s.tank >= 55) { s.booster = 1; s.heatSource = 2; s.hz = 0; s.elec = 2.0; s.heat = 2.0; s.tank += 0.12 * dtMin; } else { s.elec = 1.7; s.heat = 4.9; s.tank += 0.3 * dtMin; }
    s.defrost = 0;
  } else {
    s.valve = 0;
    // the own Loxone logic steps the power down when mild (Q1/Q2) and shows a fixed outdoor temperature in
    // damp cold (Q3/Q4) — unless LoxSuite has set the relays (then those hold for two hours)
    if (!(s.override > ms)) {
      s.step = outdoor > 8 ? 2 : outdoor > 4 ? 1 : 0; s.q1 = s.step >= 1 ? 1 : 0; s.q2 = s.step >= 2 ? 1 : 0;
      s.ntc = outdoor < 3 && rh > 88 ? 1 : 0; s.q3 = s.ntc === 1 ? 1 : 0; s.q4 = 0;
    } else { s.step = (s.q1 ? 1 : 0) + (s.q2 ? 1 : 0); s.ntc = s.q3 ? 1 : s.q4 ? 2 : 0; }
    s.ta = s.ntc ? 5 : s.outdoor;
    const pf = [1, 0.72, 0.52][s.step];
    const need = s.roomTemp < s.ircTarget + 0.3 && outdoor < 16;
    if (s.defrostLeft > 0) {
      // defrosting: the cycle reversed, power in, heat taken back from the water
      s.defrostLeft -= dtMin; s.defrost = 2; s.hz = 60; s.elec = 1.3; s.heat = -1.5;
    } else {
      s.defrost = 0;
      if (s.hpOn && (s.flowActual > s.zoneTarget + 2 || !need)) s.hpOn = false;
      else if (!s.hpOn && need && s.flowActual < s.zoneTarget - 3) s.hpOn = true;
      const elec = (0.7 + (16 - outdoor) * 0.07) * pf * (1 + (s.zoneTarget - 35) * 0.03);
      const cop = Math.max(1.6, (3.3 + (outdoor - 5) * 0.08 - (s.zoneTarget - 35) * 0.06) * (1 + 0.15 * (1 - pf)));
      if (s.hpOn) {
        s.elec = elec; s.heat = elec * cop; s.hz = Math.round((25 + (16 - outdoor) * 2) * pf);
        s.ice += iceRisk * pf * (elec / 1.5) * dtMin / 22;
        if (s.ice >= 1) { s.ice = 0; s.defrostLeft = 5; }
      } else { s.elec = 0.02; s.heat = 0; s.hz = 0; }
    }
    s.flowRate = s.hpOn || s.defrostLeft > 0 ? 14 : 0;
  }
  // the water in the heating circuit and the room
  const emit = Math.max(0, 0.28 * (s.flowActual - s.roomTemp));
  s.flowActual += ((s.valve ? 0 : s.heat) - emit) * (dtMin / 60) / 0.35;
  s.flowActual = Math.max(s.roomTemp, Math.min(60, s.flowActual));
  s.flowTemp = Math.round(s.flowActual * 10) / 10; s.returnTemp = Math.round((s.flowActual - (s.hpOn ? 5 : 1)) * 10) / 10;
  s.roomTemp = Math.round((s.roomTemp + (emit - 0.2 * (s.roomTemp - outdoor)) * (dtMin / 60) / 2.5) * 1000) / 1000;
  s.running = s.hz > 0 || s.booster ? 1 : 0;
  // the pipe to the bathroom: hot while water runs, cooling slowly after (a quick hand wash at 10:00 too)
  const hands = h === 10 && m === 0;
  s.pipe = draw > 0 || hands ? Math.round((s.tank - 2) * 10) / 10 : Math.max(19, Math.round((s.pipe - (s.pipe - 19) * 0.04 * dtMin) * 10) / 10);
  if (hands) s.tank -= 0.4 * dtMin;
  // the heat meter in the heating pipe: what really goes to the house
  s.kamKw = s.valve ? 0 : Math.round(Math.max(0, s.heat) * 0.97 * 100) / 100;
  s.ircHum = Math.round(52 + (s.rh - 85) * 0.3);
  s.kamKwh = Math.round((s.kamKwh + (s.kamKw * dtMin) / 60) * 1000) / 1000;
  s.tank -= (0.6 / 60) * dtMin + draw * dtMin;
  s.tank = Math.round(s.tank * 100) / 100;
  // solar: a clear autumn day, the limit when power control is on
  const sun = t > 7.5 && t < 18.5 ? Math.sin(Math.PI * (t - 7.5) / 11) : 0;
  const pvW = Math.round(5600 * Math.max(0, sun));
  const limitOn = s.advEn === 4 && s.reactive === 1;
  const maxW = limitOn ? 8000 * (s.limitPct / 100) : Infinity;
  s.dcRaw = Math.min(pvW, maxW);
  s.pvStatus = s.dcRaw > 0 ? (limitOn && pvW > maxW ? 5 : 4) : 2;
  const houseW = 450 + (h >= 17 && h < 22 ? 600 : 0) + s.elec * 1000;
  s.gridRaw = Math.round(houseW - s.dcRaw); // + import, − export
  if (s.gridRaw > 0) s.importWh += (s.gridRaw * dtMin) / 60; else s.exportWh += (-s.gridRaw * dtMin) / 60;
  s.at = ms;
}

// ------------------------------------------------------------------ patches

function patch() {
  const loxone = require('../loxone');
  const ws = require('../loxoneWebSocket');
  structure = buildStructure();
  const origFetch = loxone.fetchMiniserver;
  loxone.fetchMiniserver = async (ms, p, opts) => {
    if (!isDemo(ms)) return origFetch(ms, p, opts);
    const body = String(p).includes('LoxAPP3.json') ? structure : { LL: { control: p, value: '1', Code: '200' } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const origSend = loxone.sendHttpVirtualInput;
  loxone.sendHttpVirtualInput = async (ms, target, value) => {
    if (!isDemo(ms)) return origSend(ms, target, value);
    const key = keyOfUuid.get(target) || VI[String(target)] || null;
    if (key) sim[key] = value === 'pulse' ? 1 : Number(value);
    if (['q1', 'q2', 'q3', 'q4'].includes(key)) sim.override = Date.now() + 2 * 3600000;
    log(`received ${target} = ${value}${key ? ` (${key})` : ' (not wired in the demo)'}`);
    return { ok: true };
  };
  const origEnsure = ws.ensureConnection;
  ws.ensureConnection = (ms) => (isDemo(ms) ? { demo: true } : origEnsure(ms));
  const origValue = ws.getLiveValue;
  ws.getLiveValue = (msId, uuid) => {
    if (msId !== demoId) return origValue(msId, uuid);
    const key = keyOfUuid.get(uuid);
    return key === undefined ? undefined : sim[key];
  };
  const origStatus = ws.getStatus;
  ws.getStatus = (msId) => (msId === demoId ? { connected: true, demo: true } : origStatus(msId));
  // the real live connections, but not for the demo Miniserver (there is nothing to connect to)
  ws.startLiveConnections = async () => {
    const db = require('../db');
    const scan = async () => { for (const ms of await db.prepare('SELECT * FROM miniservers').all()) if (!isDemo(ms)) origEnsure(ms); };
    await scan();
    setInterval(() => scan().catch(() => {}), 60000);
  };
  // dynamic prices of a sunny autumn weekend instead of fetching them: cheap nights, an expensive evening
  // and a negative market price around noon (exporting then costs money, also with net metering)
  const prices = require('../prices');
  prices.startPrices = () => { seedPrices().catch((e) => log(`prices: ${e.message}`)); setInterval(() => seedPrices().catch(() => {}), 15 * MIN); };
  prices.stopPrices = () => {};
  // the AI-assistant connection: statistics of the demo objects that keep them
  const mcp = require('../mcpClient');
  const origCall = mcp.callTool;
  mcp.callTool = async (ms, name, input) => {
    if (!isDemo(ms)) return origCall(ms, name, input);
    if (name !== 'control_statistics') return { isError: true, content: [{ type: 'text', text: `demo: ${name} not simulated` }] };
    const ctl = structure.controls[input.uuid];
    if (roomControllers.has(input.uuid)) {
      const [ka, kt] = roomControllers.get(input.uuid);
      const from = Date.parse(input.from); const to = Date.parse(input.to);
      const a = (history.get(ka) || []).filter((p) => p.ms >= from && p.ms < to); const tt = new Map((history.get(kt) || []).map((p) => [p.ms, p.v]));
      const rows = a.map((p) => ({ ts: new Date(p.ms).toISOString(), values: [p.v, tt.get(p.ms) ?? null] }));
      return { content: [{ type: 'text', text: JSON.stringify({ header: [{ output: 'tempActual' }, { output: 'tempTarget' }], rows }) }] };
    }
    const key = keyOfControl.get(input.uuid);
    if (!ctl?.statisticV2 || !key) return { isError: true, content: [{ type: 'text', text: 'no statistics for this control' }] };
    const from = Date.parse(input.from); const to = Date.parse(input.to);
    const rows = (history.get(key) || []).filter((p) => p.ms >= from && p.ms < to).map((p) => ({ ts: new Date(p.ms).toISOString(), values: [p.v] }));
    return { content: [{ type: 'text', text: JSON.stringify({ header: [{ output: 'value' }], rows }) }] };
  };
  log('demo mode: the Demo Miniserver is simulated, nothing is sent to a real Miniserver for it');
}
// virtual inputs LoxSuite sets when the user chooses "virtual input" instead of direct
const VI = { WP_Vermogen_1: 'q1', WP_Vermogen_2: 'q2', WP_Weerstand_1: 'q3', WP_Weerstand_2: 'q4', WP_Tapwater_Setpoint: 'setpoint', WP_Tapwater_Nu: 'force', WP_Kamer_Setpoint: 'zoneTarget', WP_Tapwater_Modus: 'dhwMode', PV_Limiet: 'limitPct', PV_Regeling: 'advEn', PV_Reactief: 'reactive' };

// ------------------------------------------------------------------ seed

async function seedPrices() {
  const db = require('../db');
  const start = Math.floor(Date.now() / (60 * MIN)) * 60 * MIN - 6 * 60 * MIN;
  for (let i = 0; i < 54 * 4; i++) {
    const ms = start + i * 15 * MIN;
    const { h } = localHourMin(ms);
    const market = h >= 11 && h < 15 ? -0.06 - 0.08 * Math.sin(Math.PI * (h - 11) / 4) : h >= 17 && h < 21 ? 0.21 : h >= 1 && h < 6 ? 0.06 : 0.11;
    const allin = Math.round(((market + 0.02) * 1.21 + 0.10) * 10000) / 10000;
    await db.upsert('energy_prices', { start_at: new Date(ms).toISOString(), end_at: new Date(ms + 15 * MIN).toISOString(), market_eur_kwh: Math.round(market * 10000) / 10000, allin_eur_kwh: allin, source: 'demo', fetched_at: new Date().toISOString() }, ['start_at']);
  }
}

async function seed() {
  const db = require('../db');
  const { encrypt } = require('../secretCrypto');
  let row = await db.prepare('SELECT id FROM miniservers WHERE host = ?').get(HOST);
  if (!row) {
    await db.prepare('INSERT INTO miniservers (name, host, http_port, username, password, status, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(NAME, HOST, 80, 'demo', encrypt('demo'), 'online', 99);
    row = await db.prepare('SELECT id FROM miniservers WHERE host = ?').get(HOST);
    log(`created "${NAME}" (#${row.id})`);
  }
  demoId = row.id;
  // the demo lives in the Netherlands: local times on the page and in the plan
  await db.prepare("UPDATE gateway_settings SET display_timezone = 'Europe/Amsterdam' WHERE id = 1 AND (display_timezone IS NULL OR display_timezone = '' OR display_timezone = 'UTC')").run().catch(() => {});
  const modules = require('../modules');
  for (const k of ['energy', 'energy_manager']) await modules.setEnabled(k, true).catch((e) => log(`module ${k}: ${e.message}`));
  const settings = require('../wallboxSettings');
  // the demo's contract: net metering, dynamic prices, and feed-in costs as most suppliers charge them
  const planner = await settings.get('planner', null);
  if (!planner || planner.feed_in_cost_eur_kwh === undefined) await settings.set('planner', { ...(planner || {}), feed_in: 'saldering', feed_in_cost_eur_kwh: 0.115 });
  if (!(await settings.get('site', {})).lat) await settings.set('site', { lat: 52.09, lon: 5.12 });
  const solar = await settings.get('solar', {});
  if (!solar.kwp) await settings.set('solar', { ...solar, enabled: true, kwp: 6, tilt: 35, azimuth: 0 });
  for (const kind of ['heatpump', 'solar']) {
    const cur = await settings.get(`energy_module_${kind}`, null);
    if (!cur) await settings.set(`energy_module_${kind}`, kind === 'solar' ? { enabled: true, mode: 'live', inverter_kw: 8 } : { enabled: true, mode: 'live' });
  }
  // 14 days of tank temperatures (the Ecodan's own logic only) to learn the draws from, then live
  const now = Date.now();
  const hist = { ...sim };
  const samples = [];
  const weather = [];
  const room = []; const tune = [];
  for (let t = now - 14 * DAY; t < now; t += MIN) {
    const { h, m } = localHourMin(t);
    // the past: the own Loxone logic, now and then a different flow temperature (so there is something to compare)
    hist.zoneTarget = [35, 35, 33, 37][Math.floor(t / (6 * 3600000)) % 4];
    step(t, 1, hist);
    room.push({ ms: t, roomC: Math.round(hist.roomTemp * 100) / 100, outdoorC: hist.outdoor, heating: hist.hz > 0 && hist.valve === 0 && hist.defrost !== 2, targetC: hist.ircTarget });
    tune.push({ ms: t, running: hist.hpOn && hist.valve === 0, defrost: hist.defrost === 2, elecKw: hist.elec, heatKw: hist.heat, outdoorC: hist.outdoor, rh: hist.rh, flowC: hist.zoneTarget, step: hist.step, ntc: hist.ntc });
    samples.push({ ms: t, temp: Math.round(hist.tank * 10) / 10, heating: hist.valve === 1, pipe: hist.pipe });
    if (Math.floor(t / MIN) % 5 === 0) for (const k of new Set([...keyOfControl.values(), 'roomTemp', 'ircTarget'])) { if (Number.isFinite(hist[k])) { if (!history.has(k)) history.set(k, []); history.get(k).push({ ms: t, v: hist[k] }); } }
    weather.push({ ms: t, outdoorC: hist.outdoor, rh: hist.rh, defrost: hist.defrost === 2, elecKw: hist.elec, heatKw: hist.heat, step: hist.step, ntc: hist.ntc });
  }
  Object.assign(sim, hist);
  require('../energyModules').addTankHistory(samples);
  require('../energyModules').addWeatherHistory(weather);
  require('../energyModules').addRoomHistory(room);
  require('../energyModules').addTuneHistory(tune);
  setInterval(() => step(Date.now(), 1 / 6), 10000);
  // Dutch as the default language of the demo (once the languages are loaded, right after this)
  setTimeout(() => require('../i18n').setDefaultLanguage('nl').catch((e) => log(`language: ${e.message}`)), 5000);
  log(`seeded 14 days of tank temperatures (${samples.length} samples); simulating live`);
}

module.exports = { patch, seed, HOST, sim, step, buildStructure };
