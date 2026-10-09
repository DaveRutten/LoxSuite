// The Heat pump module's side of a device type (example, see docs/voorstel-energiemodules.md). The
// types themselves (registers, roles, scaling; Mitsubishi Ecodan built in, other makes as the user's
// own file or "own / other make") are in energyTypes.js; this is what the module does with them.
//
//   interpret      what the heat pump is doing: tap water / heating / defrost / fault, heat output from
//                  flow × ΔT, COP with an electric meter, and whether the immersion heater (boost) runs
//   dhwSetpoint    the tap-water setpoint for a planned hour (most heat pumps have no "heat now")
//   writesFor      a planned hour -> the values to send through the WP_ virtual inputs
const et = require('./energyTypes');

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const WATER_KJ_PER_L_K = 4.186;

// Pure: what the unit is doing now. v = fromRaw(); electricKw from its own meter (optional, else the
// unit's own "consumed power" when the type has it).
//   boost: the booster / immersion heater. Read directly when the type has it (A1M: Booster Heater,
//   Immersion Heater, Heat Source ≠ 0); otherwise guessed from the power: power while the compressor
//   stands still (and it is not defrosting), or more than the compressor can draw on its own.
// Pure: the heat a meter without its own power output measures: water flow × (flow − return) × 4.186.
//   unit of the flow: 'auto' (below 100: l/min — a heat pump never runs below 100 l/h — else l/h), 'l/h',
//   'l/min' or 'm3/h'. Loxone's unit label can be wrong when the value is scaled (3600 -> 60: l/min).
function heatFromMeter(v, unit = 'auto') {
  if (!Number.isFinite(v.heatMeterFlowRate) || !Number.isFinite(v.heatMeterFlowTemp) || !Number.isFinite(v.heatMeterReturnTemp)) return null;
  if (unit === 'auto') unit = Math.abs(v.heatMeterFlowRate) < 100 ? 'l/min' : 'l/h';
  const lpm = unit === 'l/min' ? v.heatMeterFlowRate : unit === 'm3/h' ? (v.heatMeterFlowRate * 1000) / 60 : v.heatMeterFlowRate / 60;
  const dT = v.heatMeterFlowTemp - v.heatMeterReturnTemp;
  return lpm > 0 && dT > 0 ? r2((lpm * dT * WATER_KJ_PER_L_K) / 60) : 0;
}

function interpret(v, { electricKw = null, compressorMaxKw = 3.5, meterFlowUnit = 'auto' } = {}) {
  const fault = v.fault === 1 || (v.errorCode !== undefined && v.errorCode !== 8000 && v.errorCode !== 0 && v.fault !== undefined);
  const defrost = v.defrost === 2;
  const elec = electricKw ?? v.electricPower ?? null;
  const running = v.running === 1 || (v.compressorHz || 0) > 0;
  const mode = fault ? 'fault' : defrost ? 'defrost' : !running ? 'idle' : v.valveDhw === 1 ? 'dhw' : 'heating';
  // the heat from flow × ΔT — with own sensors per circuit (CV / tap water) the ones of the circuit in use
  const onDhw = v.valveDhw === 1;
  const fr = onDhw && Number.isFinite(v.dhwFlowRate) ? v.dhwFlowRate : v.flowRate;
  const ft = onDhw && Number.isFinite(v.dhwFlowTemp) ? v.dhwFlowTemp : v.flowTemp;
  const rt = onDhw && Number.isFinite(v.dhwReturnTemp) ? v.dhwReturnTemp : v.returnTemp;
  const dT = Number.isFinite(ft) && Number.isFinite(rt) ? ft - rt : null;
  const measuredHeat = fr > 0 && v.pumpOn !== 0 && dT !== null && dT > 0 ? r2((fr * dT * WATER_KJ_PER_L_K) / 60) : null;
  // a heat meter in the heating pipe (Kamstrup …) measures the heat best — but only while the heat pump
  // heats the house: tap water bypasses it (3-way valve); then the unit's own figure, else flow × ΔT
  const meterKw = Number.isFinite(v.heatMeterPower) ? v.heatMeterPower : heatFromMeter(v, meterFlowUnit);
  const meterCounts = Number.isFinite(meterKw) && v.valveDhw !== 1;
  const thermalKw = meterCounts ? meterKw : (v.thermalPower ?? measuredHeat);
  const cop = thermalKw !== null && thermalKw !== undefined && elec > 0.2 ? r2(thermalKw / elec) : null;
  let boost = false; let boostWhy = null;
  if (v.boosterHeater !== undefined || v.immersionHeater !== undefined || v.heatSource !== undefined) {
    const on = [v.boosterHeater === 1 && 'booster heater', v.immersionHeater === 1 && 'immersion heater', v.heatSource > 0 && v.heatSourceText].filter(Boolean);
    boost = on.length > 0; boostWhy = boost ? `${[...new Set(on)].join(', ')} on (read from the unit)` : null;
  } else if (elec !== null && !defrost) {
    if ((v.compressorHz || 0) === 0 && elec > 0.8) { boost = true; boostWhy = `${r2(elec)} kW with the compressor at 0 Hz`; }
    else if (elec > compressorMaxKw) { boost = true; boostWhy = `${r2(elec)} kW, more than the compressor alone (${compressorMaxKw} kW)`; }
  }
  // without a valve signal: the unit says tap water is being forced
  const heatingTank = mode === 'dhw' || (v.valveDhw === undefined && v.forceDhw === 1 && running);
  return { mode: heatingTank && mode === 'heating' ? 'dhw' : mode, heatingTank, tankC: v.tankTemp ?? null, outdoorC: v.outdoorTemp ?? null, roomC: v.roomTemp ?? null, thermalKw, cop, boost, boostWhy, fault, defrost };
}

// Pure: the tap-water setpoint for a planned hour.
//   dhw   heat now: above tank + the unit's own drop, so it starts; at most hpMaxC (above that the
//         booster helps). With a "force" register the setpoint is just the target.
//   hold  the unit's own trigger point (setpoint − drop) at the comfort minimum: it only heats by
//         itself when the plan got it wrong — the safety net stays in the heat pump
function dhwSetpoint({ mode, tankC, targetC = 52, comfortMinC = 45, dropC = 10, hpMaxC = 55, minC = 30, force = false }) {
  if (mode === 'dhw') return force ? Math.min(hpMaxC, targetC) : Math.min(hpMaxC, Math.max(targetC, Math.ceil((tankC ?? targetC) + dropC + 1)));
  return Math.min(hpMaxC, Math.max(minC, comfortMinC + dropC));
}

// Pure: plan of this hour -> the values to write. plan: { mode: 'dhw'|'legionella'|'free', block, correctionC };
// now = fromRaw() of the unit; last = { [role]: { value, ms } } of earlier writes.
//   A type with a writable forceDhw (A1M): one pulse starts a cycle up to the setpoint; the unit puts
//   it back to 0 itself, so it is sent once per planned block, not every minute.
function writesFor({ type, plan, now, last = {}, nowMs = Date.now(), settings = {} }) {
  const s = { ...(type.defaults || {}), ...settings };
  const want = [];
  const canWrite = (role) => /w/.test(et.byRole(type, role)?.rw || '');
  const force = canWrite('forceDhw');
  const dropC = Number.isFinite(now.dhwDrop) ? now.dhwDrop : (s.dhwDropC ?? 10);
  // the user's limits: a normal tap-water hour never above the buffer maximum (nor above what the heat
  // pump reaches alone); the legionella cycle is the one time it goes higher, with the booster
  const capC = Math.min(s.hpMaxC ?? 55, s.bufferMaxC ?? Infinity, s.absoluteMaxC ?? Infinity);
  const legionella = plan.mode === 'legionella';
  const target = legionella ? (s.legionellaC ?? 60) : s.targetC;
  if (canWrite('dhwSetpoint')) {
    const value = legionella ? target : dhwSetpoint({ mode: plan.mode, tankC: now.tankTemp, targetC: s.targetC, comfortMinC: s.comfortMinC, dropC, hpMaxC: capC, force });
    want.push({ role: 'dhwSetpoint', value,
      why: legionella ? `legionella: ${target} °C (the booster helps above ${s.hpMaxC ?? 55} °C)` : plan.mode === 'dhw' ? (force ? 'tap water now: up to the target' : 'tap water now: above tank + drop') : `hold: the unit itself only starts below ${s.comfortMinC} °C` });
  }
  if (force && (plan.mode === 'dhw' || legionella) && now.forceDhw !== 1 && !(now.tankTemp >= (target ?? 50) - 1)) {
    const sent = last.forceDhw && nowMs - last.forceDhw.ms < 3600000;
    if (!sent) want.push({ role: 'forceDhw', value: 1, why: legionella ? 'start the legionella cycle' : 'start one tap-water cycle', pulse: true });
  }
  if (plan.block !== undefined && canWrite('heatingBlock')) want.push({ role: 'heatingBlock', value: plan.block ? 1 : 0, why: plan.block ? 'expensive hour, the house holds its warmth' : 'released' });
  // Heating on a fixed flow temperature (Ecodan mode 1): the unit's "thermostat target" IS the flow
  // temperature then — never a room temperature into it. The flow comes from the tuning (plan.flowC).
  const onFlow = now.heatingMode === 1;
  if (onFlow && Number.isFinite(plan.flowC)) {
    const role = canWrite('flowSetpoint') ? 'flowSetpoint' : canWrite('roomSetpoint') ? 'roomSetpoint' : null;
    if (role) want.push({ role, value: plan.flowC, why: plan.flowWhy || 'tuning: flow temperature' });
  }
  // the relays only know steps 0–2 (a step given as a percentage can't be switched by them)
  if (Number.isFinite(plan.step) && plan.step >= 0 && plan.step <= 2) {
    if (canWrite('powerLimit1')) want.push({ role: 'powerLimit1', value: plan.step >= 1 ? 1 : 0, why: plan.tuneWhy || 'tuning: power step' });
    if (canWrite('powerLimit2')) want.push({ role: 'powerLimit2', value: plan.step >= 2 ? 1 : 0, why: plan.tuneWhy || 'tuning: power step' });
  }
  if (Number.isFinite(plan.ntc) && plan.ntc >= 0 && plan.ntc <= 2) {
    if (canWrite('ntcRelay1')) want.push({ role: 'ntcRelay1', value: plan.ntc === 1 ? 1 : 0, why: plan.tuneWhy || 'tuning: outdoor sensor' });
    if (canWrite('ntcRelay2')) want.push({ role: 'ntcRelay2', value: plan.ntc === 2 ? 1 : 0, why: plan.tuneWhy || 'tuning: outdoor sensor' });
  }
  // the room's own plan (pre-heating to comfort, set back at night) — only when the unit heats on room
  // temperature, so its target is a room temperature
  if (!onFlow && Number.isFinite(plan.roomC) && canWrite('roomSetpoint')) want.push({ role: 'roomSetpoint', value: plan.roomC, why: plan.roomWhy || 'room plan' });
  // a room correction: on the room setpoint when there is one, else the flow setpoint when the unit
  // heats on flow temperature
  if (!onFlow && !Number.isFinite(plan.roomC) && plan.correctionC && canWrite('roomSetpoint') && Number.isFinite(s.baseRoomC)) {
    want.push({ role: 'roomSetpoint', value: r1(s.baseRoomC + plan.correctionC), why: `correction ${plan.correctionC > 0 ? '+' : ''}${plan.correctionC} °C room` });
  } else if (plan.correctionC && canWrite('flowSetpoint') && now.heatingMode === 1 && Number.isFinite(s.baseFlowC)) {
    want.push({ role: 'flowSetpoint', value: r1(s.baseFlowC + plan.correctionC * (s.flowPerRoomC ?? 2)), why: `correction ${plan.correctionC > 0 ? '+' : ''}${plan.correctionC} °C room` });
  }
  // a pulse is compared with what was sent, not with what the unit reads back (it resets itself)
  const lastFor = { ...last };
  for (const w of want) if (w.pulse) delete lastFor[w.role];
  return et.writes('heatpump', type, want, { now: { ...now, forceDhw: undefined }, last: lastFor, nowMs, maxWritesPerHour: s.maxWritesPerHour ?? 6 });
}

module.exports = { interpret, heatFromMeter, dhwSetpoint, writesFor };
