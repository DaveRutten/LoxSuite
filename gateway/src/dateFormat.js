// Every date/time in the UI is rendered in the gateway's configured display timezone (Settings),
// not whatever timezone the server process or the viewer's browser happen to report — both were
// found reporting UTC on a real deployment despite the user being in CEST, which silently showed
// every timestamp two hours off with nothing about it looking wrong. Defaults to UTC (always
// correct, just possibly not locally convenient) until set otherwise.
const db = require('./db');

let cachedTimezone = null;

function getDisplayTimezone() {
  if (cachedTimezone === null) {
    const row = db.prepare('SELECT display_timezone FROM gateway_settings WHERE id = 1').get();
    cachedTimezone = row?.display_timezone || 'UTC';
  }
  return cachedTimezone;
}

// Called after Settings saves a new value — otherwise the old timezone would keep being used
// (from this module-level cache) until the next gateway restart.
function invalidateTimezoneCache() {
  cachedTimezone = null;
}

// Matches the DD/MM/YYYY, HH:MM:SS shape every view already used via toLocaleString('en-GB'),
// just computed in the configured timezone instead of the ambient one.
function formatDateTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: getDisplayTimezone(),
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(date).replace(',', ',');
  } catch (err) {
    // An invalid IANA name saved somehow (hand-edited DB, typo survived validation) — fall back to
    // UTC rather than 500ing every page that renders a date.
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(date);
  }
}

// Inverse of formatDateTime() above: a wall-clock date/time typed by a user (e.g. a Monitor
// detail custom-range field, "1-8-2026") means that moment in the configured display timezone,
// not the server's own (always UTC in Docker) — parsing it with a bare `new Date(...)` would
// silently shift it by the timezone offset, same class of bug formatDateTime's own header comment
// describes. There's no library like moment-timezone/luxon here to do this in one call, so it
// works the standard way without one: format a first guess (treating the wall-clock values as UTC)
// back into the target timezone, measure how far off that lands from the original wall-clock
// values, and shift the guess by exactly that much. One pass is enough except right at the instant
// of a DST transition, where this can be off by the transition's own size (usually 1h) — an
// acceptable edge case for picking a chart range, not worth a second refinement pass over.
function parseInTimezone(year, month, day, hour, minute, second, tz) {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(guessMs)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  } catch (err) {
    return guessMs; // invalid IANA name — fall back to treating it as UTC, same as formatDateTime()
  }
  // Midnight can format as "24:00" in some locales/engines instead of "00:00" — normalize so the
  // Date.UTC below doesn't build an invalid extra hour.
  const seenHour = parts.hour === '24' ? 0 : Number(parts.hour);
  const seenAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), seenHour, Number(parts.minute), Number(parts.second));
  return guessMs - (seenAsUtc - guessMs);
}

module.exports = { getDisplayTimezone, invalidateTimezoneCache, formatDateTime, parseInTimezone };
