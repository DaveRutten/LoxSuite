const fs = require('fs');
const db = require('./db');
const { checkMqttClientStatus } = require('./notifications');

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
// Mosquitto logs this exact line once per broker process start — stable wording since well before
// 2.x, so it doubles as a reliable in-band "the broker restarted here" marker (see processLine()'s
// own use of it as a hard reset point for `clients`, not just a line to record/skip).
const BROKER_START_RE = /^mosquitto version \S+ starting$/;

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
//
// Starts undefined, not fetched here at module load — this used to be a synchronous db.prepare()
// read done the instant the module loaded, safe when the DB was an already-open better-sqlite3
// handle; the async facade means it can't be read until db.init() has resolved, so it's loaded once
// by startTailing() below (the actual entry point, always called after boot) instead.
let lastPersistedAt;

async function recordLogLine(line, ts) {
  if (lastPersistedAt && ts <= lastPersistedAt) return;
  await insertLogEntry.run('mqtt', null, line, ts);
  lastPersistedAt = ts;
}

// startTailing() replays the whole log from byte 0 on every gateway restart (see its own comment)
// — without this guard, that replay would fire a notification for every connect/disconnect in the
// entire log history on every single restart, not just genuinely new ones. Flips to true once the
// first poll() (the full backlog replay) finishes; every connect/disconnect matched after that is
// live/new and fires normally.
let replayComplete = false;

async function processLine(line) {
  const lineMatch = line.match(LINE_RE);
  // A genuine Mosquitto line always starts with its own Unix-timestamp prefix — anything else
  // (a stray write to the log file from outside Mosquitto itself, a wrapped continuation of a
  // multi-line message, ...) isn't a real log entry and would otherwise show up with a fabricated
  // "now" timestamp and no useful content, e.g. a bare "hello" with nothing else to say about it.
  if (!lineMatch) return;
  const ts = new Date(Number(lineMatch[1]) * 1000).toISOString();
  await recordLogLine(line, ts);

  const rest = lineMatch[2];

  // Mosquitto and the gateway restart in lockstep (same container, same docker-entrypoint.sh) — any
  // TCP session that was open under a PREVIOUS broker process is unconditionally dead the instant
  // this line appears, whether or not its own disconnect line ever got logged (a killed container
  // doesn't get to log one). Clearing right here, mid-replay, instead of only once after the whole
  // first poll() finishes (see markReplayComplete() below, which used to also blanket-flip every
  // still-"connected" entry) is what fixes a real bug: a device quick enough to reconnect before
  // Node's very first poll() catches up gets its fresh "New client connected" line processed in the
  // SAME replay batch as this marker — a post-hoc "wipe everyone still connected" pass run once at
  // the end of that batch couldn't tell that fresh line apart from a genuine pre-boot leftover, so
  // it wiped both, leaving an already-reconnected device stuck showing "Disconnected" until its
  // NEXT reconnect. Resetting exactly when a restart is seen means every CONNECT line processed
  // after this point is unambiguously live, however soon after boot it happened to log.
  if (BROKER_START_RE.test(rest)) {
    clients.clear();
    return;
  }

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
    if (replayComplete) await checkMqttClientStatus(username || null, 'connected');
    return;
  }

  const disconnectMatch = rest.match(DISCONNECT_RE);
  if (disconnectMatch) {
    const existing = clients.get(disconnectMatch[1]);
    if (existing) {
      existing.disconnectedAt = ts;
      existing.status = 'disconnected';
      if (replayComplete) await checkMqttClientStatus(existing.username, 'disconnected');
    }
  }
}

// The very first replay covers the log's entire history. Stale pre-boot "connected" entries are
// already handled inline in processLine() the moment a broker-restart line is seen (see
// BROKER_START_RE's own comment there) — this now only flips the notification gate: the first
// full-backlog replay would otherwise fire a notification for every connect/disconnect in the
// entire log history, not just genuinely new ones, once this boot's own live tailing begins.
function markReplayComplete() {
  replayComplete = true;
}

function poll() {
  fs.stat(LOG_PATH, (err, stats) => {
    if (err) return;
    if (stats.size < position) position = 0; // log file was rotated/truncated
    if (stats.size === position) { markReplayComplete(); return; }

    const stream = fs.createReadStream(LOG_PATH, { start: position, end: stats.size - 1, encoding: 'utf8' });
    let buffer = '';
    stream.on('data', (chunk) => { buffer += chunk; });
    stream.on('end', () => {
      position = stats.size;
      const lines = buffer.split('\n').filter(Boolean);
      // Sequential, not Promise.all — each line's own recordLogLine() depends on lastPersistedAt
      // reflecting every line already processed before it, and connect/disconnect state (clients
      // map) needs to see them in the same order Mosquitto actually logged them.
      (async () => {
        for (const line of lines) await processLine(line);
        markReplayComplete();
      })().catch((error) => console.error('Failed to process Mosquitto log lines:', error));
    });
  });
}

async function startTailing(intervalMs = 2000) {
  // Loaded once here (not at module load — see lastPersistedAt's own comment above) rather than
  // lazily inside recordLogLine(), since this is the one place already guaranteed to run after
  // db.init() has resolved (see server.js's own async bootstrap) and only ever needs to happen once
  // regardless of how many log lines get processed afterward.
  const row = await db.prepare("SELECT MAX(recorded_at) AS ts FROM log_entries WHERE source = 'mqtt'").get();
  lastPersistedAt = row.ts;

  // Start at 0 and replay the whole log once, so clients that connected before
  // this gateway process started (e.g. across a restart) still show up as
  // connected instead of being invisible until their next reconnect.
  position = 0;
  poll();
  // unref(): a background poller shouldn't be the thing keeping the process alive on its own — the
  // real server has plenty else doing that (the HTTP listener, MQTT client, ...), and this is what
  // lets a test (or any one-off script) that calls startTailing() exit cleanly on its own instead
  // of hanging on this interval forever.
  setInterval(poll, intervalMs).unref();
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

// Same "only disconnected" rule as clearClients(), just automatic and age-based instead of a
// manual all-at-once click — each removal is logged (source='system') so there's a durable trail
// of what got dropped and when, since the Connected Clients list itself is in-memory only.
async function pruneDisconnectedClients(hours) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const now = new Date().toISOString();

  for (const [id, client] of clients) {
    if (client.status === 'connected' || !client.disconnectedAt) continue;
    if (new Date(client.disconnectedAt).getTime() > cutoff) continue;

    clients.delete(id);
    const label = client.username ? `${client.clientId} (user '${client.username}')` : client.clientId;
    await insertLogEntry.run(
      'system',
      null,
      `Removed disconnected MQTT client ${label} from Client Activity — disconnected since ${client.disconnectedAt}, older than the ${hours}h retention.`,
      now
    );
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

module.exports = { startTailing, getClients, clearClients, pruneDisconnectedClients, getLastSeenByUsername };
