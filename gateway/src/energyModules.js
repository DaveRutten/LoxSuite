// Energy manager > Modules: the heat pump and the solar inverter as modules next to the consumers
// (energyManager.js) and the car (Smart charging). See docs/voorstel-energiemodules.md.
//
// Per module (wallbox_settings key energy_module_<kind>):
//   miniserver_id, device   the device found in the Loxone structure (energyDiscovery.js), like a Home
//                           Connect appliance; type_key: a known / imported type when nothing is found
//   links                   the user's choice per role: read from an own object / virtual output, send
//                           direct, through a virtual input, or not at all (energyTypes.link)
//   mode                    'shadow' (shows what it would send) or 'live' (sends it)
//   heat pump: limits (legionella.dhwLimits), legionella { ... }
//   solar: inverter_kw, step_pct (what exporting yields comes from the contract: Smart charging settings)
//
// Every minute: the linked values are read from Loxone, the tank temperature is kept (tap-water draws
// are recognised from it, tankDraws.js), and the hour's plan is turned into writes — logged in shadow
// mode, sent in live mode.
const et = require('./energyTypes');
const ed = require('./energyDiscovery');
const hp = require('./heatPumpTypes');
const td = require('./tankDraws');
const lg = require('./legionella');
const sl = require('./solarLimit');
const ep = require('./energyPatterns');
const hw = require('./heatPumpWeather');
const rwu = require('./roomWarmup');
const tu = require('./heatPumpTuning');
const settings = require('./wallboxSettings');
const db = require('./db');

const HOUR = 3600000;
const DAY = 86400000;
const KEEP_MS = 21 * DAY;
const KINDS = ['heatpump', 'solar'];

const DEFAULTS = {
  heatpump: {
    enabled: false, mode: 'shadow', miniserver_id: null, device: null, type_key: null, links: {}, source: 'air', heat_meter_flow_unit: 'l/h',
    room: { enabled: true, controller: null, schedule: 'loxone', comfort_c: 20.5, setback_c: 19, comfort_from: '07:00', comfort_until: '22:30' },
    // bijsturen for long, calm runs: 'off' | 'advise' (shows it) | 'live' (sends it, with the module live)
    tuning: { mode: 'advise', flow_min: 25, flow_max: 45 },
    // the user's own names for the power steps and the outdoor-sensor (NTC) settings of their Loxone logic
    step_names: { 0: '100%', 1: '75%', 2: '50%' }, ntc_names: { 0: 'Echte buitentemperatuur', 1: 'Vaste waarde 1', 2: 'Vaste waarde 2' },
    limits: { ...lg.DEFAULT_LIMITS }, heat_c_per_h: 10, loss_c_per_h: 0.6, hold_h: 2,
    legionella: { enabled: true, interval_days: 7, temp_c: 60, hold_min: 30, from_hour: 10, to_hour: 17, duration_h: 2, unit_backup: true },
  },
  solar: { enabled: false, mode: 'shadow', miniserver_id: null, device: null, type_key: null, links: {}, grid_invert: false, inverter_kw: 8, step_pct: 5, margin_kw: 0.2 },
};

const rt = { conflicts: { heatpump: {}, solar: {} }, tank: [], weather: [], room: [], tune: [], last: { heatpump: {}, solar: {} }, sent: { heatpump: [], solar: [] }, timer: null, discovered: new Map() };

async function getConfig(kind) {
  const d = DEFAULTS[kind];
  const c = await settings.get(`energy_module_${kind}`, d);
  return { ...d, ...c, ...(kind === 'heatpump' ? { limits: { ...d.limits, ...(c.limits || {}) }, legionella: { ...d.legionella, ...(c.legionella || {}) }, room: { ...d.room, ...(c.room || {}) }, tuning: { ...d.tuning, ...(c.tuning || {}) }, step_names: { ...d.step_names, ...(c.step_names || {}) }, ntc_names: { ...d.ntc_names, ...(c.ntc_names || {}) } } : {}), links: c.links || {} };
}
async function saveConfig(kind, c) { return settings.set(`energy_module_${kind}`, { ...(await getConfig(kind)), ...c }); }

const miniservers = () => db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all().catch(() => []);

// Candidates on every Miniserver, best first. Kept a minute: the structure rarely changes.
async function discover(kind, { refresh = false } = {}) {
  const hit = rt.discovered.get(kind);
  if (hit && !refresh && Date.now() - hit.at < 60000) return hit.list;
  // Gateway first: in a Gateway/Client setup the same objects can come in through both
  const all = (await miniservers()).sort((x, y) => Number(!!x.gateway_client_of) - Number(!!y.gateway_client_of));
  const structures = [];
  const list = [];
  for (const ms of all) {
    try { structures.push({ ms, s: await require('./loxoneStructure').getStructure(ms, { forceRefresh: refresh }) }); } catch (e) { list.push({ error: e.message, miniserver: { id: ms.id, name: ms.name } }); }
  }
  const seen = new Set();
  for (const { ms, s } of structures) {
    for (const c of ed.fromStructure(kind, s)) {
      const sig = (c.parts || [c.uuid]).join(',');
      if (seen.has(sig)) continue; // already found on the Gateway
      seen.add(sig);
      // roles of the own Loxone logic that live on another Miniserver (Gateway / Client)
      for (const o of structures) {
        if (o.ms.id === ms.id) continue;
        const wanted = (ed.ELSEWHERE[kind] || []).filter((r) => !c.roles[r]);
        if (!wanted.length) break;
        const extra = ed.rolesOf(kind, ed.allObjects(o.s));
        for (const r of wanted) {
          if (!extra[r]) continue;
          const e = extra[r];
          c.roles[r] = { ...(e.read ? { read: { ...e.read, ms: o.ms.id } } : {}), ...(e.write ? { write: { ...e.write, ms: o.ms.id } } : {}), elsewhere: true };
        }
        if (c.roles.heatMeterFlowTemp?.read?.ms === o.ms.id) for (const [k, x] of Object.entries(ed.heatMeterSiblings(ed.allObjects(o.s), c.roles.heatMeterFlowTemp.read.control))) if (!c.roles[k]) c.roles[k] = { read: { ...x.read, ms: o.ms.id }, elsewhere: true };
      }
      // the roles found elsewhere become part of its type (with their own Miniserver)
      c.type = ed.asType(kind, { uuid: c.uuid, name: c.name, members: [] }, c.roles, et.loadTypes(kind).find((t) => t.key === c.known?.key));
      for (const reg of c.type.registers) { const rr = c.roles[reg.role]; if (rr?.read?.ms) reg.ms = rr.read.ms; if (rr?.write?.ms) reg.writeMs = rr.write.ms; }
      c.score = Object.keys(c.roles).length;
      c.check = et.check(kind, c.type);
      list.push({ ...c, miniserver: { id: ms.id, name: ms.name } });
    }
  }
  rt.discovered.set(kind, { at: Date.now(), list, structures: structures.map((x) => ({ id: x.ms.id, name: x.ms.name, controls: Object.keys(x.s?.controls || {}).length })) });
  return list;
}

// The type the module works with: the chosen device as found in Loxone (else the first candidate, else
// a known type), with the user's links on top.
async function resolve(kind, cfg = null) {
  cfg = cfg || await getConfig(kind);
  const found = (await discover(kind)).filter((c) => !c.error);
  const chosen = (cfg.device && found.find((c) => c.uuid === cfg.device && c.miniserver.id === cfg.miniserver_id)) || (!cfg.device ? found[0] : null) || null;
  let base = chosen?.type || null;
  if (!base) {
    const types = et.loadTypes(kind);
    base = types.find((t) => t.key === cfg.type_key) || types.find((t) => t.key === 'custom');
  }
  const msId = chosen?.miniserver.id ?? cfg.miniserver_id ?? (await miniservers())[0]?.id ?? null;
  // the room from Loxone's own room controller: actual, target and humidity
  let links = cfg.links;
  let roomController = null;
  if (kind === 'heatpump' && cfg.room?.controller) {
    // "msId|uuid" (older settings: the uuid alone)
    const [a, b] = String(cfg.room.controller).split('|');
    const wantUuid = b || a;
    roomController = (await roomControllerList()).find((x) => x.uuid === wantUuid) || null;
    if (roomController) {
      const one = (state, name) => (state ? { read: { uuid: state, name, control: roomController.uuid, ms: roomController.ms } } : null);
      links = { ...links, ...Object.fromEntries([['roomTemp', one(roomController.tempActual, roomController.name)], ['roomTarget', one(roomController.tempTarget, roomController.name)], ['roomHumidity', one(roomController.humidity, roomController.name)]].filter(([, v]) => v)) };
    }
  }
  const type = et.link(kind, base, links);
  return { cfg, chosen, found, type, msId, roomController, check: et.check(kind, type) };
}

// The linked values right now, by register key (what fromRaw expects).
function readRaw(type, msId) {
  const ws = require('./loxoneWebSocket');
  const raw = {};
  for (const r of type.registers) {
    if (!r.state) continue;
    const v = ws.getLiveValue(r.ms ?? msId, r.state);
    if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) raw[r.key] = Number(v);
  }
  return raw;
}

// Prices and solar per hour for the coming day(s), as the energy manager plans with them.
async function hoursAhead(nowMs, hours = 36) {
  try {
    const slots = await require('./planner').buildSlots(nowMs, nowMs + hours * HOUR);
    const em = require('./energyManager');
    const h = em.toHours(slots);
    if (h.length) return h;
  } catch { /* no prices / forecast yet */ }
  const start = Math.floor(nowMs / HOUR) * HOUR;
  return Array.from({ length: hours }, (_, i) => ({ ms: start + i * HOUR, hour: new Date(start + i * HOUR).toISOString(), price: 0.25, surplusKwh: 0, estimated: true }));
}

// Outdoor temperature and humidity per hour (the solar forecast's Open-Meteo call): Map hourMs -> { t, rh }.
async function weatherAhead(fromMs, toMs) {
  const rows = await db.prepare('SELECT hour, temp_c, rh_pct FROM solar_forecast WHERE hour >= ? AND hour < ?').all(new Date(fromMs - HOUR).toISOString(), new Date(toMs).toISOString()).catch(() => []);
  return new Map(rows.map((r) => [Date.parse(r.hour), { t: r.temp_c ?? null, rh: r.rh_pct ?? null }]));
}

// The room's plan: when comfort is wanted next, when pre-heating has to start for it (learned warm-up
// rate at the forecast outdoor temperature), and the room setpoint for right now.
function roomPlan({ R, nowMs, roomC, rmodel, outdoorAt, localOf, sched = null }) {
  const { localTimeOn } = require('./localTime');
  // the schedule learned from Loxone's room controller (per weekday), else the own times
  const useLox = R.schedule === 'loxone' && sched && !sched.flat && sched.all;
  const dayOf = (ms) => (useLox ? sched.days[localOf(ms).weekday] || sched.all : null);
  const comfortC = useLox ? sched.comfortC : Number(R.comfort_c) || 20.5;
  const setbackC = useLox ? sched.setbackC : Number(R.setback_c) || 19;
  const fromOf = (ms) => (useLox ? dayOf(ms).from : R.comfort_from) || '07:00';
  const untilOf = (ms) => (useLox ? dayOf(ms).until : R.comfort_until) || '22:30';
  let comfortAt = localTimeOn(nowMs, fromOf(nowMs));
  let untilAt = localTimeOn(nowMs, untilOf(nowMs));
  if (untilAt <= comfortAt) untilAt += DAY;
  const inComfort = nowMs >= comfortAt && nowMs < untilAt;
  if (nowMs >= comfortAt) { comfortAt = localTimeOn(nowMs + DAY, fromOf(nowMs + DAY)); untilAt = localTimeOn(nowMs + DAY, untilOf(nowMs + DAY)); if (untilAt <= comfortAt) untilAt += DAY; }
  // the room by the time pre-heating could start: cooling towards the setback temperature
  const fromC = Number.isFinite(roomC) ? Math.max(setbackC, Math.min(roomC, comfortC) - 0.3) : setbackC;
  const pre = rwu.preheat(rmodel, { atMs: comfortAt, nowMs, fromC, comfortC, outdoorAt });
  const preheating = !inComfort && nowMs >= pre.startMs && nowMs < comfortAt;
  const rate = rwu.rate(rmodel, outdoorAt(comfortAt - HOUR));
  return {
    comfortC, setbackC, comfortAt, untilAt, inComfort, preheating, preheat: pre.hours > 0 ? pre : null, rate, fromLoxone: !!useLox,
    setpointNow: inComfort || preheating ? comfortC : setbackC,
    why: inComfort ? 'comfort' : preheating ? `pre-heating for ${comfortC} °C at ${String(localOf(comfortAt).hour).padStart(2, '0')}:${String(localOf(comfortAt).minute).padStart(2, '0')}` : 'set back',
  };
}

function localTools() {
  const { localParts, displayTz } = require('./localTime');
  const tz = displayTz();
  const localOf = (ms) => { const p = localParts(ms, tz); return { day: `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`, hour: p.hour, minute: p.minute, weekday: p.weekday }; };
  const clock = (ms) => { const l = localOf(ms); return `${String(l.hour).padStart(2, '0')}:${String(l.minute).padStart(2, '0')}`; };
  return { localOf, clock, localHour: (ms) => localOf(ms).hour };
}

// The heat pump: what it is doing, the learned draws, the tank plan, legionella and the writes now.
async function heatpumpStatus(nowMs = Date.now()) {
  const r = await resolve('heatpump');
  const { cfg, type, msId } = r;
  const v = msId ? et.fromRaw(type, readRaw(type, msId)) : {};
  const state = hp.interpret(v, { meterFlowUnit: cfg.heat_meter_flow_unit || 'l/h' });
  const { localOf, clock, localHour } = localTools();
  const { limits, warnings } = lg.dhwLimits({ ...cfg.limits, hpMaxC: cfg.limits.hpMaxC });
  // draws learned from the kept tank temperature
  const samples = rt.tank.filter((s) => s.ms > nowMs - KEEP_MS);
  const th = td.learnThreshold(td.dropRates(samples));
  // with a sensor on the hot-water pipe: its jumps are the draws (exact, small ones too); else the tank
  const withPipe = samples.filter((x) => Number.isFinite(x.pipe)).length > 60;
  const draws = withPipe ? td.pipeDraws(samples) : td.detectDraws(samples, { thresholdCph: th.cph });
  const prof = samples.length ? td.drawProfile(draws, { localOf, nowMs, firstMs: samples[0].ms }) : null;
  const patterns = prof ? ep.hourPatterns(prof, { minDays: 3 }).filter((p) => p.type === 'daily') : [];
  const dropOf = (ms) => (prof ? ep.expectedKwh(prof, ms, localOf) : 0);
  const hours = await hoursAhead(nowMs);
  const tankC = state.tankC ?? limits.targetC;
  // the weather: what a kWh of heat costs per hour (price ÷ the COP expected in that weather, defrosting
  // included) — learned per outdoor temperature and humidity, from the start curve until then
  const source = hw.SOURCES.includes(cfg.source) ? cfg.source : 'air';
  const wmodel = hw.learn(rt.weather.filter((x) => x.ms > nowMs - 60 * DAY));
  const wx = await weatherAhead(hours[0]?.ms ?? nowMs, (hours[hours.length - 1]?.ms ?? nowMs) + HOUR);
  const expAt = (h) => { const w = wx.get(h.ms) || {}; return { ...hw.expect(wmodel, { source, outdoorC: w.t ?? (h.ms <= nowMs ? state.outdoorC : null), rh: w.rh, flowC: 55 }), outdoorC: w.t ?? null, rh: w.rh ?? null }; };
  const exps = new Map(hours.map((h) => [h.ms, expAt(h)]));
  const costOf = (h) => ((h.surplusKwh || 0) >= 1.6 ? 0 : hw.costPerHeat(h.price ?? 0.25, exps.get(h.ms)));
  // the room: comfort from a time, set back at night; how long it takes to warm up is learned per
  // outdoor temperature, so pre-heating starts earlier on a cold morning — and tap water goes right
  // before or after that block, never in between
  const R = cfg.room || {};
  const rmodel = rwu.learn(rt.room.filter((x) => x.ms > nowMs - 30 * DAY));
  const sched = rwu.learnSchedule(rt.room.filter((x) => x.ms > nowMs - 28 * DAY && Number.isFinite(x.targetC)), localOf);
  const room = R.enabled ? roomPlan({ R, nowMs, roomC: state.roomC, rmodel, outdoorAt: (ms) => wx.get(Math.floor(ms / HOUR) * HOUR)?.t ?? state.outdoorC ?? null, localOf, sched }) : null;
  // bijsturen: per weather the setting (flow, power step, NTC) with the longest, calmest runs
  const T = cfg.tuning || {};
  const onFlow = v.heatingMode === 1;
  const current = { flowC: Number.isFinite(v.logicFlowC) ? v.logicFlowC : onFlow ? (v.flowSetpoint ?? v.roomSetpoint ?? null) : (v.flowSetpoint ?? null), step: Number.isFinite(v.powerStep) ? v.powerStep : hw.stepOf(v.powerLimit1 === 1, v.powerLimit2 === 1), ntc: Number.isFinite(v.ntcMode) ? v.ntcMode : hw.stepOf(v.ntcRelay1 === 1, v.ntcRelay2 === 1) };
  const truns = tu.runs(rt.tune.filter((x) => x.ms > nowMs - 60 * DAY));
  const tmodel = tu.learn(truns);
  const overshoot = tu.overshoot(truns.filter((x) => x.startMs > nowMs - 7 * DAY));
  const wNow = wx.get(Math.floor(nowMs / HOUR) * HOUR) || {};
  const outNow = Number.isFinite(state.outdoorC) ? state.outdoorC : wNow.t;
  const rhNow = Number.isFinite(v.outdoorRh) ? v.outdoorRh : wNow.rh;
  const roomBehindC = Number.isFinite(v.roomTarget) && Number.isFinite(state.roomC) ? Math.max(0, v.roomTarget - state.roomC) : 0;
  const advice = T.mode === 'off' || !Number.isFinite(outNow) ? null : tu.choose(tmodel, { outdoorC: outNow, rh: rhNow, current, roomBehindC, bounds: { flowMin: Number(T.flow_min) || 25, flowMax: Number(T.flow_max) || 45 } });
  const heatingHours = new Set();
  if (room?.preheat) for (let t = Math.floor(room.preheat.startMs / HOUR) * HOUR; t < room.comfortAt; t += HOUR) heatingHours.add(t);
  const plan = td.planTank({ hours, tankC, dropOf, lossCph: Number(cfg.loss_c_per_h) || 0.6, heatCph: Number(cfg.heat_c_per_h) || 10, minC: limits.comfortMinC, maxC: limits.planMaxC, holdH: Number(cfg.hold_h) || 2, clock, costOf, heatingHours });
  // legionella: when it was last held hot enough (whoever did it) and the best block before it is due
  const L = cfg.legionella;
  const lastDoneMs = lg.lastDone(samples, { targetC: Number(L.temp_c) || 60, holdMin: Number(L.hold_min) || 30 }) ?? (cfg.legionella_last_ms || null);
  const leg = L.enabled ? lg.planLegionella({ hours, nowMs, lastDoneMs, intervalDays: Number(L.interval_days) || 7, fromHour: Number(L.from_hour), toHour: Number(L.to_hour), durationH: Number(L.duration_h) || 2, localHour }) : null;
  const legNow = leg?.block && nowMs >= leg.block.startMs && nowMs < leg.block.endMs;
  const hourPlan = plan.hours.find((h) => h.ms === Math.floor(nowMs / HOUR) * HOUR) || plan.hours[0] || { mode: 'free' };
  const mode = legNow ? 'legionella' : hourPlan.mode;
  const tuneLive = T.mode === 'live' && advice && tu.keyOf(advice.setting) !== tu.keyOf(current);
  const tunePlan = tuneLive ? { ...(Number.isFinite(advice.setting.flowC) ? { flowC: advice.setting.flowC, flowWhy: advice.why } : {}), step: advice.setting.step, ntc: advice.setting.ntc, tuneWhy: advice.why } : {};
  const writes = hp.writesFor({ type, plan: { mode, ...(room ? { roomC: room.setpointNow, roomWhy: room.why } : {}), ...tunePlan }, now: v, last: rt.last.heatpump, nowMs, settings: { ...type.defaults, ...limits, legionellaC: Number(L.temp_c) || 60 } });
  return {
    kind: 'heatpump', cfg, check: r.check, found: summary(r.found), chosen: r.chosen ? summaryOne(r.chosen) : null, msId,
    roles: rolesView('heatpump', type, r.chosen), values: v, state, limits, warnings,
    learned: { threshold: th, fromPipe: withPipe, draws: draws.slice(-20), patterns, samples: samples.length, days: prof?.days || 0 },
    plan: plan.hours.map((h, i) => { const e = exps.get(h.ms) || {}; return { ...h, price: hours[i]?.price ?? null, surplusKwh: hours[i]?.surplusKwh ?? 0, estimated: !!hours[i]?.estimated, drop: Math.round(dropOf(h.ms) * 10) / 10, cop: e.cop ?? null, defrost: e.defrost ?? null, outdoorC: e.outdoorC, rh: e.rh, heatCost: hw.costPerHeat(hours[i]?.price ?? null, e) }; }),
    weather: { source, model: wmodel, now: exps.get(Math.floor(nowMs / HOUR) * HOUR) || null, steps: hw.learnSteps(rt.weather.filter((x) => x.ms > nowMs - 60 * DAY)) },
    room: room ? { ...room, model: rmodel, schedule: sched, controller: r.roomController ? { uuid: r.roomController.uuid, name: r.roomController.name, room: r.roomController.room } : null } : null,
    controllers: (await roomControllerList()).map((x) => ({ value: x.value, uuid: x.uuid, name: x.name, room: x.room, msName: x.msName })),
    tuning: { overshoot, mode: T.mode, current, advice, model: Object.values(tmodel).filter((x) => advice && x.weather === advice.weather).map((x) => ({ ...x, score: tu.score(x) })).sort((a, b) => a.score - b.score), runs: rt.tune.length },
    legionella: leg ? { ...leg, lastDoneMs, now: legNow } : null, mode, reason: legNow ? leg.reason : hourPlan.reason, writes, sent: rt.sent.heatpump.slice(-15),
  };
}

// The inverter: what exporting yields now, the limit, the writes.
async function solarStatus(nowMs = Date.now()) {
  const r = await resolve('solar');
  const { cfg, type, msId } = r;
  const raw = msId ? readRaw(type, msId) : {};
  const v = et.fromRaw(type, raw);
  // the grid meter counts import as positive; some meters the other way round (a switch per install)
  if (cfg.grid_invert && Number.isFinite(v.gridPower)) v.gridPower = -v.gridPower;
  // what exporting yields comes from the contract (Smart charging settings): net metering, the market
  // price of a dynamic contract or a fixed feed-in tariff, minus the supplier's feed-in costs
  const hours = await hoursAhead(nowMs, 24);
  const pcfg = await require('./planner').getConfig().catch(() => ({}));
  const priceCfg = await require('./prices').getConfig().catch(() => ({}));
  const sv = require('./solarValue');
  const netAt = (h) => sv.exportNet({ atMs: h.ms, price: h.price ?? null, market: h.market ?? null, feedIn: pcfg.feed_in, feedInEur: pcfg.feed_in_eur_kwh, feedInCostEur: pcfg.feed_in_cost_eur_kwh, priceCfg });
  const now0 = netAt(hours[0] || { ms: nowMs });
  const worth = now0.worth;
  const value = now0.value;
  const contract = { rule: now0.rule, feedInEur: pcfg.feed_in_eur_kwh ?? null, costEur: now0.cost, dynamic: priceCfg.source !== 'fixed', priceSource: priceCfg.source || null, estimated: !!hours[0]?.estimated };
  // the hours ahead: where limiting is expected (exporting costs money and there is sun to export)
  const ahead = hours.map((h) => { const n = netAt(h); return { ms: h.ms, value: n.value, surplusKwh: h.surplusKwh || 0, limit: n.value !== null && n.value < 0 && (h.surplusKwh || 0) > 0.2 }; });
  const pvKw = v.acPower ?? v.dcPower ?? null;
  const houseKw = pvKw !== null && v.gridPower !== undefined ? Math.max(0, pvKw + v.gridPower) : null;
  const limit = sl.limitPct({ value, houseKw, inverterKw: Number(cfg.inverter_kw) || 8, stepPct: Number(cfg.step_pct) || 5, marginKw: Number(cfg.margin_kw) || 0.2 });
  const writes = sl.writesFor({ type, value, houseKw, now: v, last: rt.last.solar, nowMs, settings: { inverterKw: Number(cfg.inverter_kw) || 8, stepPct: Number(cfg.step_pct) || 5, marginKw: Number(cfg.margin_kw) || 0.2 } });
  return { kind: 'solar', cfg, check: r.check, found: summary(r.found), chosen: r.chosen ? summaryOne(r.chosen) : null, msId, roles: rolesView('solar', type, r.chosen), values: v, worth, value, contract, ahead, pvKw, houseKw, limit, writes, sent: rt.sent.solar.slice(-15) };
}

const summaryOne = (c) => ({ uuid: c.uuid, name: c.name, room: c.room, score: c.score, ok: c.check.ok, known: c.known, miniserver: c.miniserver, missingFromLoxone: c.missingFromLoxone });
const summary = (list) => list.map((c) => (c.error ? c : summaryOne(c)));

// Per role of the kind: where it is read, how it is sent, as the page shows it.
function rolesView(kind, type, chosen) {
  const def = et.ROLES[kind].roles;
  const need = new Set((et.ROLES[kind].need || []).flat());
  return Object.entries(def).map(([role, d]) => {
    const r = et.byRole(type, role);
    const known = chosen?.missingFromLoxone?.find((m) => m.role === role) || null;
    return {
      role, label: d.label, unit: d.unit || null, need: need.has(role), canWrite: /w/.test(d.rw),
      read: r?.state ? { uuid: r.state, name: r.label, own: !!r.linked } : null,
      write: !r || !/w/.test(r.rw) ? (r?.via === 'off' ? { via: 'off' } : null) : r.via === 'vi' || !r.action ? { via: 'vi', vi: r.vi || et.viName(kind, role) } : { via: 'direct', name: r.writeLabel || r.label, uuid: r.action },
      vi: et.viName(kind, role), known: known ? { label: known.label, reg: known.reg } : null, conflict: rt.conflicts[kind]?.[role] || null,
    };
  });
}

// The room controllers of every Miniserver (Gateway first, the same one once): { ms, uuid, name, room }.
async function roomControllerList() {
  const all = (await miniservers()).sort((x, y) => Number(!!x.gateway_client_of) - Number(!!y.gateway_client_of));
  const out = []; const seen = new Set();
  for (const ms of all) {
    const st = await require('./loxoneStructure').getStructure(ms).catch(() => null);
    for (const x of st ? ed.roomControllers(st) : []) {
      if (seen.has(x.uuid)) continue;
      seen.add(x.uuid);
      out.push({ ...x, ms: ms.id, msName: ms.name, value: `${ms.id}|${x.uuid}` });
    }
  }
  return out;
}

async function status(kind, nowMs = Date.now()) { return kind === 'solar' ? solarStatus(nowMs) : heatpumpStatus(nowMs); }

// Pure: outputs that something else in Loxone drives too. LoxSuite knows what it last sent per role;
// when the value read back differs from it (more than a dead band) a while after, without LoxSuite
// sending again, another part of the Loxone program set it back. Loxone doesn't share its wiring, so
// this is seen from what happens. last { role: { value, ms } }, values { role: number }
//   -> { role: { sent, now, sentAt, seenAt } }
function detectConflicts(last, values, nowMs, { settleMs = 90000, withinMs = 6 * HOUR, band = 0.5 } = {}) {
  const out = {};
  for (const [role, w] of Object.entries(last || {})) {
    const v = values?.[role];
    if (!Number.isFinite(v) || !Number.isFinite(w.value)) continue;
    if (nowMs - w.ms < settleMs || nowMs - w.ms > withinMs) continue;
    if (Math.abs(v - w.value) > band) out[role] = { sent: w.value, now: v, sentAt: w.ms, seenAt: nowMs };
  }
  return out;
}

// Send (live) or log (shadow) the writes of this minute.
async function apply(kind, st) {
  const cfg = st.cfg;
  if (!cfg.enabled || !st.writes.length || !st.msId) return;
  const allMs = await miniservers();
  const ms0 = allMs.find((m) => m.id === st.msId);
  for (const w of st.writes) {
    const ms = (w.ms && allMs.find((m) => m.id === w.ms)) || ms0;
    if (w.skipped) continue;
    const target = w.action || w.vi;
    const shown = (st.roles || []).find((x) => x.role === w.role)?.write;
    const entry = { at: new Date().toISOString(), role: w.role, target, name: w.action ? (shown?.name || target) : w.vi, direct: !!w.action, value: w.value, why: w.why, live: cfg.mode === 'live' };
    if (cfg.mode === 'live' && ms) {
      try { await require('./loxone').sendHttpVirtualInput(ms, target, w.value); } catch (e) { entry.error = e.message; }
    }
    rt.last[kind][w.role] = { value: w.value, ms: Date.now() };
    if (rt.conflicts[kind][w.role] && Date.now() - rt.conflicts[kind][w.role].seenAt > 6 * HOUR) delete rt.conflicts[kind][w.role];
    rt.sent[kind].push(entry);
    if (rt.sent[kind].length > 200) rt.sent[kind].shift();
  }
}

async function tick(nowMs = Date.now()) {
  for (const kind of KINDS) {
    const cfg = await getConfig(kind);
    if (!cfg.enabled) continue;
    const st = await status(kind, nowMs).catch((e) => { console.error(`[energy modules] ${kind}: ${e.message}`); return null; });
    if (!st) continue;
    // only what was really sent (live) can be overruled by Loxone
    if (cfg.mode === 'live') {
      const found = detectConflicts(rt.last[kind], st.values, nowMs);
      for (const [role, c] of Object.entries(found)) rt.conflicts[kind][role] = c;
    }
    if (kind === 'heatpump') {
      const w = st.weather?.now || {};
      const outdoorC = Number.isFinite(st.state.outdoorC) ? st.state.outdoorC : w.outdoorC;
      // the power step as the own Loxone logic gives it, else from its two relays; the humidity from the
      // own outdoor sensor when there is one (better than the forecast for what really happened)
      const step = Number.isFinite(st.values.powerStep) ? st.values.powerStep : hw.stepOf(st.values.powerLimit1 === 1, st.values.powerLimit2 === 1);
      const rh = Number.isFinite(st.values.outdoorRh) ? st.values.outdoorRh : (w.rh ?? null);
      if (Number.isFinite(outdoorC)) rt.weather.push({ ms: nowMs, outdoorC, rh, defrost: !!st.state.defrost, elecKw: st.values.electricPower ?? null, heatKw: st.state.thermalKw ?? null, step, ntc: Number.isFinite(st.values.ntcMode) ? st.values.ntcMode : hw.stepOf(st.values.ntcRelay1 === 1, st.values.ntcRelay2 === 1) });
      if (Number.isFinite(st.state.roomC) && Number.isFinite(outdoorC)) rt.room.push({ ms: nowMs, roomC: st.state.roomC, outdoorC, heating: st.state.mode === 'heating', ...(Number.isFinite(st.values.roomTarget) ? { targetC: st.values.roomTarget } : {}) });
      if (Number.isFinite(outdoorC)) rt.tune.push({ ms: nowMs, running: st.state.mode === 'heating', defrost: !!st.state.defrost, elecKw: st.values.electricPower ?? null, heatKw: st.state.thermalKw ?? null, outdoorC, rh, ...(st.tuning?.current || {}) });
      while (rt.tune.length && rt.tune[0].ms < nowMs - 60 * DAY) rt.tune.shift();
      while (rt.room.length && rt.room[0].ms < nowMs - 30 * DAY) rt.room.shift();
      while (rt.weather.length && rt.weather[0].ms < nowMs - 60 * DAY) rt.weather.shift();
    }
    if (kind === 'heatpump' && Number.isFinite(st.state.tankC)) {
      rt.tank.push({ ms: nowMs, temp: st.state.tankC, heating: !!st.state.heatingTank, ...(Number.isFinite(st.values.dhwPipeTemp) ? { pipe: st.values.dhwPipeTemp } : {}) });
      while (rt.tank.length && rt.tank[0].ms < nowMs - KEEP_MS) rt.tank.shift();
    }
    await apply(kind, st);
    if (kind === 'heatpump') for (const sr of SERIES) await persist(sr, [hourOf(nowMs)]);
  }
}

// Earlier tank samples (the demo, or an import from Loxone's statistics), merged in order.
function addTankHistory(samples) {
  rt.tank = [...rt.tank, ...samples].sort((a, b) => a.ms - b.ms).filter((x, k, a) => k === 0 || x.ms !== a[k - 1].ms);
  return persistAll('tank', samples);
}


// Pure: series per role [{ ms, v }] (from the statistics, irregular) -> one sample a minute, each role
// carried forward from its last value (for at most maxHoldMin), between fromMs and toMs.
function toMinutes(series, fromMs, toMs, { maxHoldMin = 30 } = {}) {
  const roles = Object.keys(series);
  const idx = Object.fromEntries(roles.map((r) => [r, 0]));
  const out = [];
  for (let t = Math.ceil(fromMs / 60000) * 60000; t < toMs; t += 60000) {
    const row = { ms: t };
    for (const r of roles) {
      const pts = series[r];
      while (idx[r] + 1 < pts.length && pts[idx[r] + 1].ms <= t) idx[r]++;
      const p = pts[idx[r]];
      if (p && p.ms <= t && t - p.ms <= maxHoldMin * 60000) row[r] = p.v;
    }
    out.push(row);
  }
  return out;
}

// The history of the linked Loxone objects that keep statistics (not all do), through the Miniserver's
// AI-assistant connection (control_statistics), as if it had been sampled live: tank and pipe for the
// draws, outdoor / humidity / defrost / power / heat / steps for the weather, the room for warming up.
// -> { from, to, roles: { role: points }, without: [roles linked but without statistics], samples }
async function importStatistics(kind, { days = 14, callTool = null, nowMs = Date.now() } = {}) {
  const r = await resolve(kind);
  const ms = (await miniservers()).find((m) => m.id === r.msId);
  if (!ms) throw new Error('No Miniserver for this module.');
  const structOf = new Map();
  const structureFor = async (id) => { if (!structOf.has(id)) { const m = (await miniservers()).find((x) => x.id === id); structOf.set(id, m ? { m, s: await require('./loxoneStructure').getStructure(m).catch(() => null) } : null); } return structOf.get(id); };
  const call = callTool || ((m, name, input) => require('./mcpClient').callTool(m, name, input));
  const fromMs = nowMs - Math.max(1, Math.min(60, days)) * DAY;
  const series = {}; const without = [];
  for (const reg of r.type.registers) {
    if (!reg.role || !reg.state) continue;
    const home = await structureFor(reg.ms ?? ms.id);
    const ctl = home?.s?.controls?.[reg.control];
    const group = ctl?.statisticV2?.groups?.[0];
    if (!ctl) { without.push(reg.role); continue; }
    if (!group) { without.push(reg.role); continue; }
    const res = await call(home.m, 'control_statistics', { uuid: reg.control, mode: 'raw', group_id: String(group.id), from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString(), limit: 20000 }).catch((e) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
    let obj = res;
    if (res && Array.isArray(res.content)) {
      if (res.isError) { without.push(reg.role); continue; }
      try { obj = JSON.parse(res.content.find((c) => c.type === 'text')?.text || '{}'); } catch { without.push(reg.role); continue; }
    }
    // a control with several outputs (a room controller: actual and target): the one of this state
    const stateName = Object.entries(ctl.states || {}).find(([, u]) => u === reg.state)?.[0];
    const col = Math.max(0, (obj?.header || []).findIndex((h) => h.output === stateName));
    const pts = (obj?.rows || []).map((x) => ({ ms: Date.parse(x.ts), v: Number(x.values?.[col]) })).filter((x) => Number.isFinite(x.ms) && Number.isFinite(x.v)).sort((a, b) => a.ms - b.ms);
    if (pts.length) series[reg.role] = pts; else without.push(reg.role);
  }
  const rows = toMinutes(series, fromMs, nowMs);
  if (kind === 'heatpump') {
    const tank = []; const weather = []; const room = []; const tune = [];
    for (const x of rows) {
      const heatingTank = x.valveDhw === 1 || (x.valveDhw === undefined && x.forceDhw === 1);
      if (Number.isFinite(x.tankTemp)) tank.push({ ms: x.ms, temp: x.tankTemp, heating: heatingTank, ...(Number.isFinite(x.dhwPipeTemp) ? { pipe: x.dhwPipeTemp } : {}) });
      if (Number.isFinite(x.outdoorTemp)) {
        const meterKw = Number.isFinite(x.heatMeterPower) ? x.heatMeterPower : hp.heatFromMeter(x, r.cfg.heat_meter_flow_unit || 'l/h');
        const heatKw = Number.isFinite(meterKw) && x.valveDhw !== 1 ? meterKw : x.thermalPower;
        weather.push({ ms: x.ms, outdoorC: x.outdoorTemp, rh: x.outdoorRh ?? null, defrost: x.defrost === 2, elecKw: x.electricPower ?? null, heatKw: heatKw ?? null, step: Number.isFinite(x.powerStep) ? x.powerStep : hw.stepOf(x.powerLimit1 === 1, x.powerLimit2 === 1), ntc: Number.isFinite(x.ntcMode) ? x.ntcMode : 0 });
        if (Number.isFinite(x.roomTemp)) room.push({ ms: x.ms, roomC: x.roomTemp, outdoorC: x.outdoorTemp, heating: (x.compressorHz || 0) > 0 && x.valveDhw !== 1 && x.defrost !== 2, ...(Number.isFinite(x.roomTarget) ? { targetC: x.roomTarget } : {}) });
        tune.push({ ms: x.ms, running: (x.compressorHz || 0) > 0 && x.valveDhw !== 1, defrost: x.defrost === 2, elecKw: x.electricPower ?? null, heatKw: heatKw ?? null, outdoorC: x.outdoorTemp, rh: x.outdoorRh ?? null, flowC: Number.isFinite(x.logicFlowC) ? x.logicFlowC : x.heatingMode === 1 ? (x.flowSetpoint ?? x.roomSetpoint ?? null) : (x.flowSetpoint ?? null), step: Number.isFinite(x.powerStep) ? x.powerStep : hw.stepOf(x.powerLimit1 === 1, x.powerLimit2 === 1), ntc: Number.isFinite(x.ntcMode) ? x.ntcMode : 0 });
      }
    }
    const keep = (arr) => arr.filter((x) => x.ms < fromMs || x.ms >= nowMs);
    rt.tank = [...keep(rt.tank), ...tank].sort((a, b) => a.ms - b.ms);
    rt.weather = [...keep(rt.weather), ...weather].sort((a, b) => a.ms - b.ms);
    rt.room = [...keep(rt.room), ...room].sort((a, b) => a.ms - b.ms);
    rt.tune = [...keep(rt.tune), ...tune].sort((a, b) => a.ms - b.ms);
    await persistAll('tank', tank); await persistAll('weather', weather); await persistAll('room', room); await persistAll('tune', tune);
    return { from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString(), roles: Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.length])), without, samples: { tank: tank.length, weather: weather.length, room: room.length, runs: tu.runs(tune).length } };
  }
  return { from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString(), roles: Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.length])), without, samples: {} };
}

// ------------------------------------------------------------------ kept in the database (em_samples)

const SERIES = ['tank', 'weather', 'room', 'tune'];
const hourOf = (ms) => new Date(Math.floor(ms / HOUR) * HOUR).toISOString();

// The hours of a series that changed, written as one row each (that hour's samples).
async function persist(series, hours) {
  for (const h of hours) {
    const from = Date.parse(h); const to = from + HOUR;
    const data = rt[series].filter((x) => x.ms >= from && x.ms < to);
    if (data.length) await db.upsert('em_samples', { series, hour: h, data: JSON.stringify(data) }, ['series', 'hour']).catch(() => {});
  }
}
const persistAll = (series, samples) => persist(series, [...new Set(samples.map((x) => hourOf(x.ms)))]);

// After a restart: the last 60 days back into memory; older rows are removed.
async function loadPersisted(nowMs = Date.now()) {
  const from = hourOf(nowMs - 60 * DAY);
  await db.prepare('DELETE FROM em_samples WHERE hour < ?').run(from).catch(() => {});
  const rows = await db.prepare('SELECT series, data FROM em_samples WHERE hour >= ? ORDER BY hour').all(from).catch(() => []);
  for (const sr of SERIES) {
    const got = rows.filter((r) => r.series === sr).flatMap((r) => { try { return JSON.parse(r.data); } catch { return []; } });
    const have = new Set(rt[sr].map((x) => x.ms));
    rt[sr] = [...rt[sr], ...got.filter((x) => !have.has(x.ms))].sort((a, b) => a.ms - b.ms);
  }
  return rows.length;
}

function addWeatherHistory(samples) { rt.weather = [...rt.weather, ...samples].sort((a, b) => a.ms - b.ms); return persistAll('weather', samples); }
function addRoomHistory(samples) { rt.room = [...rt.room, ...samples].sort((a, b) => a.ms - b.ms); return persistAll('room', samples); }
function addTuneHistory(samples) { rt.tune = [...rt.tune, ...samples].sort((a, b) => a.ms - b.ms); return persistAll('tune', samples); }

function startEnergyModules() { if (!rt.timer) { loadPersisted().catch((e) => console.error(`[energy modules] load: ${e.message}`)); rt.timer = setInterval(() => tick().catch(() => {}), 60000); setTimeout(() => tick().catch(() => {}), 5000); } }
function stopEnergyModules() { if (rt.timer) clearInterval(rt.timer); rt.timer = null; }

function lastStructures(kind) { return rt.discovered.get(kind)?.structures || []; }

module.exports = { lastStructures, loadPersisted, detectConflicts, KINDS, DEFAULTS, getConfig, saveConfig, discover, resolve, status, tick, importStatistics, toMinutes, addTankHistory, addWeatherHistory, addRoomHistory, addTuneHistory, startEnergyModules, stopEnergyModules, rolesView };
