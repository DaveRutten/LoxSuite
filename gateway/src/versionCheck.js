// Checks GitHub's public tags API for this project once at boot and then once a day — no auth
// token, so this only ever works for a public repo, and fails silently (falls back to "no update
// info", not an error shown anywhere) for a private one, a network hiccup, or a repo with no tags
// yet. Deliberately a plain string inequality against the newest tag rather than a real semver
// comparison: this project's own version is still pre-1.0 alpha, where "which one is newer" is
// far less useful to know than simply "the tag you're running doesn't match the latest one
// upstream — go take a look" (a manual downgrade/rollback is a perfectly normal thing to have
// running here, not a mistake to warn about as if it were behind).
const REPO = 'DaveRutten/LoxSuite';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let currentVersion = '0.0.0';
try {
  currentVersion = require('../package.json').version;
} catch {
  // package.json always exists in a real deployment — only unreachable in an odd test harness.
}

const state = { currentVersion, latestVersion: null, updateAvailable: false, checkedAt: null };

function normalize(tag) {
  return String(tag || '').replace(/^v/i, '').trim();
}

async function checkForUpdate() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/tags`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'LoxSuite' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return; // private repo (404), rate-limited (403), etc. — leave state as-is
    const tags = await res.json();
    const latest = Array.isArray(tags) && tags.length > 0 ? normalize(tags[0].name) : null;
    if (latest) {
      state.latestVersion = latest;
      state.updateAvailable = latest !== normalize(state.currentVersion);
    }
  } catch {
    // Offline, DNS failure, timeout, ... — the version number itself still always renders fine
    // without this, so a failed check is just silently skipped rather than surfaced anywhere.
  } finally {
    state.checkedAt = new Date().toISOString();
  }
}

function getVersionStatus() {
  return state;
}

function startVersionCheck() {
  checkForUpdate();
  setInterval(checkForUpdate, CHECK_INTERVAL_MS);
}

module.exports = { getVersionStatus, startVersionCheck };
