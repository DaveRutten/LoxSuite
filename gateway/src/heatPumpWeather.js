// What the weather does to a heat pump (example for the Heat pump module, see
// docs/voorstel-energiemodules.md): an air source heat pump gets less heat out of cold air, and in
// cold, humid air (about −3 to +5 °C, above ~85 % humidity) its outdoor coil ices up and it has to
// defrost — minutes of no heat (it even takes some back from the house) and power for nothing. A
// water/water or ground source heat pump hardly notices the weather.
//
//   learn          from minute samples [{ outdoorC, rh, defrost (bool), elecKw, heatKw }]: per outdoor
//                  temperature (2 °C) and humidity band, the share of the time it defrosted and the real
//                  COP (heat out / power in, defrosting included)
//   expect         the expected defrost share and COP for an hour's forecast (outdoor °C, humidity): what
//                  was learned in that bin, else its neighbours, else a sensible start curve per source
//   costPerHeat    what a kWh of heat costs in that hour: price ÷ COP — the plan uses this instead of the
//                  bare price, so tap water is made on a mild afternoon rather than in a cold, foggy night
const r2 = (x) => Math.round(x * 100) / 100;
const SOURCES = ['air', 'water', 'ground'];
const RH_BANDS = [[0, 80, 'dry'], [80, 90, 'humid'], [90, 101, 'wet']];
const band = (rh) => (Number.isFinite(rh) ? (RH_BANDS.find(([lo, hi]) => rh >= lo && rh < hi) || RH_BANDS[2])[2] : 'humid');
const tbin = (c) => Math.floor(c / 2) * 2; // −4 = −4..−2 °C

// The start curve until there is data: COP of an air source heat pump falls with the outdoor
// temperature; defrosting peaks around +1 °C in humid air. Water and ground: steady.
function defaults(source, outdoorC, rh, { flowC = 35 } = {}) {
  if (source !== 'air') return { cop: source === 'ground' ? 4.2 : 4.6, defrost: 0 };
  const t = Number.isFinite(outdoorC) ? outdoorC : 7;
  const lift = Math.max(10, flowC - t);
  const cop = Math.max(1.6, Math.min(5.5, 0.55 * (flowC + 273.15) / lift * 0.45 + 0.4));
  const humid = Number.isFinite(rh) ? Math.max(0, (rh - 70) / 30) : 0.5;
  const nearFreezing = Math.max(0, 1 - Math.abs(t - 1) / 6);
  const defrost = r2(Math.min(0.25, 0.18 * nearFreezing * humid + (t < -5 ? 0.04 : 0)));
  return { cop: r2(cop * (1 - defrost * 0.6)), defrost };
}

// Pure: learned bins. samples [{ outdoorC, rh, defrost, elecKw, heatKw }] (one per minute).
function learn(samples, { minMinutes = 60 } = {}) {
  const bins = new Map();
  for (const s of samples || []) {
    if (!Number.isFinite(s.outdoorC)) continue;
    const k = `${tbin(s.outdoorC)}|${band(s.rh)}`;
    const b = bins.get(k) || { t: tbin(s.outdoorC), band: band(s.rh), minutes: 0, defrostMin: 0, elec: 0, heat: 0, runMin: 0 };
    b.minutes += 1;
    if (s.defrost) b.defrostMin += 1;
    if (Number(s.elecKw) > 0.2) { b.runMin += 1; b.elec += Number(s.elecKw); b.heat += Math.max(0, Number(s.heatKw) || 0); }
    bins.set(k, b);
  }
  const out = {};
  for (const [k, b] of bins) {
    if (b.minutes < minMinutes) continue;
    out[k] = { t: b.t, band: b.band, hours: r2(b.minutes / 60), defrost: r2(b.defrostMin / b.minutes), cop: b.runMin >= minMinutes / 2 && b.elec > 0 ? r2(b.heat / b.elec) : null };
  }
  return { bins: out, samples: (samples || []).length };
}

// Pure: what to expect in an hour with this forecast.
function expect(model, { source = 'air', outdoorC = null, rh = null, flowC = 35 } = {}) {
  const def = defaults(source, outdoorC, rh, { flowC });
  if (!Number.isFinite(outdoorC) || !model?.bins) return { ...def, learned: false };
  const b = band(rh);
  const at = (t) => model.bins[`${t}|${b}`];
  const t0 = tbin(outdoorC);
  const hit = at(t0) || at(t0 - 2) || at(t0 + 2);
  if (!hit) return { ...def, learned: false };
  // water / ground: the learned COP, no defrosting
  return { cop: hit.cop ?? def.cop, defrost: source === 'air' ? hit.defrost : 0, learned: true, bin: `${hit.t}..${hit.t + 2} °C, ${hit.band}` };
}

// Pure: what each power-limit step and outdoor-sensor (NTC) setting does, per outdoor temperature:
// samples [{ outdoorC, step (0..2, from the two relays), ntc (0 = real, 1/2 = fixed values), elecKw, heatKw }]
// -> rows { step, ntc, t, hours, elecKw, heatKw, cop } — to see what running calmer brings, and later
// to choose the step by the plan.
const stepOf = (r1, r2v) => (r1 ? 1 : 0) + (r2v ? 1 : 0);
function learnSteps(samples, { minMinutes = 60 } = {}) {
  const by = new Map();
  for (const s of samples || []) {
    if (!Number.isFinite(s.outdoorC) || !(Number(s.elecKw) > 0.2)) continue;
    const k = `${s.step ?? 0}|${s.ntc ?? 0}|${tbin(s.outdoorC)}`;
    const g = by.get(k) || { step: s.step ?? 0, ntc: s.ntc ?? 0, t: tbin(s.outdoorC), minutes: 0, elec: 0, heat: 0 };
    g.minutes += 1; g.elec += Number(s.elecKw); g.heat += Math.max(0, Number(s.heatKw) || 0);
    by.set(k, g);
  }
  return [...by.values()].filter((g) => g.minutes >= minMinutes)
    .map((g) => ({ step: g.step, ntc: g.ntc, t: g.t, hours: r2(g.minutes / 60), elecKw: r2(g.elec / g.minutes), heatKw: r2(g.heat / g.minutes), cop: g.elec > 0 ? r2(g.heat / g.elec) : null }))
    .sort((a, b) => a.t - b.t || a.step - b.step || a.ntc - b.ntc);
}

// Pure: € per kWh of heat in this hour.
function costPerHeat(price, exp) { return Number.isFinite(price) && exp?.cop > 0 ? r2(price / exp.cop * 100) / 100 : price; }

// Pure: per day the heat delivered and the electricity used (kWh), from samples of one minute (kW).
// dayOf(ms) -> 'YYYY-MM-DD' in local time.
function dailyEnergy(samples, dayOf) {
  const out = {};
  for (const s of samples || []) {
    const e = Number(s.elecKw);
    if (!Number.isFinite(e) || e < 0) continue;
    const d = dayOf(s.ms);
    const g = out[d] || (out[d] = { heat: 0, elec: 0, min: 0, tSum: 0, tN: 0 });
    g.elec += e / 60; g.heat += Math.max(0, Number(s.heatKw) || 0) / 60; g.min += 1;
    if (Number.isFinite(s.outdoorC)) { g.tSum += s.outdoorC; g.tN += 1; }
  }
  return Object.fromEntries(Object.entries(out).map(([d, g]) => [d, { heat: r2(g.heat), elec: r2(g.elec), min: g.min, t: g.tN ? r2(g.tSum / g.tN) : null }]));
}

// Pure: the seasonal COP as measured — all heat delivered divided by all electricity used, over the
// days given (at most the last 365). Days with less than an hour of data don't count.
function scop(days, { fromDay = null } = {}) {
  const list = Object.entries(days || {}).filter(([d, g]) => (!fromDay || d >= fromDay) && g.min >= 60).sort(([a], [b]) => a.localeCompare(b)).slice(-365);
  const heat = list.reduce((a, [, g]) => a + g.heat, 0), elec = list.reduce((a, [, g]) => a + g.elec, 0);
  return { scop: elec > 1 ? r2(heat / elec) : null, heatKwh: Math.round(heat), elecKwh: Math.round(elec), days: list.length, from: list[0]?.[0] || null, to: list[list.length - 1]?.[0] || null };
}

module.exports = { dailyEnergy, scop, SOURCES, band, tbin, defaults, learn, expect, costPerHeat, stepOf, learnSteps };
