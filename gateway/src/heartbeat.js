// Dead-man's-switch: pings an external watchdog URL (healthchecks.io, Uptime Kuma push, ...) on a
// fixed interval so that the ABSENCE of pings — the one signal LoxSuite can't send about itself
// once it's down — is what alerts you. Deliberately an outward GET rather than anything routed
// through the notification channels, since a dead gateway can't notify you through its own
// channels. Config lives in gateway_settings (migration 016), re-read live each tick so a change
// in Settings takes effect without a restart. Wired up in server.js's boot sequence.
const db = require('./db');
const { logSystemEvent } = require('./auditLog');

const TICK_MS = 60 * 1000; // check once a minute; actually ping only when the interval is due
const PING_TIMEOUT_MS = 10000;

// Pure decision so a test can pin the timing without real timers or network. Enabled = a non-empty
// URL plus a positive interval; due = at least that interval has elapsed since the last ping
// (lastPingAt 0 = "never pinged", so the first tick after enabling fires promptly). A disabled or
// misconfigured heartbeat is never due.
function heartbeatDue({ url, intervalMinutes, lastPingAt, now }) {
  if (!url || !String(url).trim()) return false;
  const mins = Number(intervalMinutes);
  if (!Number.isFinite(mins) || mins <= 0) return false;
  return now - (lastPingAt || 0) >= mins * 60 * 1000;
}

let lastPingAt = 0;

async function tick(fetchImpl = fetch) {
  let settings;
  try {
    settings = await db.prepare('SELECT heartbeat_url, heartbeat_interval_minutes FROM gateway_settings WHERE id = 1').get();
  } catch {
    return; // DB not ready / transient — just wait for the next tick
  }
  const url = (settings?.heartbeat_url || '').trim();
  if (!url) { lastPingAt = 0; return; } // disabled — reset so re-enabling pings promptly
  if (!heartbeatDue({ url, intervalMinutes: settings?.heartbeat_interval_minutes, lastPingAt, now: Date.now() })) return;

  lastPingAt = Date.now();
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // Logged, not thrown — a failed heartbeat ping is exactly the temporary condition the external
    // watchdog exists to notice; nothing here should crash the ticker over it.
    await logSystemEvent(`Heartbeat ping to the configured watchdog URL failed: ${err.message}`);
  }
}

function startHeartbeat() {
  const timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
}

module.exports = { startHeartbeat, heartbeatDue, tick };
