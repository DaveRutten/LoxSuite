const db = require('./db');
const { fetchMiniserver, miniserverBaseUrl, insecureAgent } = require('./loxone');
const { checkMiniserverStatus } = require('./notifications');
const { getStructure } = require('./loxoneStructure');

const TIMEOUT_MS = 4000;

// Tests one specific address directly (no local->external fallback — the whole point here is to
// report each candidate's own reachability separately, unlike fetchMiniserver's combined result
// used for the plain online/offline status).
async function testAddress(miniserver, base, dispatcher, path) {
  const auth = Buffer.from(`${miniserver.username}:${miniserver.password}`).toString('base64');
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

// Powers the Miniservers page's "Test now" feedback row — separate pass/fail for local reachability,
// external-URL reachability, and the log endpoint specifically (a Miniserver can be reachable at all
// while /dev/fsget is blocked by a proxy/firewall in between, so this is worth showing on its own).
async function runDetailedCheck(miniserver) {
  const localBase = miniserverBaseUrl(miniserver);
  const localDispatcher = miniserver.use_https ? insecureAgent : undefined;
  const externalBase = miniserver.external_url ? miniserver.external_url.replace(/\/+$/, '') : null;

  const local = await testAddress(miniserver, localBase, localDispatcher, '/');
  const external = externalBase ? await testAddress(miniserver, externalBase, undefined, '/') : null;

  // Logbook re-tests whichever address just succeeded (mirroring fetchMiniserver's own
  // local-then-external preference) rather than probing both again.
  const workingBase = local.ok ? localBase : (external && external.ok ? externalBase : null);
  const workingDispatcher = local.ok ? localDispatcher : undefined;
  const logbook = workingBase
    ? await testAddress(miniserver, workingBase, workingDispatcher, '/dev/fsget/log/def.log')
    : { ok: false, ms: 0, error: 'No reachable address to test it through' };

  return { local, external, logbook };
}

// The Miniserver's firmware version lives in LoxAPP3.json's msInfo block, not behind a plain
// /jdev/cfg/* call — newer firmware gates /jdev/cfg/* endpoints behind the token-based
// /jdev/sys/getkey2 auth flow (plain Basic auth silently gets nothing useful back there), while
// /data/LoxAPP3.json accepts the same Basic auth every other Miniserver read in this app already
// uses. Reuses loxoneStructure's own cache (getMonitorableStates/getRoomCategoryTree already rely
// on the exact same fetch+cache), so every healthcheck after the very first one for a given
// Miniserver reads this for free instead of re-fetching the (potentially large) structure file on
// every 60s sweep. swVersion is an array (e.g. [12, 3, 4, 20]) on some firmware and a plain string
// on others — normalized to a dotted string either way.
async function fetchFirmwareVersion(miniserver) {
  try {
    const structure = await getStructure(miniserver);
    const swVersion = structure?.msInfo?.swVersion;
    if (Array.isArray(swVersion)) return swVersion.join('.');
    if (typeof swVersion === 'string' && swVersion) return swVersion;
    return null;
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
    if (firmwareVersion) {
      db.prepare('UPDATE miniservers SET status = ?, last_checked_at = ?, last_error = NULL, firmware_version = ? WHERE id = ?')
        .run('online', now, firmwareVersion, miniserver.id);
    } else {
      db.prepare('UPDATE miniservers SET status = ?, last_checked_at = ?, last_error = NULL WHERE id = ?').run('online', now, miniserver.id);
    }
    checkMiniserverStatus(miniserver, 'online');
  } catch (err) {
    db.prepare('UPDATE miniservers SET status = ?, last_checked_at = ?, last_error = ? WHERE id = ?')
      .run('offline', now, err.message, miniserver.id);
    checkMiniserverStatus(miniserver, 'offline');
  }
}

async function checkAllMiniservers() {
  const miniservers = db.prepare('SELECT * FROM miniservers').all();
  await Promise.all(miniservers.map(checkMiniserver));
}

function startHealthchecks(intervalMs = 60000) {
  checkAllMiniservers();
  return setInterval(checkAllMiniservers, intervalMs);
}

module.exports = { checkMiniserver, checkAllMiniservers, startHealthchecks, runDetailedCheck };
