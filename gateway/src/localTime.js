// Small time-zone helpers for the Wallbox features (planner, learning, agenda): everything is
// stored in UTC, but "today", "weekday", "07:00" and "the hour of the day" are local to the
// display time zone (Settings), like everything else LoxSuite shows.
const { zonedMidnight } = require('./ocppExport');

function displayTz() {
  try { return require('./dateFormat').getDisplayTimezone() || 'UTC'; } catch { return 'UTC'; }
}

// { y, m, d, hour, minute, weekday (0 = Monday … 6 = Sunday) } of an instant in a time zone.
// The formatter is made once per time zone and the answer kept per minute: creating an
// Intl.DateTimeFormat per call made learning over weeks of minute samples take tens of seconds.
const formatters = new Map();
const partsCache = new Map();
const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
function localParts(ms, tz = displayTz()) {
  const key = `${tz}|${Math.floor(ms / 60000)}`;
  const hit = partsCache.get(key);
  if (hit) return { ...hit };
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    formatters.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const out = { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute, weekday: WD[p.weekday] };
  if (partsCache.size > 200000) partsCache.clear();
  partsCache.set(key, out);
  return { ...out };
}

// Epoch ms of local midnight of the day `ms` falls in (plus `addDays`).
function localMidnight(ms, tz = displayTz(), addDays = 0) {
  const p = localParts(ms, tz);
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d + addDays));
  return zonedMidnight(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), tz) * 1000;
}

// Epoch ms of a local wall-clock time ("07:15") on the day `dayMs` falls in.
function localTimeOn(dayMs, hhmm, tz = displayTz()) {
  const [h, mi] = String(hhmm).split(':').map(Number);
  const mid = localMidnight(dayMs, tz);
  // Walk from midnight; DST days are 23/25 h long, so re-check the local hour.
  let t = mid + ((h || 0) * 60 + (mi || 0)) * 60000;
  const p = localParts(t, tz);
  if (p.hour !== (h || 0)) t += ((h || 0) - p.hour) * 3600000;
  return t;
}

// "HH:MM" of an instant in the time zone.
function hhmm(ms, tz = displayTz()) {
  const p = localParts(ms, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

module.exports = { displayTz, localParts, localMidnight, localTimeOn, hhmm, WEEKDAYS };
