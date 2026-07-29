const db = require('./db');
const { fetchMiniserver } = require('./loxone');

const TIMEOUT_MS = 4000;

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

module.exports = { checkMiniserver, checkAllMiniservers, startHealthchecks };
