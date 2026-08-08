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

module.exports = { logSystemEvent };
