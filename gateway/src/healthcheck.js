const db = require('./db');
const { fetchMiniserver, miniserverBaseUrl, insecureAgent } = require('./loxone');
const { checkMiniserverStatus, checkFirmwareChanged, checkGatewayClientFirmwareMismatch } = require('./notifications');
const { decrypt } = require('./secretCrypto');
const { recordMiniserverDiagValue } = require('./monitorCollector');
const { parseHeapStatus } = require('./format');
const { getStructure } = require('./loxoneStructure');

const TIMEOUT_MS = 4000;

// Tests one specific address directly (no local->external fallback — the whole point here is to
// report each candidate's own reachability separately, unlike fetchMiniserver's combined result
// used for the plain online/offline status).
async function testAddress(miniserver, base, dispatcher, path) {
  const auth = Buffer.from(`${miniserver.username}:${decrypt(miniserver.password)}`).toString('base64');
  const start = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { Authorization: `Basic ${auth}` },
      dispatcher,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - start;
    if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}` };
    return { ok: true, ms, error: null };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err.message };
  }
}

// Same shape as testAddress, but for /jdev/cfg/version specifically — a plain 200 on "/" only
// proves SOMETHING answered HTTP there (could be a captive portal, a different device entirely,
// or a Loxone Miniserver that's about to reject these exact credentials on every real API call).
// Checking the response actually parses as Loxone's own {"LL":{"value":...,"Code":"200"}} shape
// is what confirms this is genuinely a reachable Loxone API with working credentials, not just an
// open port.
async function testApiAddress(miniserver, base, dispatcher) {
  const auth = Buffer.from(`${miniserver.username}:${decrypt(miniserver.password)}`).toString('base64');
  const start = Date.now();
  try {
    const res = await fetch(`${base}/jdev/cfg/version`, {
      headers: { Authorization: `Basic ${auth}` },
      dispatcher,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - start;
    if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body?.LL?.value) return { ok: false, ms, error: "Reachable, but didn't look like a Loxone Miniserver's API response" };
    return { ok: true, ms, error: null, version: body.LL.value };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err.message };
  }
}

// Powers the Miniservers page's "Test now" feedback row — separate pass/fail for local reachability,
// external-URL reachability, the log endpoint specifically (a Miniserver can be reachable at all
// while /dev/fsget is blocked by a proxy/firewall in between, so this is worth showing on its own),
// and the Loxone API itself (distinct from "local"/"external" plain reachability — see
// testApiAddress above).
async function runDetailedCheck(miniserver) {
  const localBase = miniserverBaseUrl(miniserver);
  const localDispatcher = miniserver.use_https ? insecureAgent : undefined;
  const externalBase = miniserver.external_url ? miniserver.external_url.replace(/\/+$/, '') : null;

  const local = await testAddress(miniserver, localBase, localDispatcher, '/');
  const external = externalBase ? await testAddress(miniserver, externalBase, undefined, '/') : null;

  // Logbook/API re-test whichever address just succeeded (mirroring fetchMiniserver's own
  // local-then-external preference) rather than probing both again.
  const workingBase = local.ok ? localBase : (external && external.ok ? externalBase : null);
  const workingDispatcher = local.ok ? localDispatcher : undefined;
  const logbook = workingBase
    ? await testAddress(miniserver, workingBase, workingDispatcher, '/dev/fsget/log/def.log')
    : { ok: false, ms: 0, error: 'No reachable address to test it through' };
  const api = workingBase
    ? await testApiAddress(miniserver, workingBase, workingDispatcher)
    : { ok: false, ms: 0, error: 'No reachable address to test it through' };

  return { local, external, logbook, api };
}

// A single value read off a plain /jdev/... command — shared by fetchSystemStats below and
// firmware/PLC-state reading here. Every one of these commands is undocumented in Loxone's own
// official HTTP command reference (verified against the actual reference PDF and a
// community-reverse-engineered doc), but each was individually confirmed to return real 200s with
// real data directly against a live Miniserver before being wired in here — none of this was
// assumed from a name alone.
async function readSysValue(miniserver, path) {
  try {
    const res = await fetchMiniserver(miniserver, path, { timeoutMs: TIMEOUT_MS });
    if (!res.ok) return null;
    const body = await res.json();
    const value = body?.LL?.value;
    return value === undefined || value === null || value === '' ? null : String(value);
  } catch (err) {
    return null;
  }
}

// /jdev/cfg/version — was originally read from LoxAPP3.json's msInfo.swVersion, which turned out
// to not exist at all on at least one real Miniserver's structure file (confirmed by direct
// inspection: msInfo had 23 other keys, no swVersion among them) — silently null forever there
// regardless of how long the gateway ran, since nothing about that failure mode ever looks like an
// error. This dedicated command doesn't depend on the structure file at all.
function fetchFirmwareVersion(miniserver) {
  return readSysValue(miniserver, '/jdev/cfg/version');
}

// /jdev/sps/state — the Miniserver's own PLC run state. Loxone documents all 8 possible values
// (unlike the msInfo.deviceMonitor value this replaced, which had no documented meaning beyond
// "0 seems to mean healthy"): 0 no status, 1 booting, 2 program loaded, 3 started, 4 Loxone Link
// started, 5 running, 6 change in progress, 7 error, 8 update occurring. See PLC_STATE_LABELS in
// miniservers.ejs for how these render.
function fetchPlcState(miniserver) {
  return readSysValue(miniserver, '/jdev/sps/state');
}

// /jdev/sys/cpu, /jdev/sys/heap, /jdev/sys/numtasks, /jdev/cfg/versiondate — same
// undocumented-but-verified-working status as fetchFirmwareVersion/fetchPlcState above (e.g. cpu
// "14%", heap "478956/1016404kB", numtasks "64", versiondate "Jul 21 2026 17:23:12"). Fetched in
// parallel, each independently — one endpoint erroring shouldn't blank out the others.
async function fetchSystemStats(miniserver) {
  const [cpuLoad, heapStatus, numTasks, firmwareDate] = await Promise.all([
    readSysValue(miniserver, '/jdev/sys/cpu'),
    readSysValue(miniserver, '/jdev/sys/heap'),
    readSysValue(miniserver, '/jdev/sys/numtasks'),
    readSysValue(miniserver, '/jdev/cfg/versiondate'),
  ]);
  return { cpuLoad, heapStatus, numTasks, firmwareDate };
}

// msInfo.miniserverType, from the structure file rather than a dedicated /jdev/... command (no
// such command is known to exist for this). Unlike firmware_version/cpu_load/etc., a physical
// Miniserver's hardware generation never changes, so this only fetches while the column is still
// NULL — reuses loxoneStructure.js's own in-memory cache (already warm for free if the user has
// visited Live Data or Monitor's add-state picker for this Miniserver), and never re-fetches the
// full structure file just for this one field again afterward. Swallows any failure (offline,
// old firmware, malformed response) since a missing generation label is harmless — it just leaves
// the column NULL to retry on a later sweep.
async function fetchMiniserverType(miniserver) {
  if (miniserver.miniserver_type !== null && miniserver.miniserver_type !== undefined) return null;
  try {
    const structure = await getStructure(miniserver);
    const type = structure?.msInfo?.miniserverType;
    return Number.isInteger(type) ? type : null;
  } catch (err) {
    return null;
  }
}

async function checkMiniserver(miniserver) {
  const now = new Date().toISOString();

  try {
    // Any HTTP response (even 401/404) means the Miniserver is reachable.
    // Only a network-level failure (timeout, refused, DNS) counts as offline
    // — and fetchMiniserver already tries external_url as a fallback for that case.
    await fetchMiniserver(miniserver, '/', { timeoutMs: TIMEOUT_MS });
    const firmwareVersion = await fetchFirmwareVersion(miniserver);
    const plcState = await fetchPlcState(miniserver);
    const { cpuLoad, heapStatus, numTasks, firmwareDate } = await fetchSystemStats(miniserver);
    const miniserverType = await fetchMiniserverType(miniserver);
    // COALESCE keeps whatever was last successfully read if this particular sweep's fetch failed
    // — a hiccup reading any one of these shouldn't flip an otherwise-successful check's columns
    // back to unknown.
    db.prepare(
      `UPDATE miniservers SET status = ?, last_checked_at = ?, last_error = NULL,
       firmware_version = COALESCE(?, firmware_version), plc_state = COALESCE(?, plc_state),
       cpu_load = COALESCE(?, cpu_load), heap_status = COALESCE(?, heap_status), num_tasks = COALESCE(?, num_tasks),
       firmware_date = COALESCE(?, firmware_date), miniserver_type = COALESCE(?, miniserver_type)
       WHERE id = ?`
    ).run('online', now, firmwareVersion, plcState, cpuLoad, heapStatus, numTasks, firmwareDate, miniserverType, miniserver.id);
    checkMiniserverStatus(miniserver, 'online');
    // miniserver.firmware_version here is still this sweep's PRE-update value (miniserver is the
    // in-memory row checkAllMiniservers passed in, never mutated in place) — firmwareVersion above
    // is the freshly-fetched one, so this is exactly the before/after pair a change check needs.
    checkFirmwareChanged(miniserver, firmwareVersion);

    // Feeds any Monitor tracking one of these fields (source_type 'miniserver_diag') — a no-op
    // query if none exist for this Miniserver. Fed from THIS cycle's own fresh readings, not the
    // COALESCE'd fallback values just written above — a cycle that failed to read e.g. cpu_load
    // shouldn't re-feed a monitor with an unchanged reading it's already seen, just skip that one
    // field this time (recordMiniserverDiagValue no-ops on null/undefined already).
    recordMiniserverDiagValue(miniserver.id, 'cpu_load', cpuLoad !== null ? parseFloat(cpuLoad) : null);
    recordMiniserverDiagValue(miniserver.id, 'num_tasks', numTasks);
    const heap = parseHeapStatus(heapStatus);
    if (heap) {
      recordMiniserverDiagValue(miniserver.id, 'heap_value_kb', heap.firstKb);
      recordMiniserverDiagValue(miniserver.id, 'heap_total_kb', heap.totalKb);
    }
  } catch (err) {
    db.prepare('UPDATE miniservers SET status = ?, last_checked_at = ?, last_error = ? WHERE id = ?')
      .run('offline', now, err.message, miniserver.id);
    checkMiniserverStatus(miniserver, 'offline');
  }
}

async function checkAllMiniservers() {
  const miniservers = db.prepare('SELECT * FROM miniservers').all();
  await Promise.all(miniservers.map(checkMiniserver));
  // After every Miniserver's own row has this cycle's fresh firmware_version/plc_state — needs
  // the whole set settled first, since it compares pairs across two independent per-Miniserver
  // checks above rather than reacting to any single one's own result.
  checkGatewayClientFirmwareMismatch();
}

// Recursive setTimeout, not setInterval — re-reads gateway_settings.healthcheck_interval_seconds
// (Settings page) before scheduling each next run, so changing it there takes effect on the very
// next tick instead of needing a gateway restart. A plain setInterval would have locked in
// whatever interval was configured at startup.
function startHealthchecks() {
  let cancelled = false;
  async function tick() {
    await checkAllMiniservers();
    if (cancelled) return;
    const settings = db.prepare('SELECT healthcheck_interval_seconds FROM gateway_settings WHERE id = 1').get();
    const seconds = settings?.healthcheck_interval_seconds > 0 ? settings.healthcheck_interval_seconds : 60;
    setTimeout(tick, seconds * 1000);
  }
  tick();
  return () => { cancelled = true; };
}

module.exports = { checkMiniserver, checkAllMiniservers, startHealthchecks, runDetailedCheck };
