const fs = require('fs');
const db = require('./db');

const LOG_PATH = process.env.MOSQUITTO_LOG_PATH || '/mosquitto/log/mosquitto.log';

// Best-effort parsing of Mosquitto's own log lines — the exact wording is
// specific to Mosquitto 2.x and may shift between versions.
const LINE_RE = /^(\d+): (.*)$/;
const CONNECT_RE = /New client connected from ([\d.]+):(\d+) as (\S+) \(p\d+, c\d+, k\d+(?:, u'([^']*)')?\)\.?/;
// Mosquitto 2.x logs the client's address in brackets between the id and the reason
// (e.g. "Client foo [1.2.3.4:5678] disconnected: connection closed by client.") — the
// bracketed part is optional here so this still matches older/alternate wordings that
// omit it (e.g. a keepalive timeout disconnect logged without an address).
const DISCONNECT_RE = /Client (\S+) (?:\[[^\]]*\] )?(?:disconnected|has exceeded timeout, disconnecting|closed its connection)/;

const clients = new Map();
let position = 0;

const insertLogEntry = db.prepare('INSERT INTO log_entries (source, source_label, line, recorded_at) VALUES (?, ?, ?, ?)');

// startTailing() below replays the whole log file from byte 0 on every gateway restart (on
// purpose, for the in-memory `clients` map below) — without this guard, persisting every line
// as-is would re-insert the entire historical log as duplicates on every restart. Using the log's
// own embedded timestamp (not "now") as recorded_at, and skipping anything at or before the
// newest timestamp already persisted for this source, makes replay naturally idempotent: old
// lines all have timestamps <= what's already stored and get skipped, only genuinely new ones
// (or the very first run's full backlog) get inserted.
let lastPersistedAt = db.prepare("SELECT MAX(recorded_at) AS ts FROM log_entries WHERE source = 'mqtt'").get().ts;

function recordLogLine(line, ts) {
  if (lastPersistedAt && ts <= lastPersistedAt) return;
  insertLogEntry.run('mqtt', null, line, ts);
  lastPersistedAt = ts;
}

function processLine(line) {
  const lineMatch = line.match(LINE_RE);
  const ts = lineMatch ? new Date(Number(lineMatch[1]) * 1000).toISOString() : new Date().toISOString();
  recordLogLine(line, ts);

  if (!lineMatch) return;
  const rest = lineMatch[2];

  const connectMatch = rest.match(CONNECT_RE);
  if (connectMatch) {
    const [, ip, port, clientId, username] = connectMatch;
    clients.set(clientId, {
      clientId,
      address: `${ip}:${port}`,
      username: username || null,
      connectedAt: ts,
      disconnectedAt: null,
      status: 'connected',
    });
    return;
  }

  const disconnectMatch = rest.match(DISCONNECT_RE);
  if (disconnectMatch) {
    const existing = clients.get(disconnectMatch[1]);
    if (existing) {
      existing.disconnectedAt = ts;
      existing.status = 'disconnected';
    }
  }
}

function poll() {
  fs.stat(LOG_PATH, (err, stats) => {
    if (err) return;
    if (stats.size < position) position = 0; // log file was rotated/truncated
    if (stats.size === position) return;

    const stream = fs.createReadStream(LOG_PATH, { start: position, end: stats.size - 1, encoding: 'utf8' });
    let buffer = '';
    stream.on('data', (chunk) => { buffer += chunk; });
    stream.on('end', () => {
      position = stats.size;
      buffer.split('\n').filter(Boolean).forEach(processLine);
    });
  });
}

function startTailing(intervalMs = 2000) {
  // Start at 0 and replay the whole log once, so clients that connected before
  // this gateway process started (e.g. across a restart) still show up as
  // connected instead of being invisible until their next reconnect.
  position = 0;
  poll();
  setInterval(poll, intervalMs);
}

function getClients() {
  return Array.from(clients.values()).sort((a, b) => (b.connectedAt || '').localeCompare(a.connectedAt || ''));
}

// Only drops disconnected entries. A client that's still actually connected
// won't send a new "connected" log line just because we cleared our view, so
// removing it here would make it vanish permanently instead of reappearing.
function clearClients() {
  for (const [id, client] of clients) {
    if (client.status !== 'connected') clients.delete(id);
  }
}

// Collapses the clientId-keyed `clients` map down to one entry per MQTT *username* (dynamic
// security roles/ACLs are per-username, not per-client-id, and one username can reconnect under a
// new client id) — used by the MQTT Users page to show when an account was last active. Same
// in-memory-only, since-gateway-start caveat as getClients() above: this has no history beyond
// what's been tailed from the current mosquitto.log.
function getLastSeenByUsername() {
  const byUsername = new Map();
  for (const client of clients.values()) {
    if (!client.username) continue;
    const at = client.status === 'connected' ? client.connectedAt : (client.disconnectedAt || client.connectedAt);
    const candidate = { at, status: client.status };
    const existing = byUsername.get(client.username);

    if (!existing) {
      byUsername.set(client.username, candidate);
    } else if (candidate.status === 'connected' && existing.status !== 'connected') {
      byUsername.set(client.username, candidate); // an active session always outranks a past one
    } else if (candidate.status === existing.status && candidate.at > existing.at) {
      byUsername.set(client.username, candidate);
    }
  }
  return byUsername;
}

module.exports = { startTailing, getClients, clearClients, getLastSeenByUsername };
