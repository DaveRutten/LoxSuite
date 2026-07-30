const db = require('./db');
const { fetchMiniserver } = require('./loxone');

// Loxone has no push/subscribe channel for its own log, so this polls and diffs against what was
// last seen — same tradeoff already accepted and documented for Loxone-direct Monitors. Confirmed
// real, documented endpoint (not guessed): GET /dev/fsget/log/def.log, Basic Auth, the same one
// LoxBerry's own Miniserver log widget uses.
const BACKFILL_LINES = 500;

const insertLogEntry = db.prepare('INSERT INTO log_entries (source, source_id, source_label, line, recorded_at) VALUES (?, ?, ?, ?, ?)');

// miniserver_id -> full def.log text last seen, so the next poll can diff against it instead of
// re-processing the whole file every time.
const lastContent = new Map();

const selectLastStoredLine = db.prepare(
  "SELECT line FROM log_entries WHERE source = 'loxone' AND source_id = ? ORDER BY id DESC LIMIT 1"
);

// miniserver_id -> ISO timestamp of the newest line already persisted, mirroring mosquittoLog.js's
// own restart-safe dedup — but Loxone's def.log lines aren't reliably timestamp-prefixed the way
// Mosquitto's are, so this diffs against raw content instead. lastContent itself is in-memory and
// does get wiped on every restart, but the "first contact this run" branch below reconstructs its
// starting point from what's already in the database rather than blindly re-backfilling — a plain
// restart used to re-insert up to BACKFILL_LINES duplicate rows every single time (confirmed: one
// real deployment accumulated a 15x duplication factor from routine restarts alone).
function newLines(miniserverId, fullText) {
  const previous = lastContent.get(miniserverId);
  lastContent.set(miniserverId, fullText);

  if (previous === undefined) {
    // First contact with this Miniserver this process's lifetime. If we've stored lines from it
    // before (an earlier run, before this restart), find the last one we already have and only
    // take what comes after it — otherwise fall back to a bounded tail, for genuinely first-ever
    // contact or if the log rotated far enough that our last-known line isn't in it anymore.
    const lastStored = selectLastStoredLine.get(miniserverId);
    if (lastStored) {
      const idx = fullText.lastIndexOf(lastStored.line);
      if (idx !== -1) return fullText.slice(idx + lastStored.line.length).split('\n').filter(Boolean);
    }
    return fullText.split('\n').filter(Boolean).slice(-BACKFILL_LINES);
  }
  if (fullText === previous) return [];
  if (fullText.startsWith(previous)) return fullText.slice(previous.length).split('\n').filter(Boolean);

  // The log rotated/reset on the Miniserver side (content no longer a superset of what we had) —
  // treat the whole new content as new rather than trying to guess an overlap.
  return fullText.split('\n').filter(Boolean);
}

async function pollMiniserver(miniserver) {
  try {
    const res = await fetchMiniserver(miniserver, '/dev/fsget/log/def.log', { timeoutMs: 15000 });
    if (!res.ok) throw new Error(`Miniserver responded with HTTP ${res.status}`);
    const text = await res.text();

    const lines = newLines(miniserver.id, text);
    if (lines.length === 0) return;

    const now = new Date().toISOString();
    const insertAll = db.transaction(() => {
      for (const line of lines) insertLogEntry.run('loxone', miniserver.id, miniserver.name, line, now);
    });
    insertAll();
  } catch (err) {
    console.error(`Failed to fetch Loxone log for miniserver ${miniserver.id} (${miniserver.name}):`, err.message);
  }
}

function pollAllMiniservers() {
  const miniservers = db.prepare('SELECT * FROM miniservers').all();
  miniservers.forEach(pollMiniserver);
}

module.exports = { pollAllMiniservers };
