const db = require('./db');
const { pollAllMiniservers } = require('./loxoneLog');

const LOXONE_POLL_MS = 60000; // matches healthcheck.js's own Miniserver polling cadence
const RETENTION_TICK_MS = 60 * 60 * 1000;

function purgeOldLogEntries() {
  const settings = db.prepare('SELECT log_retention_days FROM gateway_settings WHERE id = 1').get();
  const days = settings?.log_retention_days ?? 14;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM log_entries WHERE recorded_at < ?').run(cutoff);
}

function startLogCollector() {
  purgeOldLogEntries();
  setInterval(purgeOldLogEntries, RETENTION_TICK_MS);

  pollAllMiniservers();
  setInterval(pollAllMiniservers, LOXONE_POLL_MS);
}

module.exports = { startLogCollector };
