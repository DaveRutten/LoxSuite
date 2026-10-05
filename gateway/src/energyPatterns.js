// Patterns in the use of a consumer (energy manager): when it usually runs, for how long and how
// much — learned from its own meter (load_hourly) and its measured runs (load_runs).
//
//   daily    the same hours (almost) every day, e.g. tap water every evening ~19:00-20:00
//   weekly   the same hours on one weekday, e.g. the heat pump boost on Sunday morning
//   run      appliance runs that start at about the same time, e.g. washer Saturday ~10:00, 2 h, 1.1 kWh
//   follows  one appliance usually starts shortly after another ended, e.g. dryer ~40 min after washer
//
// The energy manager uses them (shadow mode) to have tap water hot before its usual use, to expect
// an appliance's usual run and plan its best start around it, and to expect consumption in those
// hours. Everything here is pure: the caller passes the measurements and a localOf(ms) ->
// { day: 'YYYY-MM-DD', hour, minute, weekday (0 = Monday) }.
const HOUR = 3600000;
const DAY = 86400000;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const r2 = (x) => Math.round(x * 100) / 100;

function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Consecutive hours (0..23) of a set into blocks [{ from, to }] (to = last hour + 1).
function blocks(hours) {
  const sorted = [...new Set(hours)].sort((a, b) => a - b);
  const out = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && last.to === h) last.to = h + 1; else out.push({ from: h, to: h + 1 });
  }
  return out;
}

// Hour profile from hourly kWh: per hour of the day (all days) and per weekday + hour, how often it
// was in use (share of the observed days) and the average kWh when it was.
// hourly: [{ hour: ISO, kwh }] (hours without a row = 0). Observed days: first measurement up to
// yesterday (today is still running).
function profile({ hourly, localOf, nowMs, threshold = 0.1 }) {
  const rows = (hourly || []).filter((r) => Number.isFinite(Number(r.kwh)));
  const empty = () => Array.from({ length: 24 }, () => ({ active: 0, kwh: 0 }));
  const daily = empty();
  const weekly = Array.from({ length: 7 }, empty);
  const today = localOf(nowMs).day;
  const firstMs = rows.length ? Math.min(...rows.map((r) => Date.parse(r.hour))) : null;
  const days = new Set(); const perWeekday = Array(7).fill(0);
  if (firstMs !== null) {
    for (let t = firstMs; t < nowMs; t += DAY) {
      const l = localOf(t);
      if (l.day === today || days.has(l.day)) continue;
      days.add(l.day); perWeekday[l.weekday] += 1;
    }
  }
  for (const r of rows) {
    const ms = Date.parse(r.hour);
    const l = localOf(ms);
    if (!days.has(l.day)) continue;
    const kwh = Number(r.kwh);
    if (kwh < threshold) continue;
    daily[l.hour].active += 1; daily[l.hour].kwh += kwh;
    weekly[l.weekday][l.hour].active += 1; weekly[l.weekday][l.hour].kwh += kwh;
  }
  const fin = (slot, n) => ({ p: n ? r2(slot.active / n) : 0, kwh: slot.active ? r2(slot.kwh / slot.active) : 0 });
  return {
    days: days.size, perWeekday,
    daily: daily.map((s) => fin(s, days.size)),
    weekly: weekly.map((w, wd) => w.map((s) => fin(s, perWeekday[wd]))),
  };
}

// Daily and weekly hour patterns from a profile.
function hourPatterns(prof, { minProb = 0.6, minDays = 7, minWeeks = 3, lift = 0.3 } = {}) {
  const out = [];
  if (prof.days < minDays) return out;
  const hot = prof.daily.map((s, h) => (s.p >= minProb ? h : null)).filter((h) => h !== null);
  if (hot.length && hot.length <= 16) { // in use almost all day is not a pattern, it's the base load
    for (const b of blocks(hot)) {
      const hs = prof.daily.slice(b.from, b.to);
      out.push({ type: 'daily', from: b.from, to: b.to, probability: r2(Math.min(...hs.map((s) => s.p))), kwh: r2(hs.reduce((a, s) => a + s.p * s.kwh, 0)) });
    }
  }
  for (let wd = 0; wd < 7; wd++) {
    if (prof.perWeekday[wd] < minWeeks) continue;
    const w = prof.weekly[wd];
    const hs = w.map((s, h) => (s.p >= minProb && s.p >= prof.daily[h].p + lift ? h : null)).filter((h) => h !== null);
    for (const b of blocks(hs)) {
      const sl = w.slice(b.from, b.to);
      out.push({ type: 'weekly', weekday: wd, from: b.from, to: b.to, probability: r2(Math.min(...sl.map((s) => s.p))), kwh: r2(sl.reduce((a, s) => a + s.p * s.kwh, 0)) });
    }
  }
  return out;
}

// Appliance runs that start at about the same time: per weekday (±1 h), or every day.
// runs: [{ start_at, end_at, kwh }]
function runPatterns({ runs, localOf, nowMs, weeks = 8, minCount = 3, minShare = 0.5 }) {
  const from = nowMs - weeks * 7 * DAY;
  const rs = (runs || []).map((r) => ({ s: Date.parse(r.start_at), e: Date.parse(r.end_at), kwh: Number(r.kwh) || 0 })).filter((r) => r.s >= from && r.e > r.s);
  if (rs.length < minCount) return [];
  const firstMs = Math.min(...rs.map((r) => r.s));
  // How many of each weekday (and days in all) the measurements cover.
  const seen = new Set(); const perWd = Array(7).fill(0);
  for (let t = firstMs; t <= nowMs; t += DAY) { const l = localOf(t); if (!seen.has(l.day)) { seen.add(l.day); perWd[l.weekday] += 1; } }
  const occurrences = (wd) => Math.max(1, wd === null ? seen.size : perWd[wd]);
  const min = (ms) => { const l = localOf(ms); return l.hour * 60 + l.minute; };
  const out = [];
  const used = new Set();
  const consider = (wd) => {
    const pool = rs.filter((r) => !used.has(r) && (wd === null || localOf(r.s).weekday === wd));
    // The densest 2-hour window of start times.
    let best = null;
    for (const a of pool) {
      const m = min(a.s);
      const group = pool.filter((r) => Math.abs(min(r.s) - m) <= 60);
      if (!best || group.length > best.length) best = group;
    }
    if (!best || best.length < minCount) return;
    const days = new Set(best.map((r) => localOf(r.s).day)).size;
    const of = occurrences(wd);
    if (days / of < minShare) return;
    best.forEach((r) => used.add(r));
    const startMin = Math.round(median(best.map((r) => min(r.s))));
    out.push({
      type: 'run', weekday: wd, hour: Math.floor(startMin / 60), minute: startMin % 60,
      durationH: r2(median(best.map((r) => (r.e - r.s) / HOUR))), kwh: r2(median(best.map((r) => r.kwh))), count: days, of,
    });
  };
  consider(null); // every day first, then per weekday with what is left
  for (let wd = 0; wd < 7; wd++) consider(wd);
  return out;
}

// "B usually starts shortly after A ended": runsByLoad { id: [{ start_at, end_at }] }.
function followPatterns(runsByLoad, { withinH = 3, minCount = 3, minShare = 0.5 } = {}) {
  const out = [];
  const ids = Object.keys(runsByLoad);
  for (const a of ids) {
    const ra = runsByLoad[a].map((r) => ({ s: Date.parse(r.start_at), e: Date.parse(r.end_at) }));
    if (ra.length < minCount) continue;
    for (const b of ids) {
      if (a === b) continue;
      const rb = runsByLoad[b].map((r) => Date.parse(r.start_at));
      const gaps = [];
      for (const r of ra) { const next = rb.filter((s) => s >= r.e - 10 * 60000 && s <= r.e + withinH * HOUR).sort((x, y) => x - y)[0]; if (next !== undefined) gaps.push((next - r.e) / 60000); }
      if (gaps.length >= minCount && gaps.length / ra.length >= minShare) out.push({ type: 'follows', from: Number(a), to: Number(b), gapMin: Math.max(0, Math.round(median(gaps))), count: gaps.length, of: ra.length });
    }
  }
  return out;
}

// Everything for one load.
function findPatterns({ kind, hourly, runs, localOf, nowMs }) {
  const prof = profile({ hourly, localOf, nowMs });
  const patterns = kind === 'appliance' ? runPatterns({ runs, localOf, nowMs }) : hourPatterns(prof);
  return { days: prof.days, profile: prof, patterns };
}

// Expected kWh of a load in the hour starting at ms (weekday profile when there are enough weeks).
function expectedKwh(prof, ms, localOf, { minWeeks = 3 } = {}) {
  if (!prof || !prof.days) return 0;
  const l = localOf(ms);
  const s = prof.perWeekday[l.weekday] >= minWeeks ? prof.weekly[l.weekday][l.hour] : prof.daily[l.hour];
  return r2(s.p * s.kwh);
}

// Next moment (ms, within [fromMs, toMs)) a weekly/daily run pattern comes round.
function nextOccurrence(p, fromMs, toMs, localOf) {
  for (let t = Math.floor(fromMs / HOUR) * HOUR; t < toMs; t += HOUR) {
    const l = localOf(t);
    if (l.hour === p.hour && (p.weekday === null || p.weekday === undefined || l.weekday === p.weekday)) return t + (p.minute || 0) * 60000;
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
// Plain English line for the page (the view translates the weekday and the template).
function describe(p, names = {}) {
  const day = p.weekday === null || p.weekday === undefined ? 'every day' : WEEKDAYS[p.weekday];
  if (p.type === 'daily') return `Every day ${pad(p.from)}:00–${pad(p.to)}:00, ${Math.round(p.probability * 100)}% of the days, ~${p.kwh} kWh`;
  if (p.type === 'weekly') return `${WEEKDAYS[p.weekday]} ${pad(p.from)}:00–${pad(p.to)}:00, ${Math.round(p.probability * 100)}% of the weeks, ~${p.kwh} kWh`;
  if (p.type === 'run') return `${day === 'every day' ? 'Every day' : day} ~${pad(p.hour)}:${pad(p.minute)}, ${p.durationH} h, ${p.kwh} kWh (${p.count} of ${p.of})`;
  if (p.type === 'follows') return `${names[p.to] || `#${p.to}`} usually starts ~${p.gapMin} min after ${names[p.from] || `#${p.from}`} (${p.count} of ${p.of})`;
  return '';
}

module.exports = { WEEKDAYS, profile, hourPatterns, runPatterns, followPatterns, findPatterns, expectedKwh, nextOccurrence, describe, blocks };
