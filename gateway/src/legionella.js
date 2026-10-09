// Tap-water limits and the legionella cycle for the Heat pump module (example, see
// docs/voorstel-energiemodules.md).
//
//   dhwLimits      the user's temperature limits, put in order, with warnings: comfort minimum ≤ target
//                  ≤ buffer maximum ≤ absolute maximum; above what the heat pump reaches on its own the
//                  booster helps (direct electric), which the buffer only may when the user allows it
//   lastDone       when the tank was last held at the legionella temperature long enough (from the
//                  measured tank temperature: by LoxSuite's cycle, the unit's own program or a sunny
//                  afternoon on a full buffer — they all count)
//   planLegionella the cheapest block of the coming days to do it, before it is due: within the hours
//                  allowed, solar surplus first (the booster's kWh are then free); overdue = the first
//                  allowed block
//
// The unit's own legionella program stays the safety net: set it in the Ecodan to a longer interval
// than LoxSuite's, so it only runs when LoxSuite didn't.
const HOUR = 3600000;
const DAY = 86400000;
const MIN = 60000;

const DEFAULT_LIMITS = { comfortMinC: 45, targetC: 50, bufferMaxC: 55, hpMaxC: 55, absoluteMaxC: 60, boosterForBuffer: false };

// Pure: limits put in order, and what to tell the user.
function dhwLimits(input = {}) {
  const n = (k) => (Number.isFinite(Number(input[k])) && input[k] !== '' && input[k] !== null ? Number(input[k]) : DEFAULT_LIMITS[k]);
  const l = { comfortMinC: n('comfortMinC'), targetC: n('targetC'), bufferMaxC: n('bufferMaxC'), hpMaxC: n('hpMaxC'), absoluteMaxC: n('absoluteMaxC'), boosterForBuffer: !!input.boosterForBuffer };
  const warnings = [];
  if (l.absoluteMaxC > 65) { warnings.push('absolute maximum above 65 °C: scalding risk at the tap without a thermostatic mixing valve'); }
  if (l.comfortMinC < 40) warnings.push('comfort minimum below 40 °C: legionella grows best between 25 and 45 °C — keep the weekly legionella cycle on');
  if (l.targetC < l.comfortMinC) { warnings.push(`target raised to the comfort minimum (${l.comfortMinC} °C)`); l.targetC = l.comfortMinC; }
  if (l.bufferMaxC < l.targetC) { warnings.push(`buffer maximum raised to the target (${l.targetC} °C)`); l.bufferMaxC = l.targetC; }
  if (l.bufferMaxC > l.absoluteMaxC) { warnings.push(`buffer maximum lowered to the absolute maximum (${l.absoluteMaxC} °C)`); l.bufferMaxC = l.absoluteMaxC; }
  if (l.targetC > l.hpMaxC) warnings.push(`target above what the heat pump reaches on its own (${l.hpMaxC} °C): every cycle uses the booster`);
  if (l.bufferMaxC > l.hpMaxC && !l.boosterForBuffer) { warnings.push(`buffer above ${l.hpMaxC} °C only with the booster: limited to ${l.hpMaxC} °C (allow the booster on solar to go higher)`); l.bufferMaxC = l.hpMaxC; }
  // the highest the planner may heat to on solar / cheap power
  l.planMaxC = l.bufferMaxC;
  return { limits: l, warnings };
}

// Pure: the last time the tank stayed at ≥ targetC for holdMin (samples [{ ms, temp }] in order).
function lastDone(samples, { targetC = 60, holdMin = 30, maxGapMin = 15 } = {}) {
  let since = null; let done = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const gap = i > 0 && s.ms - samples[i - 1].ms > maxGapMin * MIN;
    if (!(s.temp >= targetC - 0.2) || gap) { since = s.temp >= targetC - 0.2 ? s.ms : null; continue; }
    if (since === null) since = s.ms;
    // the moment this run reached the hold time (the last run that did counts)
    if (s.ms - since >= holdMin * MIN) done = since + holdMin * MIN;
  }
  return done;
}

// Pure: when to do it. hours [{ ms, price, surplusKwh }] for the coming days; localHour(ms) -> 0..23.
//   -> { due, overdue, block: { startMs, endMs, cost, solar }, reason } (block null: nothing allowed)
function planLegionella({ hours, nowMs, lastDoneMs = null, intervalDays = 7, fromHour = 10, toHour = 17, durationH = 2, boosterKw = 3, localHour, minLeadH = 0 }) {
  const due = lastDoneMs === null ? nowMs : lastDoneMs + intervalDays * DAY;
  const overdue = due <= nowMs;
  const inWindow = (ms) => { const h = localHour(ms); return fromHour <= toHour ? h >= fromHour && h + 1 <= toHour : h >= fromHour || h < toHour; };
  const H = hours.filter((h) => h.ms >= Math.floor(nowMs / HOUR) * HOUR + minLeadH * HOUR);
  // the energy above what the heat pump does is the booster's: free on surplus, else the price
  const cost = (h) => Math.max(0, boosterKw - (h.surplusKwh || 0)) * (h.price ?? 0.3);
  let best = null;
  for (let i = 0; i + durationH <= H.length; i++) {
    const block = H.slice(i, i + durationH);
    if (block[block.length - 1].ms - block[0].ms !== (durationH - 1) * HOUR) continue;
    if (!block.every((h) => inWindow(h.ms))) continue;
    const endMs = block[block.length - 1].ms + HOUR;
    // overdue: the first allowed block; else any block before it is due (a day early is fine)
    if (!overdue && block[0].ms > due) break;
    const c = block.reduce((a, h) => a + cost(h), 0);
    const solar = block.every((h) => (h.surplusKwh || 0) >= boosterKw * 0.8);
    if (!best || c < best.cost - 1e-9) best = { startMs: block[0].ms, endMs, cost: Math.round(c * 100) / 100, solar };
    if (overdue) break;
  }
  const at = (ms) => `${String(localHour(ms)).padStart(2, '0')}:00`;
  const reason = !best ? `no ${durationH} h block between ${fromHour}:00 and ${toHour}:00 before it is due`
    : overdue ? `overdue: first allowed block, ${at(best.startMs)}`
      : best.solar ? `on solar surplus, ${at(best.startMs)}: the booster's kWh are free` : `cheapest block before it is due, ${at(best.startMs)}`;
  return { due, overdue, block: best, reason };
}

module.exports = { DEFAULT_LIMITS, dhwLimits, lastDone, planLegionella };
