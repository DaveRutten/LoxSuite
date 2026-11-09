// Tuning the heat pump for long, calm runs (example for the Heat pump module, see
// docs/voorstel-energiemodules.md). A heat pump that is too strong for the house at that moment runs in
// short bursts (start, overshoot, stop), and an air source heat pump that pulls hard on cold, damp air
// ices up and defrosts more often. Both cost power. What can be turned, per installation:
//   flow    the flow temperature (when the unit heats on a fixed flow temperature)
//   step    the power step (e.g. two relays of the user's own Loxone logic: 0 = full … 2 = calmest)
//   ntc     the outdoor temperature the unit is shown (a fixed NTC value), which moves its own curve
//
//   runs        minute samples -> runs: one start to its stop; defrosts during it count, they don't end it
//   learn       per weather (outdoor 2 °C, humidity band) and setting (flow, step, ntc): runs, average run
//               length, starts and defrosts per hour, kW and COP
//   choose      the setting for this weather: the lowest cost per kWh of heat, with penalties for
//               defrosting and short runs; calmer settings next to the current one are tried when it
//               defrosts a lot and nothing is known about them yet; never calmer while the room is
//               behind (comfort first)
const HOUR = 3600000;
const MIN = 60000;
const r2 = (x) => Math.round(x * 100) / 100;
const { tbin, band, MAX_COP } = require('./heatPumpWeather');

const keyOf = (s) => `${s.flowC ?? '-'}|${s.step ?? 0}|${s.ntc ?? 0}`;
// a flow setpoint passed on ×100 / ×10 (kept in older samples) as °C
const plainC = (v) => (!Number.isFinite(v) ? v : Math.abs(v) > 1000 ? r2(v / 100) : Math.abs(v) > 100 ? r2(v / 10) : v);

// Pure: runs from minute samples [{ ms, running, defrost, elecKw, heatKw, outdoorC, rh, flowC, step, ntc }].
function runs(samples, { maxGapMin = 5 } = {}) {
  const out = [];
  let cur = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const on = !!s.running || !!s.defrost;
    const gap = cur && s.ms - cur.lastMs > maxGapMin * MIN;
    if (cur && (!on || gap)) { out.push(cur); cur = null; }
    if (!on) continue;
    if (!cur) cur = { startMs: s.ms, lastMs: s.ms, minutes: 0, elecMin: 0, defrosts: 0, inDefrost: false, elec: 0, heat: 0, outdoorC: 0, rh: 0, rhN: 0, setting: { flowC: Number.isFinite(s.flowC) ? plainC(s.flowC) : null, step: s.step ?? 0, ntc: s.ntc ?? 0 } };
    cur.minutes += 1; cur.lastMs = s.ms;
    if (s.defrost && !cur.inDefrost) cur.defrosts += 1;
    cur.inDefrost = !!s.defrost;
    // power and heat only from minutes with a known electric power: heat of a minute without one (not
    // read, a gap) counted against no power and gave COPs of hundreds; a minute's heat at most MAX_COP × its power
    const e = s.elecKw === null || s.elecKw === undefined || s.elecKw === '' ? NaN : Number(s.elecKw);
    if (Number.isFinite(e) && e >= 0) { cur.elecMin += 1; cur.elec += e; cur.heat += Math.min(Math.max(0, Number(s.heatKw) || 0), e * MAX_COP); }
    cur.outdoorC += Number(s.outdoorC) || 0;
    if (Number.isFinite(s.rh)) { cur.rh += s.rh; cur.rhN += 1; }
  }
  if (cur) out.push(cur);
  // how long it stood still before each run (a quick restart: it stopped too early)
  return out.map((r, i) => ({ offBeforeMin: i ? Math.round((r.startMs - (out[i - 1].lastMs + MIN)) / MIN) : null, startMs: r.startMs, minutes: r.minutes, elecMin: r.elecMin, defrosts: r.defrosts, elecKw: r.elecMin ? r2(r.elec / r.elecMin) : null, heatKw: r.elecMin ? r2(r.heat / r.elecMin) : null, outdoorC: r2(r.outdoorC / r.minutes), rh: r.rhN ? Math.round(r.rh / r.rhN) : null, setting: r.setting }));
}

// Pure: what each setting did in each weather.
function learn(rs, { minRuns = 2 } = {}) {
  const by = new Map();
  for (const r of rs) {
    const w = `${tbin(r.outdoorC)}|${band(r.rh)}`;
    const k = `${w}|${keyOf(r.setting)}`;
    const g = by.get(k) || { weather: w, setting: r.setting, runs: 0, minutes: 0, elecMin: 0, defrosts: 0, elec: 0, heat: 0, firstMs: r.startMs, lastMs: r.startMs };
    g.runs += 1; g.minutes += r.minutes; g.defrosts += r.defrosts;
    // older run objects without elecMin: all their minutes had a power when elecKw is a number
    const em = r.elecMin ?? (Number.isFinite(r.elecKw) ? r.minutes : 0);
    if (em > 0 && Number.isFinite(r.elecKw)) { g.elecMin += em; g.elec += r.elecKw * em; g.heat += (Number(r.heatKw) || 0) * em; }
    g.firstMs = Math.min(g.firstMs, r.startMs); g.lastMs = Math.max(g.lastMs, r.startMs);
    by.set(k, g);
  }
  const rows = {};
  for (const [k, g] of by) {
    if (g.runs < minRuns) continue;
    rows[k] = {
      weather: g.weather, setting: g.setting, runs: g.runs, runMin: Math.round(g.minutes / g.runs),
      defrostPerH: r2(g.defrosts / (g.minutes / 60)), elecKw: g.elecMin ? r2(g.elec / g.elecMin) : null, heatKw: g.elecMin ? r2(g.heat / g.elecMin) : null,
      // a COP only over enough minutes with a power measured (a third of the run time, at least 30 min)
      cop: g.elec > 0 && g.elecMin >= Math.max(30, g.minutes / 3) ? r2(g.heat / g.elec) : null,
    };
  }
  return rows;
}

// Pure: a score per learned setting — power per kWh of heat (1 / COP), plus penalties for defrosting and
// short runs. useCop false (no power measured for one of the settings compared): only the penalties, so
// settings are still compared on run length and defrosts instead of the current one always winning.
function score(row, { defrostWeight = 0.08, shortRunMin = 40, shortWeight = 0.15, useCop = true } = {}) {
  if (!row) return Infinity;
  if (useCop && !(row.cop > 0)) return Infinity;
  const base = useCop ? 1 / row.cop : 0;
  const defrost = row.defrostPerH * defrostWeight;
  const short = Math.max(0, (shortRunMin - row.runMin) / shortRunMin) * shortWeight;
  return r2((base + defrost + short) * 100) / 100;
}

// Pure: the setting to use now.
//   current { flowC, step, ntc }; bounds { flowMin, flowMax, steps: [0,1,2], ntcs: [0,1,2] };
//   roomBehindC: how far the room is below where it should be (0 = fine)
function choose(model, { outdoorC, rh, current, bounds = {}, roomBehindC = 0, defrostHigh = 1.5, exploreAfterRuns = 10 } = {}) {
  const w = `${tbin(outdoorC)}|${band(rh)}`;
  const here = Object.values(model || {}).filter((r) => r.weather === w);
  const cur = here.find((r) => keyOf(r.setting) === keyOf(current));
  const steps = bounds.steps || [0, 1, 2];
  const flowMin = bounds.flowMin ?? 25; const flowMax = bounds.flowMax ?? 45;
  const calmer = (s) => (s.step ?? 0) > (current.step ?? 0) || (Number.isFinite(s.flowC) && Number.isFinite(current.flowC) && s.flowC < current.flowC);
  const allowed = (s) => (!Number.isFinite(s.flowC) || (s.flowC >= flowMin && s.flowC <= flowMax)) && steps.includes(s.step ?? 0) && !(roomBehindC > 0.5 && calmer(s));
  const cand = here.filter((r) => allowed(r.setting));
  // the COP only counts when every setting compared (and the current one) has one
  const useCop = [...cand, ...(cur ? [cur] : [])].every((r) => r.cop > 0);
  const known = cand.map((r) => ({ ...r, score: score(r, { useCop }) })).sort((a, b) => a.score - b.score);
  const best = known[0];
  const copNote = useCop ? '' : ' (no power measured: compared on run length and defrosts only)';
  // a better setting is known for this weather: that one
  if (best && (!cur || best.score < score(cur, { useCop }) - 0.005)) return { setting: best.setting, why: `best known in this weather: ${best.runMin} min runs, ${best.defrostPerH} defrosts/h${useCop && best.cop ? `, COP ${best.cop}` : ''}${copNote}`, learned: true, weather: w, row: best, useCop };
  // nothing better known, but it defrosts a lot: try a calmer neighbour never tried in this weather
  if (cur && cur.defrostPerH >= defrostHigh && roomBehindC <= 0.5) {
    const tries = [
      { ...current, step: Math.min(Math.max(...steps), (current.step ?? 0) + 1) },
      ...(Number.isFinite(current.flowC) ? [{ ...current, flowC: current.flowC - 1 }] : []),
    ].filter((s) => keyOf(s) !== keyOf(current) && allowed(s) && !here.some((r) => keyOf(r.setting) === keyOf(s)));
    if (tries.length) return { setting: tries[0], why: 'defrosting a lot: trying a calmer setting', learned: false, weather: w };
  }
  if (cur) {
    // only one setting seen in this weather: nothing to compare with — say so instead of "best known"
    if (here.length < 2) {
      // enough runs of the current one and nothing else known: suggest trying a neighbour for a day, so the
      // advice gets something to compare with (only while the room keeps up; never a warmer flow)
      if (cur.runs >= exploreAfterRuns && roomBehindC <= 0.5) {
        const tries = [
          ...(Number.isFinite(current.flowC) ? [{ ...current, flowC: current.flowC - 1 }] : []),
          { ...current, step: Math.min(Math.max(...steps), (current.step ?? 0) + 1) },
          ...((bounds.ntcs || []).filter((n) => n !== (current.ntc ?? 0)).map((n) => ({ ...current, ntc: n }))),
        ].filter((s) => keyOf(s) !== keyOf(current) && allowed(s));
        if (tries.length) {
          const t = tries[0];
          const what = t.flowC !== current.flowC ? `flow ${t.flowC} °C instead of ${current.flowC} °C` : t.step !== (current.step ?? 0) ? `power step ${t.step} instead of ${current.step ?? 0}` : `outdoor sensor setting ${t.ntc} instead of ${current.ntc ?? 0}`;
          return { setting: current, explore: t, why: `only the current setting seen in this weather (${cur.runs} runs): try ${what} for a day, so there is something to compare with`, learned: false, weather: w, row: cur, useCop };
        }
      }
      return { setting: current, why: 'only the current setting seen in this weather: nothing to compare with yet', learned: false, weather: w, row: cur, useCop };
    }
    return { setting: current, why: `the current setting is the best known in this weather${copNote}`, learned: true, weather: w, row: cur, useCop };
  }
  return { setting: current, why: roomBehindC > 0.5 ? 'room behind: no calmer setting' : 'nothing learned yet in this weather: keep the current setting', learned: false, weather: w };
}

// Pure: does it stop too early? When runs follow each other after a short stop (the water cooled
// back below its start point within minutes), running ½–1 °C past its stop point gives one longer run
// instead of two short ones. -> { overshootC, shortShare, medianOffMin, why }
function overshoot(rs, { shortMin = 15, veryShortMin = 8, minRuns = 6 } = {}) {
  const offs = rs.map((r) => r.offBeforeMin).filter((x) => Number.isFinite(x) && x >= 0 && x < 240);
  if (offs.length < minRuns) return { overshootC: 0, why: 'too few runs to say' };
  const sorted = [...offs].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const shortShare = r2(offs.filter((x) => x < shortMin).length / offs.length);
  const overshootC = med < veryShortMin ? 1 : med < shortMin || shortShare >= 0.5 ? 0.5 : 0;
  return { overshootC, shortShare, medianOffMin: med, why: overshootC ? `restarts after ${med} min: run ${overshootC} °C past the stop point` : 'stops are long enough' };
}

module.exports = { runs, learn, score, choose, keyOf, overshoot };
