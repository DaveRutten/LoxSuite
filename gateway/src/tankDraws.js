// Tap water from the tank temperature alone (example for the Heat pump module, see
// docs/voorstel-energiemodules.md). No flow meter: a tank that cools faster than it does on its own
// means hot water was drawn. What "faster" is, is learned per tank.
//
//   dropRates      °C per hour over a short window, only while the heat pump is not heating the tank
//   learnThreshold the tank's own standby loss (median) and its spread (MAD); a draw is far above that
//   detectDraws    runs of fast-dropping minutes -> draws { startMs, endMs, dropC }
//   pipeDraws      with a sensor on the hot-water pipe: each jump of the pipe temperature is a draw
//   drawProfile    draws per hour of the day / weekday (the energyPatterns profile, °C instead of kWh)
//   planTank       hour by hour: the predicted tank temperature (standby loss + the usual draws), the
//                  first hour it would fall below the comfort minimum, and the cheapest hours before
//                  that to heat it -> per hour mode 'dhw' (tap water) or 'free' (space heating / Loxone)
//
// One compressor does both: an hour for tap water is an hour without space heating, so planTank never
// plans more tap-water hours in a row than the house may go without heat (holdH). A tank that is
// already too cold is heated now: waiting is when the boost element (direct electric) steps in.
// Everything here is pure; samples are [{ ms, temp, heating }] in order, about one per minute.
const ep = require('./energyPatterns');

const HOUR = 3600000;
const MIN = 60000;
const r2 = (x) => Math.round(x * 100) / 100;

function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Drop per hour (positive = cooling) at every sample, against the sample windowMin earlier, when the
// tank was not heated in between and the samples have no gap longer than maxGapMin.
function dropRates(samples, { windowMin = 5, maxGapMin = 15 } = {}) {
  const out = [];
  let j = 0;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    if (s.heating || !Number.isFinite(s.temp)) { j = i; continue; }
    if (s.ms - samples[i - 1].ms > maxGapMin * MIN || samples[i - 1].heating) { j = i; continue; }
    while (j < i - 1 && samples[j + 1].ms <= s.ms - windowMin * MIN) j++;
    const a = samples[j];
    const dtH = (s.ms - a.ms) / HOUR;
    if (j === i || a.heating || dtH < (windowMin * MIN * 0.8) / HOUR) continue;
    out.push({ ms: s.ms, cph: (a.temp - s.temp) / dtH });
  }
  return out;
}

// What counts as fast for this tank: far above its usual standby loss. Until there is enough data a
// safe default (8 °C/h = a shower on a 200 l tank shows easily; standby is ~0.3-1 °C/h).
function learnThreshold(rates, { minRates = 500, k = 8, floorCph = 4, defaultCph = 8 } = {}) {
  const xs = rates.map((r) => r.cph);
  if (xs.length < minRates) return { cph: defaultCph, learned: false, n: xs.length, baselineCph: null };
  const base = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - base))) * 1.4826;
  return { cph: r2(Math.max(floorCph, base + k * mad)), learned: true, n: xs.length, baselineCph: r2(base) };
}

// Draws: fast-dropping minutes, merged when less than mergeMin apart; dropC from the temperature
// just before to the lowest point. Smaller drops are noise (a sensor that steps 0.5 °C).
function detectDraws(samples, { thresholdCph = 8, windowMin = 5, mergeMin = 10, minDropC = 0.8 } = {}) {
  const fast = dropRates(samples, { windowMin }).filter((r) => r.cph >= thresholdCph);
  const groups = [];
  for (const r of fast) {
    const g = groups[groups.length - 1];
    if (g && r.ms - g.endMs <= mergeMin * MIN) { g.endMs = r.ms; continue; }
    // it started at the first clear step down in the window (more than the sensor's 0.1 °C)
    const win = samples.filter((s) => s.ms >= r.ms - windowMin * MIN && s.ms <= r.ms);
    const k = win.findIndex((s, i) => i > 0 && win[i - 1].temp - s.temp >= 0.2);
    groups.push({ startMs: k > 0 ? win[k].ms : r.ms - windowMin * MIN, endMs: r.ms });
  }
  const out = [];
  for (const g of groups) {
    const before = samples.filter((s) => s.ms < g.startMs).pop();
    const during = samples.filter((s) => s.ms >= g.startMs && s.ms <= g.endMs + mergeMin * MIN && !s.heating);
    if (!before || !during.length) continue;
    const dropC = before.temp - Math.min(...during.map((s) => s.temp));
    if (dropC >= minDropC) out.push({ startMs: g.startMs, endMs: g.endMs, dropC: r2(dropC) });
  }
  return out;
}

// Draws from a temperature sensor on the hot-water pipe towards the taps: it jumps up within minutes
// when hot water runs, and cools down slowly after. Each jump is a draw — exact in time, small ones
// included; how much it took comes from the tank (its temperature before, its lowest point after).
//   samples [{ ms, temp (tank), pipe }] in order -> draws { startMs, endMs, dropC, fromPipe: true }
function pipeDraws(samples, { riseC = 3, windowMin = 3, endBelowPeakC = 4, maxMin = 60, minDropC = 0.3 } = {}) {
  const out = [];
  let i = 1;
  while (i < samples.length) {
    const s = samples[i];
    if (!Number.isFinite(s.pipe)) { i++; continue; }
    // the lowest pipe temperature in the minutes before
    let base = s.pipe;
    for (let j = i - 1; j >= 0 && samples[j].ms >= s.ms - windowMin * MIN; j--) if (Number.isFinite(samples[j].pipe)) base = Math.min(base, samples[j].pipe);
    if (s.pipe - base < riseC) { i++; continue; }
    // running: until the pipe falls clearly below its peak (the tap closed) or maxMin
    let peak = s.pipe; let k = i;
    while (k + 1 < samples.length && samples[k + 1].ms - s.ms <= maxMin * MIN) {
      const p = samples[k + 1].pipe;
      if (Number.isFinite(p)) { peak = Math.max(peak, p); if (p < peak - endBelowPeakC) break; }
      k++;
    }
    const startMs = s.ms - windowMin * MIN;
    // only around the draw (searching the whole series per draw made weeks of samples slow)
    let b = i; while (b >= 0 && samples[b].ms >= startMs) b--;
    while (b >= 0 && !Number.isFinite(samples[b].temp)) b--;
    const before = b >= 0 ? samples[b] : null;
    let lowest = Infinity;
    for (let a = b + 1; a < samples.length && samples[a].ms <= samples[k].ms + 15 * MIN; a++) {
      const x = samples[a];
      if (x.ms >= startMs && Number.isFinite(x.temp) && !x.heating) lowest = Math.min(lowest, x.temp);
    }
    const dropC = before && lowest < Infinity ? r2(before.temp - lowest) : 0;
    if (dropC >= minDropC) out.push({ startMs: s.ms, endMs: samples[k].ms, dropC, fromPipe: true });
    i = k + 1;
  }
  return out;
}

// When the draws usually come: the energyPatterns profile with °C dropped per hour in place of kWh,
// so the same daily / weekly patterns and expectedKwh() work on it.
function drawProfile(draws, { localOf, nowMs, firstMs = null }) {
  const by = new Map();
  for (const d of draws) {
    const h = new Date(Math.floor(d.startMs / HOUR) * HOUR).toISOString();
    by.set(h, (by.get(h) || 0) + d.dropC);
  }
  const hourly = [...by].map(([hour, kwh]) => ({ hour, kwh }));
  // the observed days start at the first sample, not at the first draw
  if (firstMs !== null) hourly.push({ hour: new Date(Math.floor(firstMs / HOUR) * HOUR).toISOString(), kwh: 0 });
  return ep.profile({ hourly, localOf, nowMs, threshold: 0.5 });
}

// Pure: predicted tank temperature per hour with the chosen heating hours, from tankC now.
function predict(H, { tankC, lossCph, dropOf, heatCph, maxC, dhw }) {
  const out = [];
  let t = tankC;
  for (let i = 0; i < H.length; i++) {
    if (dhw.has(i)) t = Math.min(maxC, t + heatCph);
    t -= lossCph + dropOf(H[i].ms);
    out.push(r2(t));
  }
  return out;
}

// The plan. hours [{ ms, price, surplusKwh }] from the current hour; dropOf(ms) = expected °C drawn in
// that hour (from drawProfile); heatCph = °C the heat pump adds to the tank per hour of tap water.
//   -> { hours: [{ ms, mode: 'dhw'|'free', predC, reason }], deadlines: [ms] }
function planTank({ hours, tankC, dropOf = () => 0, lossCph = 0.6, heatCph = 10, kw = 2, minC = 45, marginC = 2, maxC = 55, holdH = 2, costOf = null, heatingHours = new Set(), nextToHeating = 0.9, clock = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC` }) {
  const H = hours;
  const base = costOf || ((h) => ((h.surplusKwh || 0) >= kw * 0.8 ? 0 : h.price ?? 1));
  // space heating has its block (pre-heating the room): tap water goes right before or right after it,
  // never in between — one compressor, one run. The hours next to the block are a little cheaper.
  const inHeating = (i) => heatingHours.has(H[i]?.ms);
  const nextTo = (i) => !inHeating(i) && (inHeating(i - 1) || inHeating(i + 1));
  const cost = (h, i) => base(h) * (nextTo(i) ? nextToHeating : 1);
  const dhw = new Set();
  const why = new Map();
  const deadlines = [];
  const opts = { tankC, lossCph, dropOf, heatCph, maxC, dhw };
  // too cold already: heat now, otherwise the boost element will
  if (tankC < minC) { dhw.add(0); why.set(0, `tank ${r2(tankC)} °C, below ${minC} °C: now, before the boost element steps in`); }
  for (let guard = 0; guard < H.length; guard++) {
    const pred = predict(H, opts);
    const d = pred.findIndex((t) => t < minC);
    if (d < 0) break;
    deadlines.push(H[d].ms);
    // the cheapest free hour before the deadline that doesn't make the house wait too long
    const run = (i) => { let n = 1; for (let x = i - 1; dhw.has(x); x--) n++; for (let x = i + 1; dhw.has(x); x++) n++; return n; };
    const pick = H.map((h, i) => i).filter((i) => i <= d && !dhw.has(i) && !inHeating(i) && run(i) <= holdH).sort((a, b) => cost(H[a], a) - cost(H[b], b) || b - a)[0];
    if (pick === undefined) break; // nothing left before the deadline: Loxone's own logic (and the boost) take over
    dhw.add(pick);
    const at = clock(H[d].ms);
    const side = inHeating(pick + 1) ? ', right before heating the room' : inHeating(pick - 1) ? ', right after heating the room' : '';
    why.set(pick, ((H[pick].surplusKwh || 0) >= kw * 0.8 ? `solar surplus, hot before the usual draw ~${at}` : `cheapest hour before the tank would drop below ${minC} °C (~${at})`) + side);
  }
  // top up with a surplus that would otherwise be exported, as long as there is room in the tank
  for (let i = 0; i < H.length; i++) {
    if (dhw.has(i) || inHeating(i) || (H[i].surplusKwh || 0) < kw * 0.8) continue;
    const before = predict(H, opts)[i - 1] ?? tankC;
    if (before + heatCph * 0.5 <= maxC - marginC) { dhw.add(i); why.set(i, 'solar surplus: tank as a buffer'); }
  }
  const pred = predict(H, opts);
  return {
    deadlines,
    hours: H.map((h, i) => ({ ms: h.ms, mode: dhw.has(i) ? 'dhw' : inHeating(i) ? 'heating' : 'free', predC: pred[i], reason: why.get(i) || (inHeating(i) ? 'heating the room (no tap water in between)' : pred[i] < minC + marginC ? 'low but enough until the next planned hour' : 'warm enough: space heating') })),
  };
}

module.exports = { dropRates, learnThreshold, detectDraws, pipeDraws, drawProfile, predict, planTank };
