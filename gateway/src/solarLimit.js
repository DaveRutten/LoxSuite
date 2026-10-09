// Solar module (example, see docs/voorstel-energiemodules.md): limit the inverter when exporting costs
// money — a negative market price after net metering ends, or a supplier's feed-in charge per kWh.
//
// The other modules come first: in those hours the planner already moves the tank, the car and the
// on/off consumers onto the solar (its value is negative, so using it is the cheapest there is). What
// they can't take, the inverter doesn't make: the limit follows what the house uses now plus a margin,
// so nothing is drawn from the grid either. Exporting worth something again: the limit is lifted.
//
//   (what exporting yields under the contract, feed-in costs included: solarValue.exportNet)
//   limitPct      the limit for this moment, in steps (fewer writes, no hunting around one value)
//   writesFor     -> the enables once (their own on-value) and the limit (%) through energyTypes.writes
const et = require('./energyTypes');

// Pure: { limit, pct, why }. houseKw = what the house (all consumers) uses now, without the export.
function limitPct({ value, houseKw, inverterKw = 8, minPct = 0, stepPct = 5, marginKw = 0.2, thresholdEur = 0 }) {
  if (value === null || value === undefined || value >= thresholdEur) return { limit: false, pct: 100, why: value === null ? 'no price: no limit' : `export yields € ${value.toFixed(3)}/kWh: no limit` };
  const kw = Math.max(0, (Number(houseKw) || 0) + marginKw);
  const raw = (kw / inverterKw) * 100;
  const pct = Math.min(100, Math.max(minPct, Math.ceil(raw / stepPct) * stepPct));
  return { limit: true, pct, why: `export costs € ${(-value).toFixed(3)}/kWh: only what the house uses (${kw.toFixed(1)} kW)` };
}

function writesFor({ type, value, houseKw, now = {}, last = {}, nowMs = Date.now(), settings = {} }) {
  const s = { ...(type.defaults || {}), ...settings };
  const l = limitPct({ value, houseKw, ...s });
  // the enables go on once, to their own on-value (SolarEdge: AdvancedPwrControlEn = 4,
  // ReactivePwrConfig = 1), and stay on — they are stored in the inverter, so not switched every
  // hour; the limit alone does the work (100 % = no limit)
  const want = [];
  for (const role of ['powerControlEnable', 'reactivePowerConfig']) {
    const r = et.byRole(type, role);
    if (r) want.push({ role, value: Number.isFinite(Number(r.onValue)) ? Number(r.onValue) : 1, why: 'power control on (stays on; 100 % = no limit)' });
  }
  want.push({ role: 'powerLimitPct', value: l.pct, why: l.why });
  return et.writes('solar', type, want, { now, last, nowMs, maxWritesPerHour: s.maxWritesPerHour ?? 20 });
}

module.exports = { limitPct, writesFor };
