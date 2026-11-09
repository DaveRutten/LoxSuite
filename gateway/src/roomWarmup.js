// How long the heat pump needs to bring the room to temperature, by the outdoor temperature (example for
// the Heat pump module, see docs/voorstel-energiemodules.md). Next to temperature.js, which learns how
// fast the room cools down when the heat pump is off: this learns how fast it warms up when it heats.
//
//   learn        from minute samples [{ ms, roomC, outdoorC, heating, targetC? }]: every stretch of up to
//                two hours of uninterrupted heating while the room is still below its target gives a rise
//                in °C per hour (the slope through all its samples, not first − last: with a 0.1 °C room
//                sensor and 30-minute windows only 0 or 0.2 °C/h could come out); per outdoor temperature
//                (2 °C bins) the median
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
function learn(samples, { windowMin = 120, minWindowMin = 60, minWindows = 3, belowTargetC = 0.3 } = {}) {
  const S = (samples || []).filter((s) => Number.isFinite(s.roomC) && Number.isFinite(s.outdoorC));
  const per = new Map();
  let i = 0;
  while (i < S.length) {
    // only while it really warms the room up: a heating stretch that starts at the target only holds it
    const behind = (x) => !Number.isFinite(x.targetC) || x.roomC < x.targetC - belowTargetC;
    if (!S[i].heating || !behind(S[i])) { i++; continue; }
    // a window of uninterrupted heating, no gaps of more than 5 minutes
    let j = i;
    while (j + 1 < S.length && S[j + 1].heating && S[j + 1].ms - S[j].ms <= 5 * MIN && S[j + 1].ms - S[i].ms <= windowMin * MIN) j++;
    const dtH = (S[j].ms - S[i].ms) / HOUR;
    if (dtH >= minWindowMin / 60) {
      // least squares through every sample of the window
      const W = S.slice(i, j + 1);
      const mx = W.reduce((a, s) => a + s.ms, 0) / W.length, my = W.reduce((a, s) => a + s.roomC, 0) / W.length;
      const sxx = W.reduce((a, s) => a + (s.ms - mx) ** 2, 0), sxy = W.reduce((a, s) => a + (s.ms - mx) * (s.roomC - my), 0);
      const rate = sxx > 0 ? (sxy / sxx) * HOUR : 0;
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
  while (need > 1e-6 && used < maxH - 1e-9) {
    const hStart = t - HOUR;
    const rt = rate(model, outdoorAt(hStart)).rate;
    const take = Math.min(need, rt);
    t -= (take / rt) * HOUR;
    need -= take;
    used += take / rt;
  }
  const startMs = Math.round(t - marginMin * MIN);
  const hours = r2((atMs - startMs) / HOUR);
  // capped: even maxH hours of heating don't get it there (it was cut off silently before); late: the start
  // lies in the past — both mean comfort is not reached in time
  const capped = need > 0.05;
  const late = startMs < nowMs;
  const reason = capped ? `${r2(comfortC - fromC)} °C to go: not reached within ${maxH} h at the learned warm-up rate (about ${r2(need)} °C short)`
    : `${r2(comfortC - fromC)} °C to go, about ${r2(used)} h at the expected outdoor temperatures`;
  return { startMs, hours, late, capped, shortC: capped ? r2(need) : 0, reason };
}

// Pure: the comfort schedule from the room controller's target temperature (as Loxone's own schedule
// sets it): per weekday when the target goes up to comfort and when it comes down again.
//   samples [{ ms, targetC }] in order, localOf(ms) -> { day, hour, minute, weekday }
//   -> { comfortC, setbackC, days: { weekday: { from: 'HH:MM', until: 'HH:MM', n } }, all: { from, until } }
function learnSchedule(samples, localOf, { minDays = 2, minSpanDays = 13, minShare = 0.5 } = {}) {
  const ok = (samples || []).filter((x) => Number.isFinite(x.targetC));
  // the target without the room controller's own solar offset, when the sample has it
  const tgt = (x) => (Number.isFinite(x.offsetC) && x.offsetC > 0 ? x.targetC - x.offsetC : x.targetC);
  const ts = ok.map(tgt).sort((a, b) => a - b);
  if (ts.length < 60) return null;
  // at least two weeks: a few sunny afternoons in a short history looked like a comfort schedule
  if (ok[ok.length - 1].ms - ok[0].ms < minSpanDays * 86400000) return null;
  const lo = ts[Math.floor(ts.length * 0.1)];
  // comfort = the most common value in the upper half, not the 90th percentile (a short solar offset of
  // a few degrees was taken as the comfort temperature)
  const hi90 = ts[Math.floor(ts.length * 0.9)];
  const upper = ts.filter((x) => x >= (lo + hi90) / 2).map((x) => Math.round(x * 4) / 4);
  const counts = new Map(); for (const x of upper) counts.set(x, (counts.get(x) || 0) + 1);
  const hi = upper.length ? [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0] : hi90;
  if (!(hi - lo >= 0.5)) return { comfortC: lo, setbackC: lo, days: {}, all: null, flat: true };
  const mid = (hi + lo) / 2;
  const perDay = new Map();
  let prev = null;
  for (const x of samples) {
    if (!Number.isFinite(x.targetC)) continue;
    const l = localOf(x.ms);
    const d = perDay.get(l.day) || { weekday: l.weekday, from: null, until: null };
    const up = tgt(x) >= mid;
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
  // a real comfort schedule comes back on most days; warmer moments on a few days only (solar offsets,
  // someone turning it up) are no schedule: then flat on the usual value
  if (all.length < perDay.size * minShare) return { comfortC: r2(lo), setbackC: r2(lo), days: {}, all: null, flat: true, irregular: true };
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
function forecast(model, { startC, hours, k = 0.02, hystC = 0.3, stepMin = 5 }) {
  // in steps of a few minutes, not whole hours: with a warm-up of ~0.5 °C/h a dip of 0.3 °C is made up
  // within the same hour, and "on" and "at temperature" then fell on the same hour mark
  const n = Math.max(1, Math.round(60 / stepMin));
  let room = startC;
  let on = false;
  const runs = [];
  const rows = [];
  for (const h of hours) {
    if (!Number.isFinite(room) || !Number.isFinite(h.targetC)) { if (on) { runs[runs.length - 1].offAt = h.ms; on = false; } rows.push({ ms: h.ms, roomC: null, on: false }); continue; }
    const out = Number.isFinite(h.outdoorC) ? h.outdoorC : 8;
    let onMin = 0;
    for (let i = 0; i < n; i++) {
      const t = h.ms + (i * HOUR) / n;
      if (!on && room < h.targetC - hystC) { on = true; runs.push({ onAt: t, reachAt: null, offAt: null, fromC: r2(room), toC: h.targetC }); }
      if (on) {
        const r = rate(model, out).rate / n;
        const before = room;
        room = Math.min(h.targetC, room + r);
        onMin += 60 / n;
        if (room >= h.targetC - 0.05) {
          on = false;
          const run = runs[runs.length - 1];
          run.reachAt = Math.round(t + Math.min(1, (h.targetC - before) / Math.max(1e-6, r)) * (HOUR / n));
          run.offAt = run.reachAt;
        }
      } else room -= (k / n) * (room - out);
    }
    rows.push({ ms: h.ms, roomC: r2(room), on: on || onMin > 0, onMin: Math.round(onMin) });
  }
  // the warm-up worth showing: the first run that lifts the room noticeably (a comfort step), else the first
  const main = runs.find((x) => x.toC - x.fromC > hystC + 0.2) || runs[0] || null;
  return { rows, runs, onAt: main ? Math.round(main.onAt) : null, reachAt: main && main.reachAt !== null ? main.reachAt : null };
}

// Pure: the house as a battery. In hours with solar to spare the room may be a little warmer (heating)
// or cooler (cooling) than its target, so the free power is stored in the house instead of exported.
//   hours [{ ms, targetC, room, surplusKwh }] -> the same, shifted ones with room 'solar' and fromC
function solarShift(hours, { cooling = false, boostC = 0.5, minSurplusKwh = 1 } = {}) {
  if (!(boostC > 0)) return hours;
  return hours.map((h) => {
    if (!Number.isFinite(h.targetC) || !(h.surplusKwh >= minSurplusKwh)) return h;
    // the more sun to spare, the more it stores, up to boostC
    const k = Math.min(1, h.surplusKwh / (minSurplusKwh * 2));
    const d = Math.round(boostC * k * 10) / 10;
    if (!(d > 0)) return h;
    return { ...h, fromC: h.targetC, targetC: Math.round((h.targetC + (cooling ? -d : d)) * 10) / 10, room: 'solar' };
  });
}

module.exports = { solarShift, learn, rate, warmupHours, preheat, learnSchedule, learnCooling, forecast, tbin };
