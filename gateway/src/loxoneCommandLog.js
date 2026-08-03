// A durable, queryable trail of every Virtual Output command Loxone sends the gateway (UDP or
// HTTP), successful or rejected — powers Logs > Loxone commands. Reuses the same log_entries
// table as the other Logs tabs (see auditLog.js / loxoneLog.js) rather than a bespoke table, so
// it gets the existing retention purge and from/to/text filtering for free; command_topic,
// value_from and value_to (see db.js's migrateLogEntriesCommandColumns) are the source-specific
// structured fields this source alone populates.
const db = require('./db');

const insertLogEntry = db.prepare(
  `INSERT INTO log_entries (source, source_label, line, command_topic, value_from, value_to, source_id, transport, recorded_at)
   VALUES ('loxone_commands', ?, ?, ?, ?, ?, ?, ?, ?)`
);

const findMiniserverByHost = db.prepare('SELECT id, name FROM miniservers WHERE host = ?');

// In-memory only: the last value actually published through a Loxone-originated command, per
// MQTT topic — this is what lets a row show "Off" -> "On" instead of just "On" on its own.
// Resets on restart (same tradeoff loxoneLog.js's own diff-state already accepts) — a command
// right after a restart just shows no "From" until the next one for that topic.
const lastPublishedValue = new Map();

// The only things that ever send these commands are configured Loxone Miniservers, so showing
// the Miniserver's own name (matched by IP against the Miniservers page) is far more useful than
// a bare IP:port once more than one is configured — falls back to "<transport> <address>" when
// the sender's IP doesn't match any configured Miniserver's Host.
function describeClient(transport, address, port) {
  const miniserver = address ? findMiniserverByHost.get(address) : null;
  const location = port ? `${address}:${port}` : address || 'unknown';
  const label = miniserver ? `${miniserver.name} (${location})` : `${transport} ${location}`;
  // The composed label above drops the transport entirely once a Miniserver name is matched (it
  // reads "MiniserverName (host:port)", not "UDP MiniserverName (...)") — this pair is stored
  // alongside it precisely so that information survives, for the rejected row's own "+ Mapping"
  // button (Logs > Loxone commands) to pre-fill transport and Miniserver on the new mapping form.
  return { label, miniserverId: miniserver ? miniserver.id : null };
}

function logAccepted({ transport, address, port, topic, value }) {
  const { label, miniserverId } = describeClient(transport, address, port);
  const from = lastPublishedValue.has(topic) ? lastPublishedValue.get(topic) : null;
  lastPublishedValue.set(topic, value);
  insertLogEntry.run(label, 'OK', topic, from, value, miniserverId, transport, new Date().toISOString());
}

function logRejected({ transport, address, port, topic, attemptedValue, reason }) {
  const { label, miniserverId } = describeClient(transport, address, port);
  insertLogEntry.run(label, `Rejected: ${reason}`, topic ?? null, null, attemptedValue ?? null, miniserverId, transport, new Date().toISOString());
}

module.exports = { logAccepted, logRejected };
