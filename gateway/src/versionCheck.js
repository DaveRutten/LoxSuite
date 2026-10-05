// Checks GitHub's public tags API for this project once at boot and then once a day — no auth
// token, so this only ever works for a public repo, and fails silently (falls back to "no update
// info", not an error shown anywhere) for a private one, a network hiccup, or a repo with no tags
// yet. The newest tag is picked by version number, not by GitHub's list order: several tags pushed
// at once (v0.33.0, v0.33.1, v0.34.0) otherwise could report an older one as "available" while a
// newer one runs. An update only shows when the newest tag is really newer than this version.
const { checkLoxSuiteUpdate } = require('./notifications');

const REPO = 'DaveRutten/LoxSuite';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let currentVersion = '0.0.0';
try {
  currentVersion = require('../package.json').version;
} catch {
  // package.json always exists in a real deployment — only unreachable in an odd test harness.
}

const state = {
  currentVersion, latestVersion: null, updateAvailable: false, checkedAt: null,
  changelog: null, // this version's own CHANGELOG.md section, see fetchChangelogSection below
  changelogHtml: null, // same, rendered — see markdownToHtml below
  // Distinguishes "the GitHub call itself failed" (network/DNS/timeout/rate-limit/private repo)
  // from "it succeeded but came back with nothing usable" (no tags published yet) — both leave
  // latestVersion null, but they're different situations to tell an admin about (see
  // admin-general.ejs) rather than blaming "offline" for a repo that's simply never been tagged.
  lastCheckReached: null,
};

function normalize(tag) {
  return String(tag || '').replace(/^v/i, '').trim();
}

// [major, minor, patch, pre] of "0.34.0-alpha.1"; pre = null for a release (newer than any alpha).
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(normalize(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] || null] : null;
}

// > 0 when a is newer than b. Pre-release parts compare per dot-part, numbers as numbers.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  if (x[3] === y[3]) return 0;
  if (x[3] === null) return 1;
  if (y[3] === null) return -1;
  const p = x[3].split('.');
  const q = y[3].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const n = /^\d+$/.test(p[i]) && /^\d+$/.test(q[i]);
    const d = n ? Number(p[i]) - Number(q[i]) : p[i].localeCompare(q[i]);
    if (d) return d;
  }
  return 0;
}

// The newest tag name by version number (tags that aren't versions are ignored).
function newestTag(tags) {
  let best = null;
  for (const t of Array.isArray(tags) ? tags : []) {
    const name = t && t.name;
    if (!name || !parseVersion(name)) continue;
    if (!best || compareVersions(name, best) > 0) best = name;
  }
  return best;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Deliberately not a general-purpose markdown library — this only ever renders our own
// CHANGELOG.md, whose format is small and consistent (### headers, "- " bullets that can wrap
// onto continuation lines, **bold**, `code`), so a tailored ~20-line converter covers it exactly
// rather than pulling in a dependency for one feature.
function markdownToHtml(markdown) {
  const inline = (text) => escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') // consumes ** pairs first so the *text* rule below can't misfire on their leftover single asterisks
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

  const lines = markdown.split('\n');
  const html = [];
  let inList = false;
  const closeList = () => { if (inList) { html.push('</ul>'); inList = false; } };

  lines.forEach((line) => {
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    const bullet = line.match(/^-\s+(.*)/);
    if (heading) {
      closeList();
      html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    } else if (bullet) {
      if (!inList) { html.push('<ul>'); inList = true; }
      html.push(`<li>${inline(bullet[1])}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else if (inList) {
      // A continuation line of the previous bullet (CHANGELOG.md wraps long bullets across
      // several lines, indented) — appended into that <li> rather than starting a new one.
      html[html.length - 1] = html[html.length - 1].replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
    } else {
      html.push(`<p>${inline(line.trim())}</p>`);
    }
  });
  closeList();
  return html.join('\n');
}

// CHANGELOG.md's own headers look like "## [0.6.1-alpha.1] - 2026-08-03" (no leading "v" — see the
// file itself), matching normalize()'s own stripped format. Fetched from the raw file at the exact
// tag GitHub reported (not the normalized version), since that's what a git ref actually has to be.
async function fetchChangelogSection(tagName, version) {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${tagName}/CHANGELOG.md`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`));
    return match ? match[1].trim() : null;
  } catch {
    return null; // same "just don't show it" fallback as the version check itself
  }
}

async function checkForUpdate() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=100`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'LoxSuite' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { state.lastCheckReached = false; return; } // private repo (404), rate-limited (403), etc.
    state.lastCheckReached = true;
    const tags = await res.json();
    const rawTagName = newestTag(tags);
    const latest = rawTagName ? normalize(rawTagName) : null;
    if (latest) {
      state.latestVersion = latest;
      state.updateAvailable = compareVersions(latest, state.currentVersion) > 0;
      // Notification Center + Apprise (see notifications.js) — separate from the sidebar badge
      // above, opt-in via an admin-created "LoxSuite update available" rule, same as every other
      // trigger type. Safe to call on every check regardless of whether this is a genuinely new
      // finding: checkLoxSuiteUpdate's own last_state dedupe only actually fires a rule once per
      // distinct tag.
      if (state.updateAvailable) {
        await checkLoxSuiteUpdate(normalize(state.currentVersion), latest);
        // Only re-fetched the first time THIS particular version is seen as available, not on
        // every daily re-check while it's still the latest — same dedupe shape as
        // checkLoxSuiteUpdate's own last_state, just keyed on the changelog cache instead.
        if (state.changelogVersion !== latest) {
          state.changelog = await fetchChangelogSection(rawTagName, latest);
          state.changelogHtml = state.changelog ? markdownToHtml(state.changelog) : null;
          state.changelogVersion = latest;
        }
      }
    }
  } catch {
    // Offline, DNS failure, timeout, ... — the version number itself still always renders fine
    // without this, so a failed check is just silently skipped rather than surfaced anywhere.
    state.lastCheckReached = false;
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

module.exports = { getVersionStatus, startVersionCheck, checkForUpdate, compareVersions, newestTag };
