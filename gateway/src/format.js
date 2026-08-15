// A topic's message count on Live Data (incoming-messages.ejs) is unbounded and in-memory only —
// a broker running for months without a restart, or a chatty sensor publishing every few seconds,
// can run this into the millions. Abbreviated (1.2K / 3.4M) past 1000 rather than printed as a raw
// digit string, the same convention most dashboards use for exactly this kind of ever-growing counter.
function formatCount(n) {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  const units = [
    { value: 1e9, suffix: 'B' },
    { value: 1e6, suffix: 'M' },
    { value: 1e3, suffix: 'K' },
  ];
  const unit = units.find((u) => abs >= u.value);
  const scaled = n / unit.value;
  // No decimal at all once the scaled value is already 2+ digits (e.g. 12M, not 12.0M) — the
  // decimal only earns its place while it's the only thing distinguishing e.g. 1.2K from 1K, and
  // Number#toString() already drops a trailing ".0" on its own (3 not 3.0).
  const formatted = Math.abs(scaled) >= 10 ? Math.round(scaled).toString() : (Math.round(scaled * 10) / 10).toString();
  return `${formatted}${unit.suffix}`;
}

// The Miniserver's own /jdev/sys/heap reports "usedOrFree/totalkB" (e.g. "478956/1016404kB") —
// Loxone doesn't document which of the two numbers the first one is, so this only rescales kB to
// MB for readability without asserting an interpretation, keeping both numbers in the same
// left/right order the Miniserver itself returned them in.
function formatHeapStatus(raw) {
  if (!raw) return null;
  const match = /^(\d+)\/(\d+)kB$/.exec(raw.trim());
  if (!match) return raw;
  const a = Math.round(Number(match[1]) / 1024);
  const b = Math.round(Number(match[2]) / 1024);
  return `${a} MB / ${b} MB`;
}

// Same "usedOrFree/totalkB" string as formatHeapStatus above, but returning the two raw kB
// numbers rather than a display string — used to feed a miniserver_diag monitor's heap_free_kb/
// heap_total_kb fields (see monitorCollector.js's recordMiniserverDiagValue), which need actual
// numbers to chart, not formatted text.
function parseHeapStatus(raw) {
  if (!raw) return null;
  const match = /^(\d+)\/(\d+)kB$/.exec(raw.trim());
  if (!match) return null;
  return { firstKb: Number(match[1]), totalKb: Number(match[2]) };
}

// msInfo.miniserverType from /data/LoxAPP3.json — confirmed against Loxone's own official
// Structure File documentation (V17.0, msInfo section), not guessed. Falls back to showing the
// raw number for any value outside this documented range rather than asserting a label that isn't
// backed by the docs.
const MINISERVER_TYPE_LABELS = {
  0: 'Miniserver (Gen 1)',
  1: 'Miniserver Go (Gen 1)',
  2: 'Miniserver (Gen 2)',
  3: 'Miniserver Go (Gen 2)',
  4: 'Miniserver Compact',
};
function miniserverGenerationLabel(type) {
  if (type === null || type === undefined) return null;
  return MINISERVER_TYPE_LABELS[type] || `Unknown (type ${type})`;
}

// jdev/sps/state's own fully-documented 0-8 values — [label, badge class] per code. Was previously
// duplicated inline in miniservers.ejs; pulled out here once the new Tabulator-backed JSON endpoint
// (routes/miniservers.js) needed the exact same mapping server-side instead of just EJS-side.
const PLC_STATE_LABELS = {
  0: ['No status', 'badge-neutral'],
  1: ['Booting', 'badge-neutral'],
  2: ['Program loaded', 'badge-neutral'],
  3: ['Started', 'badge-neutral'],
  4: ['Loxone Link started', 'badge-neutral'],
  5: ['Running', 'badge-ok'],
  6: ['Change in progress', 'badge-neutral'],
  7: ['Error', 'badge-off'],
  8: ['Update occurring', 'badge-neutral'],
};
function plcStateLabel(code) {
  return PLC_STATE_LABELS[code] || null;
}

// Loxone's /data/status (see loxoneHardware.js) reports a device's own TimeDiff as whole seconds
// since it was last heard from, rather than a timestamp — converting that back to a wall-clock
// time and re-diffing against "now" on every page render would just reintroduce clock-skew issues
// Loxone's own number already avoids, so this formats the seconds directly instead.
function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// Mosquitto's own $SYS/broker/bytes/{received,sent} (see mqttClient.js's getBrokerStats) are plain
// byte counts, unlike backup.js's own file sizes (already read as a whole number of bytes too, but
// shown via a client-side Tabulator column formatter instead — this one instead needs to render
// server-side inside an EJS template, so it gets its own plain helper here rather than duplicating
// that JS-side one or trying to share it across a server/browser boundary).
function formatBytes(n) {
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  const units = [
    { value: 1024 ** 3, suffix: 'GB' },
    { value: 1024 ** 2, suffix: 'MB' },
    { value: 1024, suffix: 'KB' },
  ];
  const unit = units.find((u) => abs >= u.value);
  const scaled = n / unit.value;
  const formatted = Math.abs(scaled) >= 10 ? Math.round(scaled).toString() : (Math.round(scaled * 10) / 10).toString();
  return `${formatted} ${unit.suffix}`;
}

module.exports = { formatCount, formatBytes, formatHeapStatus, parseHeapStatus, miniserverGenerationLabel, formatDuration, PLC_STATE_LABELS, plcStateLabel };
