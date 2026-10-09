// How long the heat pump needs to bring the room to temperature, by the outdoor temperature (example for
// the Heat pump module, see docs/voorstel-energiemodules.md). Next to temperature.js, which learns how
// fast the room cools down when the heat pump is off: this learns how fast it warms up when it heats.
//
//   learn        from minute samples [{ ms, roomC, outdoorC, heating }]: every half hour of uninterrupted
//                heating gives a rise in °C per hour; per outdoor temperature (2 °C bins) the median
//   rate         °C per hour expected at this outdoor temperature: the bin, its neighbours, the line
//                through all bins, or a careful start value
//   warmupHours  hours from one room temperature to another at that outdoor temperature
//   preheat      when to start so the room has its comfort temperature at the time it is wanted, with the
//                forecast outdoor temperature of the hours before it, and a margin
const HOUR = 3600000;
const MIN = 60000;
const r2 = (x) => Math.round(x * 100) / 100;
const tbin = (c) => Math.floor(c / 2) * 2;
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Pure: the learned warm-up rates.
function learn(samples, { windowMin = 30, minWindows = 3 } = {}) {
  const S = (samples || []).filter((s) => Number.isFinite(s.roomC) && Number.isFinite(s.outdoorC));
  const per = new Map();
  let i = 0;
  while (i < S.length) {
    if (!S[i].heating) { i++; continue; }
    // a window of uninterrupted heating, no gaps of more than 5 minutes
    let j = i;
    while (j + 1 < S.length && S[j + 1].heating && S[j + 1].ms - S[j].ms <= 5 * MIN && S[j + 1].ms - S[i].ms <= windowMin * MIN) j++;
    const dtH = (S[j].ms - S[i].ms) / HOUR;
    if (dtH >= (windowMin * 0.8) / 60) {
      const rate = (S[j].roomC - S[i].roomC) / dtH;
      const out = S.slice(i, j + 1).reduce((a, s) => a + s.outdoorC, 0) / (j - i + 1);
      if (rate > -0.5 && rate < 5) { const k = tbin(out); per.set(k, [...(per.get(k) || []), rate]); }
    }
    i = j + 1;
  }
  const bins = {};
  for (const [k, rates] of per) if (rates.length >= minWindows) bins[k] = { t: k, rate: r2(median(rates)), windows: rates.length };
  // a straight line through the bins (rate falls when it is colder) for temperatures not seen yet
  const pts = Object.values(bins);
  let line = null;
  if (pts.length >= 2) {
    const mx = pts.reduce((a, p) => a + p.t + 1, 0) / pts.length; const my = pts.reduce((a, p) => a + p.rate, 0) / pts.length;
    const sxx = pts.reduce((a, p) => a + (p.t + 1 - mx) ** 2, 0); const sxy = pts.reduce((a, p) => a + (p.t + 1 - mx) * (p.rate - my), 0);
    if (sxx > 0) line = { a: r2(my - (sxy / sxx) * mx), b: Math.round((sxy / sxx) * 1000) / 1000 };
  }
  return { bins, line, windows: [...per.values()].reduce((a, x) => a + x.length, 0) };
}

// Pure: °C per hour at this outdoor temperature (never below 0.1: a heat pump always gets somewhere).
function rate(model, outdoorC, { start = 0.5 } = {}) {
  if (!Number.isFinite(outdoorC)) return { rate: start, learned: false };
  const b = model?.bins || {};
  const k = tbin(outdoorC);
  const hit = b[k] || b[k - 2] || b[k + 2];
  if (hit) return { rate: Math.max(0.1, hit.rate), learned: true, from: `${hit.t}..${hit.t + 2} °C` };
  if (model?.line) return { rate: Math.max(0.1, r2(model.line.a + model.line.b * outdoorC)), learned: true, from: 'line' };
  return { rate: start, learned: false };
}

// Pure: hours from fromC to toC (0 when already there).
function warmupHours(model, { fromC, toC, outdoorC }) {
  if (!(toC > fromC)) return 0;
  return r2((toC - fromC) / rate(model, outdoorC).rate);
}

// Pure: the latest start for comfortC at atMs. roomC = now (or the expected room temperature by then:
// fromC), outdoorAt(ms) = forecast; walks back hour by hour with the rate of each hour, plus a margin.
function preheat(model, { atMs, nowMs, fromC, comfortC, outdoorAt = () => null, marginMin = 15, maxH = 8 }) {
  if (!(comfortC > fromC)) return { startMs: atMs, hours: 0, reason: 'already warm enough' };
  let need = comfortC - fromC;
  let t = atMs;
  let used = 0;
  while (need > 1e-6 && used < maxH) {
    const hStart = t - HOUR;
    const rt = rate(model, outdoorAt(hStart)).rate;
    const take = Math.min(need, rt);
    t -= (take / rt) * HOUR;
    need -= take;
    used += take / rt;
  }
  const startMs = Math.round(t - marginMin * MIN);
  const hours = r2((atMs - startMs) / HOUR);
  return { startMs, hours, late: startMs < nowMs, reason: `${r2(comfortC - fromC)} °C to go, about ${r2(used)} h at the expected outdoor temperatures` };
}

// Pure: the comfort schedule from the room controller's target temperature (as Loxone's own schedule
// sets it): per weekday when the target goes up to comfort and when it comes down again.
//   samples [{ ms, targetC }] in order, localOf(ms) -> { day, hour, minute, weekday }
//   -> { comfortC, setbackC, days: { weekday: { from: 'HH:MM', until: 'HH:MM', n } }, all: { from, until } }
function learnSchedule(samples, localOf, { minDays = 2 } = {}) {
  const ts = (samples || []).map((x) => x.targetC).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < 60) return null;
  const hi = ts[Math.floor(ts.length * 0.9)]; const lo = ts[Math.floor(ts.length * 0.1)];
  if (!(hi - lo >= 0.5)) return { comfortC: hi, setbackC: lo, days: {}, all: null, flat: true };
  const mid = (hi + lo) / 2;
  const perDay = new Map();
  let prev = null;
  for (const x of samples) {
    if (!Number.isFinite(x.targetC)) continue;
    const l = localOf(x.ms);
    const d = perDay.get(l.day) || { weekday: l.weekday, from: null, until: null };
    const up = x.targetC >= mid;
    if (prev !== null && up && !prev && d.from === null) d.from = l.hour * 60 + l.minute;
    if (prev !== null && !up && prev) d.until = l.hour * 60 + l.minute;
    perDay.set(l.day, d);
    prev = up;
  }
  const med = (xs) => { const s2 = xs.filter(Number.isFinite).sort((a, b) => a - b); return s2.length ? s2[Math.floor(s2.length / 2)] : null; };
  const hhmm = (m) => (m === null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const days = {};
  for (let wd = 0; wd < 7; wd++) {
    const ds = [...perDay.values()].filter((d) => d.weekday === wd && d.from !== null);
    if (ds.length >= Math.min(minDays, 1)) days[wd] = { from: hhmm(med(ds.map((d) => d.from))), until: hhmm(med(ds.map((d) => d.until))), n: ds.length };
  }
  const all = [...perDay.values()].filter((d) => d.from !== null);
  return { comfortC: r2(hi), setbackC: r2(lo), days, all: all.length ? { from: hhmm(med(all.map((d) => d.from))), until: hhmm(med(all.map((d) => d.until))) } : null };
}

// Pure: how fast the room cools down when the heat pump is off: k in dT/h = k × (room − outside), the
// median over the hours without heating (temperature.js does the same for a consumer's own signal).
function learnCooling(samples, { minHours = 6 } = {}) {
  const S = (samples || []).filter((s) => !s.heating && Number.isFinite(s.roomC) && Number.isFinite(s.outdoorC));
  const ks = [];
  for (let i = 0; i + 60 < S.length; i += 60) {
    const a = S[i], b = S[i + 60];
    if (b.ms - a.ms > 70 * MIN || S.slice(i, i + 61).some((x) => x.heating)) continue;
    const diff = a.roomC - a.outdoorC;
    if (diff < 3) continue;
    const k = (a.roomC - b.roomC) / diff;
    if (k > -0.01 && k < 0.2) ks.push(Math.max(0, k));
  }
  if (ks.length < minHours) return { k: 0.02, learned: false, n: ks.length };
  return { k: Math.round(median(ks) * 10000) / 10000, learned: true, n: ks.length };
}

// Pure: the room hour by hour — heating (the learned rate at that hour's outdoor temperature) when it is
// below its target minus the hysteresis, else cooling down towards outside. Where the heat pump is expected
// to come on and when the room reaches its target.
//   hours [{ ms, targetC, outdoorC }] -> { rows: [{ ms, roomC, on }], onAt, reachAt }
function forecast(model, { startC, hours, k = 0.02, hystC = 0.3 }) {
  let room = startC;
  let on = false; let onAt = null; let reachAt = null;
  const rows = [];
  for (const h of hours) {
    if (!Number.isFinite(room) || !Number.isFinite(h.targetC)) { rows.push({ ms: h.ms, roomC: null, on: false }); continue; }
    const out = Number.isFinite(h.outdoorC) ? h.outdoorC : 8;
    if (!on && room < h.targetC - hystC) { on = true; if (onAt === null) onAt = h.ms; }
    if (on) {
      const r = rate(model, out).rate;
      const before = room;
      room = Math.min(h.targetC, room + r);
      if (room >= h.targetC - 0.05) { on = false; if (reachAt === null && onAt !== null) reachAt = h.ms + Math.min(1, (h.targetC - before) / r) * HOUR; }
    } else {
      room -= k * (room - out);
    }
    rows.push({ ms: h.ms, roomC: r2(room), on });
  }
  return { rows, onAt, reachAt: reachAt === null ? null : Math.round(reachAt) };
}

module.exports = { learn, rate, warmupHours, preheat, learnSchedule, learnCooling, forecast, tbin };
