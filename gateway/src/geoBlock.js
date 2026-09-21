// Blocks (or allows-only) requests by the visitor's country, looked up from their IP against a
// local MaxMind GeoLite2-Country database — no per-request network call, no third-party service
// seeing every visitor's IP. Mirrors the existing "Require SSO from outside the local network"
// design (see network.js/loadUserContext.js): a private/local-network request is always exempt
// (so the admin, on the LAN, is never the one who gets locked out, and so a Loxone Miniserver's own
// callback to /api/loxone-in — always LAN-local in a normal setup — is never affected either), and
// enforcement re-runs on every request, not just at login, via the middleware below rather than a
// one-time check.
//
// The GeoLite2-Country database itself is free but requires a MaxMind account (Administration >
// Security) to download — its EULA doesn't allow redistributing the file itself, so it can't be
// bundled in this repo/image and is fetched at runtime instead (see downloadDatabase below),
// refreshed periodically (startGeoBlockUpdater) since MaxMind rebuilds it roughly weekly.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const maxmind = require('maxmind');
const db = require('./db');
const { encrypt, decrypt } = require('./secretCrypto');
const { isPrivateNetworkRequest } = require('./network');
const { logSystemEvent } = require('./auditLog');

const DOWNLOAD_URL = 'https://download.maxmind.com/geoip/databases/GeoLite2-Country/download?suffix=tar.gz';
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // MaxMind rebuilds GeoLite2 roughly weekly; checking daily is cheap and keeps a fresh install from waiting a week for its first real database
const DOWNLOAD_TIMEOUT_MS = 30000;

function geoipDir() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'gateway.db');
  return path.join(path.dirname(dbPath), 'geoip');
}

function mmdbPath() {
  return path.join(geoipDir(), 'GeoLite2-Country.mmdb');
}

// Minimal, read-only tar parser — enough to pull one named file out of MaxMind's own download
// archive (a flat `GeoLite2-Country_<date>/` directory containing the .mmdb plus a couple of
// COPYRIGHT/LICENSE .txt files) without a whole tar library for one extraction. Deliberately
// narrow: no long-name (GNU @LongLink) support, since every real entry in this specific archive has
// a short path that fits tar's own 100-byte name field — verified against MaxMind's actual output,
// not assumed.
function extractFileFromTar(tarBuffer, fileSuffix) {
  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // two all-zero blocks mark the end of the archive
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const dataStart = offset + 512;
    if (name.endsWith(fileSuffix)) return tarBuffer.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512; // content is padded to the next 512-byte boundary
  }
  return null;
}

function extractMmdbFromTarGz(tarGzBuffer) {
  return extractFileFromTar(zlib.gunzipSync(tarGzBuffer), '.mmdb');
}

// Separate from isEnabled()'s own settings read so a test can exercise the HTTP/parsing logic
// without touching the database.
async function downloadDatabase({ accountId, licenseKey }, fetchImpl = fetch) {
  if (!accountId || !licenseKey) throw new Error('MaxMind account ID and license key are required.');
  const auth = Buffer.from(`${accountId}:${licenseKey}`).toString('base64');
  const res = await fetchImpl(DOWNLOAD_URL, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`MaxMind download responded with HTTP ${res.status}${res.status === 401 ? ' (check the account ID/license key)' : ''}`);
  const mmdb = extractMmdbFromTarGz(Buffer.from(await res.arrayBuffer()));
  if (!mmdb) throw new Error('Downloaded archive did not contain a .mmdb file.');
  return mmdb;
}

// One shared reader instance, opened lazily and kept hot across requests/lookups —
// watchForUpdates means a fresh download replacing the file on disk (see updateDatabase below) is
// picked up automatically, without restarting the gateway or re-`open()`ing by hand.
let readerPromise = null;
function getReader() {
  if (!readerPromise) {
    readerPromise = maxmind.open(mmdbPath(), { watchForUpdates: true }).catch((err) => {
      readerPromise = null; // let the next call retry rather than caching a permanent failure
      throw err;
    });
  }
  return readerPromise;
}

// Exposed for updateDatabase() to force a re-open right after writing a fresh file, and for tests.
function resetReaderCache() {
  readerPromise = null;
}

// null = "couldn't determine a country" (no database loaded yet, IP not found, lookup error) —
// callers must decide what null means for their own mode, not this function.
async function countryCodeForIp(ip) {
  try {
    const reader = await getReader();
    const result = reader.get(ip);
    return result?.country?.iso_code || result?.registered_country?.iso_code || null;
  } catch {
    return null; // no database on disk yet (not configured / not downloaded) — treated as "unknown" by the caller
  }
}

// Pure decision, kept separate from the DB/IP-lookup plumbing above so it's trivially unit-testable
// (see test/geoBlock.test.js) without a real .mmdb file or network. `countryCode` is null when the
// country couldn't be determined at all (see countryCodeForIp above) — a blocklist fails OPEN on
// that (nothing to match against, so nothing to block), an allowlist fails CLOSED (an unrecognized
// visitor isn't affirmatively on the allowed list either), matching how each list's own absence
// case already behaves once the country IS known.
function isBlocked({ mode, countries, countryCode }) {
  const list = Array.isArray(countries) ? countries : [];
  if (mode === 'blocklist') return !!countryCode && list.includes(countryCode);
  if (mode === 'allowlist') return !(countryCode && list.includes(countryCode));
  return false; // 'off', or any unrecognized value — never blocks
}

async function loadSettings() {
  const row = await db.prepare(
    `SELECT geo_block_mode, geo_block_countries, geo_block_maxmind_account_id, geo_block_maxmind_license_key,
            geo_block_db_updated_at, geo_block_db_status, geo_block_db_error
     FROM gateway_settings WHERE id = 1`
  ).get();
  let countries = [];
  try { countries = JSON.parse(row?.geo_block_countries || '[]'); } catch { countries = []; }
  return {
    mode: row?.geo_block_mode || 'off',
    countries,
    maxmindAccountId: row?.geo_block_maxmind_account_id || '',
    maxmindLicenseKey: decrypt(row?.geo_block_maxmind_license_key || ''),
    dbUpdatedAt: row?.geo_block_db_updated_at || null,
    dbStatus: row?.geo_block_db_status || null,
    dbError: row?.geo_block_db_error || null,
  };
}

async function saveRule(mode, countries) {
  await db.prepare('UPDATE gateway_settings SET geo_block_mode = ?, geo_block_countries = ? WHERE id = 1')
    .run(mode, JSON.stringify(Array.isArray(countries) ? countries : []));
}

async function saveCredentials(accountId, licenseKey) {
  // Blank license key = keep the existing one (never shown back to the browser) — same convention
  // as the SSO client secret and Miniserver passwords.
  const existing = licenseKey ? null : await db.prepare('SELECT geo_block_maxmind_license_key FROM gateway_settings WHERE id = 1').get();
  await db.prepare('UPDATE gateway_settings SET geo_block_maxmind_account_id = ?, geo_block_maxmind_license_key = ? WHERE id = 1')
    .run(accountId || null, licenseKey ? encrypt(licenseKey) : existing?.geo_block_maxmind_license_key || null);
}

// Downloads a fresh database right now (used by both Administration's own "Update now" button and
// the periodic ticker below) — always records the outcome (dbUpdatedAt only advances on success;
// dbStatus/dbError reflect the latest attempt either way) so Administration > Security can show
// something concrete instead of a page that looks like it's silently doing nothing.
async function updateDatabaseNow(fetchImpl = fetch) {
  const settings = await loadSettings();
  try {
    const mmdb = await downloadDatabase({ accountId: settings.maxmindAccountId, licenseKey: settings.maxmindLicenseKey }, fetchImpl);
    fs.mkdirSync(geoipDir(), { recursive: true });
    fs.writeFileSync(mmdbPath(), mmdb);
    resetReaderCache();
    const now = new Date().toISOString();
    await db.prepare('UPDATE gateway_settings SET geo_block_db_updated_at = ?, geo_block_db_status = ?, geo_block_db_error = ? WHERE id = 1')
      .run(now, 'ok', null);
    return { ok: true, updatedAt: now };
  } catch (err) {
    await db.prepare('UPDATE gateway_settings SET geo_block_db_status = ?, geo_block_db_error = ? WHERE id = 1')
      .run('error', err.message);
    await logSystemEvent(`Geo-blocking: failed to update the GeoLite2 database: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

let lastCheckedAt = 0;
async function tick(fetchImpl = fetch) {
  const settings = await loadSettings();
  if (settings.mode === 'off' || !settings.maxmindAccountId || !settings.maxmindLicenseKey) return; // nothing to keep fresh
  if (Date.now() - lastCheckedAt < UPDATE_INTERVAL_MS) return;
  lastCheckedAt = Date.now();
  await updateDatabaseNow(fetchImpl);
}

function startGeoBlockUpdater() {
  // Run once shortly after boot (a fresh install with credentials already configured — e.g.
  // restored from backup — shouldn't wait a full day for its first database) as well as on the
  // regular interval.
  setTimeout(() => { tick().catch(() => {}); }, 15000).unref?.();
  const timer = setInterval(() => { tick().catch(() => {}); }, UPDATE_INTERVAL_MS);
  timer.unref?.();
}

// Mounted globally, early, in server.js — runs for every request, authenticated or not, static
// asset or route, same "whole app, every request" scope as the local-login break-glass check this
// mirrors. Fails OPEN (lets the request through) on anything that isn't a clean "yes, block this"
// decision — a misconfigured or not-yet-downloaded database must never turn into locking out every
// visitor, including the admin, by accident.
async function geoBlockMiddleware(req, res, next) {
  if (isPrivateNetworkRequest(req)) return next();

  let settings;
  try {
    settings = await loadSettings();
  } catch {
    return next(); // DB not ready yet (e.g. very early boot) — nothing to enforce
  }
  if (settings.mode === 'off') return next();

  const countryCode = await countryCodeForIp(req.ip);
  if (!isBlocked({ mode: settings.mode, countries: settings.countries, countryCode })) return next();

  res.status(403).type('text/plain').send('Access from your region is not permitted.');
}

module.exports = {
  geoBlockMiddleware,
  isBlocked,
  countryCodeForIp,
  loadSettings,
  saveRule,
  saveCredentials,
  updateDatabaseNow,
  startGeoBlockUpdater,
  downloadDatabase,
  extractMmdbFromTarGz,
  mmdbPath,
  resetReaderCache,
  tick,
};
