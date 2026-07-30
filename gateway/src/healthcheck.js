const db = require('./db');
const { fetchMiniserver, miniserverBaseUrl, insecureAgent } = require('./loxone');

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

async function checkMiniserver(miniserver) {
  const now = new Date().toISOString();

  try {
    // Any HTTP response (even 401/404) means the Miniserver is reachable.
    // Only a network-level failure (timeout, refused, DNS) counts as offline
    // — and fetchMiniserver already tries external_url as a fallback for that case.
    await fetchMiniserver(miniserver, '/', { timeoutMs: TIMEOUT_MS });
    db.prepare('UPDATE miniservers SET status = ?, last_checked_at = ?, last_error = NULL WHERE id = ?').run('online', now, miniserver.id);
  } catch (err) {
    db.prepare('UPDATE miniservers SET status = ?, last_checked_at = ?, last_error = ? WHERE id = ?')
      .run('offline', now, err.message, miniserver.id);
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
