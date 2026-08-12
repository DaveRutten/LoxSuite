// Fetches the built-in device templates straight from GitHub, on demand (routes/admin.js's
// "Fetch latest built-ins from GitHub" button) — lets a device fix/addition (e.g. Shelly's Reboot
// command) reach an install ahead of a full LoxSuite release, not just at the next app update.
// Same fetch/timeout/error-handling shape as versionCheck.js's own GitHub calls.
const fs = require('fs');
const path = require('path');
const { getTemplateDirs, parseTemplateFile } = require('./deviceTemplates');

const REPO = 'DaveRutten/LoxSuite';
// main HEAD, not a tagged release — deliberately ahead of any release, since the whole point is
// getting a fix before the next full app update. If a lower-risk pinned option is ever wanted
// instead, this is the one line to change (e.g. to a specific tag).
const REF = 'main';
const CONTENTS_URL = `https://api.github.com/repos/${REPO}/contents/gateway/device-templates?ref=${REF}`;

// Parses+validates in memory before writing anything to disk — reuses the exact same parsing
// (parseTemplateFile normally reads a file itself; here the already-fetched text is written to a
// temp-suffixed path first, parsed from there, and only renamed into place on success) so a
// malformed/truncated fetch can never clobber a previously-good synced file.
function validateAndWrite(destDir, filename, content) {
  // parseTemplateFile picks its parser off the file EXTENSION — the temp name has to keep the
  // real one (e.g. "foo.tmp.json", not "foo.json.tmp") or it's silently treated as an
  // unrecognized file type and every fetch would be rejected regardless of content.
  const tempName = filename.replace(/(\.[^.]+)$/, '.tmp$1');
  const tempPath = path.join(destDir, tempName);
  const finalPath = path.join(destDir, filename);
  fs.writeFileSync(tempPath, content, 'utf8');
  try {
    const families = parseTemplateFile(tempPath);
    if (!families || !families.length) throw new Error('no device family found in file');
    fs.renameSync(tempPath, finalPath);
    return families.map((f) => f.key);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

async function fetchBuiltinTemplatesFromGitHub() {
  const written = [];
  const failed = [];
  try {
    const res = await fetch(CONTENTS_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'LoxSuite' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { written, failed, error: `GitHub responded with HTTP ${res.status}` };

    const entries = await res.json();
    if (!Array.isArray(entries)) return { written, failed, error: 'Unexpected response from GitHub' };

    const templateFiles = entries.filter((e) => e.type === 'file' && /\.(json|xml)$/i.test(e.name));
    const { syncedDir, userDir } = getTemplateDirs();
    fs.mkdirSync(syncedDir, { recursive: true });
    // Also ensures user/ exists — that's the split-layout marker (getTemplateDirs' own
    // splitLayout flag), so a bare/dev run that never went through docker-entrypoint.sh's
    // migration still switches into 3-tier mode as soon as this runs, instead of writing into
    // synced/ and then silently ignoring it forever under the old flat-directory fallback.
    fs.mkdirSync(userDir, { recursive: true });

    for (const entry of templateFiles) {
      try {
        // download_url points at raw.githubusercontent.com — doesn't count against the
        // api.github.com rate limit, so this stays a single API call regardless of file count.
        const fileRes = await fetch(entry.download_url, { signal: AbortSignal.timeout(10000) });
        if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
        const content = await fileRes.text();
        const keys = validateAndWrite(syncedDir, entry.name, content);
        written.push({ file: entry.name, keys });
      } catch (err) {
        failed.push({ file: entry.name, error: err.message });
      }
    }
    return { written, failed, error: null };
  } catch (err) {
    // Offline, DNS failure, timeout, rate-limited, ... — same "just report it, don't throw"
    // fallback as versionCheck.js's own checkForUpdate.
    return { written, failed, error: err.message || 'Could not reach GitHub' };
  }
}

module.exports = { fetchBuiltinTemplatesFromGitHub };
