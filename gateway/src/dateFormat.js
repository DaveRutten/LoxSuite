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

module.exports = { getDisplayTimezone, invalidateTimezoneCache, formatDateTime };
