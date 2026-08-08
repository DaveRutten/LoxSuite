const db = require('./db');
const { pollAllMiniservers } = require('./loxoneLog');
const { pruneDisconnectedClients } = require('./mosquittoLog');

const LOXONE_POLL_MS = 60000; // matches healthcheck.js's own Miniserver polling cadence
const RETENTION_TICK_MS = 60 * 60 * 1000;

async function purgeOldLogEntries() {
  const settings = await db.prepare('SELECT log_retention_days FROM gateway_settings WHERE id = 1').get();
  const days = settings?.log_retention_days ?? 14;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare('DELETE FROM log_entries WHERE recorded_at < ?').run(cutoff);
}

async function purgeOldNotificationEvents() {
  const settings = await db.prepare('SELECT notification_retention_days FROM gateway_settings WHERE id = 1').get();
  const days = settings?.notification_retention_days ?? 90;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare('DELETE FROM notification_events WHERE created_at < ?').run(cutoff);
}

async function pruneOldClients() {
  const settings = await db.prepare('SELECT client_retention_hours FROM gateway_settings WHERE id = 1').get();
  await pruneDisconnectedClients(settings?.client_retention_hours ?? 24);
}

async function startLogCollector() {
  await purgeOldLogEntries();
  setInterval(purgeOldLogEntries, RETENTION_TICK_MS);

  await purgeOldNotificationEvents();
  setInterval(purgeOldNotificationEvents, RETENTION_TICK_MS);

  await pruneOldClients();
  setInterval(pruneOldClients, RETENTION_TICK_MS);

  await pollAllMiniservers();
  setInterval(pollAllMiniservers, LOXONE_POLL_MS);
}

module.exports = { startLogCollector };
