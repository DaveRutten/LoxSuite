// A durable trail for security/administrative events — logins (success and failure), user and
// role management, SSO configuration changes, Miniserver and Settings changes — alongside the
// existing System log entries (MQTT client auto-pruning). Deliberately reuses that same log
// rather than a separate page/table: one more place to check would work against "I want to be
// able to find everything back", not for it.
const db = require('./db');

const insertLogEntry = db.prepare('INSERT INTO log_entries (source, source_label, line, recorded_at) VALUES (?, ?, ?, ?)');

async function logSystemEvent(message) {
  await insertLogEntry.run('system', null, message, new Date().toISOString());
}

// Builds a human-readable "field: old → new" diff for a settings/Miniserver update's own
// logSystemEvent() call, so the System log shows what actually changed instead of a bare
// "updated X." — every route that saves a settings-style row can share this rather than
// hand-rolling its own comparison. `fields` is [{key, label, secret}]; `secret` fields (passwords,
// API keys) only ever report that they changed, never the actual old/new value. Compared via
// String() rather than strict equality since a freshly-parsed form value (e.g. "1"/true) and a
// stored DB value (e.g. 1) don't always share the same JS type — this is a display diff, not a
// correctness check, so a loose comparison is exactly what avoids false "changed" noise from that.
function describeChanges(oldRow, newRow, fields) {
  const format = (v) => (v === null || v === undefined || v === '') ? '(none)' : String(v);
  const parts = [];
  for (const f of fields) {
    const oldVal = oldRow ? oldRow[f.key] : undefined;
    const newVal = newRow[f.key];
    if (format(oldVal) === format(newVal)) continue;
    parts.push(f.secret ? `${f.label} changed` : `${f.label}: ${format(oldVal)} → ${format(newVal)}`);
  }
  return parts.join(', ');
}

module.exports = { logSystemEvent, describeChanges };
