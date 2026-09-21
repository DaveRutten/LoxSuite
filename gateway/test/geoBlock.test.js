// Guards Geo-blocking's decision logic and MaxMind download/extraction (geoBlock.js) without
// needing a real .mmdb file, network access, or the database — the per-request middleware itself
// is exercised in practice by every real request once configured, but a bug in any of these three
// pieces would either lock out visitors who should be allowed in, or silently let through ones who
// shouldn't be, so each is pinned directly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { isBlocked, extractMmdbFromTarGz, downloadDatabase } = require('../src/geoBlock');

test('off mode never blocks, regardless of country or list contents', () => {
  assert.equal(isBlocked({ mode: 'off', countries: ['NL'], countryCode: 'NL' }), false);
  assert.equal(isBlocked({ mode: 'off', countries: [], countryCode: null }), false);
});

test('blocklist: blocks only a listed country, fails OPEN (allows) when the country is unknown', () => {
  const countries = ['NL', 'BE'];
  assert.equal(isBlocked({ mode: 'blocklist', countries, countryCode: 'NL' }), true);
  assert.equal(isBlocked({ mode: 'blocklist', countries, countryCode: 'BE' }), true);
  assert.equal(isBlocked({ mode: 'blocklist', countries, countryCode: 'DE' }), false);
  assert.equal(isBlocked({ mode: 'blocklist', countries, countryCode: null }), false);
  assert.equal(isBlocked({ mode: 'blocklist', countries: [], countryCode: 'NL' }), false);
});

test('allowlist: blocks everything except a listed country, fails CLOSED (blocks) when the country is unknown', () => {
  const countries = ['NL', 'BE'];
  assert.equal(isBlocked({ mode: 'allowlist', countries, countryCode: 'NL' }), false);
  assert.equal(isBlocked({ mode: 'allowlist', countries, countryCode: 'BE' }), false);
  assert.equal(isBlocked({ mode: 'allowlist', countries, countryCode: 'DE' }), true);
  assert.equal(isBlocked({ mode: 'allowlist', countries, countryCode: null }), true);
});

test('an unrecognized mode value never blocks (same as off) rather than defaulting to either list behavior', () => {
  assert.equal(isBlocked({ mode: 'bogus', countries: ['NL'], countryCode: 'NL' }), false);
});

// Minimal hand-built USTAR entry — just enough fields for extractFileFromTar to find it by name
// and read its content by size; mirrors the real shape of MaxMind's own download archive (one
// directory, a couple of files, no long names) closely enough to pin the extraction logic without
// needing the actual multi-megabyte database or a `tar` binary to build the fixture.
function tarEntry(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100, 'utf8');
  header.write('0000000\0', 108, 'utf8');
  header.write('0000000\0', 116, 'utf8');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
  header.write('00000000000\0', 136, 'utf8');
  header.write('        ', 148, 'utf8'); // checksum field treated as spaces while summing
  header.write('0', 156, 'utf8'); // typeflag: regular file
  header.write('ustar\0', 257, 'utf8');
  header.write('00', 263, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  Buffer.from(content).copy(padded);
  return Buffer.concat([header, padded]);
}

function makeFixtureTarGz(mmdbContent) {
  const tar = Buffer.concat([
    tarEntry('GeoLite2-Country_20260101/COPYRIGHT.txt', 'some license text'),
    tarEntry('GeoLite2-Country_20260101/GeoLite2-Country.mmdb', mmdbContent),
    Buffer.alloc(1024), // two all-zero 512-byte blocks mark the end of the archive
  ]);
  return zlib.gzipSync(tar);
}

test('extractMmdbFromTarGz finds the .mmdb entry by suffix, skipping other files in the archive', () => {
  const content = 'FAKE-MMDB-BINARY-CONTENT';
  const extracted = extractMmdbFromTarGz(makeFixtureTarGz(content));
  assert.ok(extracted);
  assert.equal(extracted.toString('utf8'), content);
});

test('extractMmdbFromTarGz returns null when the archive has no .mmdb file', () => {
  const tar = Buffer.concat([tarEntry('some/README.txt', 'nothing useful here'), Buffer.alloc(1024)]);
  assert.equal(extractMmdbFromTarGz(zlib.gzipSync(tar)), null);
});

test('downloadDatabase sends Basic Auth built from account ID + license key, and returns the extracted .mmdb bytes', async () => {
  const tarGz = makeFixtureTarGz('MMDB-CONTENT');
  let capturedUrl, capturedOpts;
  const fakeFetch = async (url, opts) => {
    capturedUrl = url;
    capturedOpts = opts;
    return { ok: true, arrayBuffer: async () => tarGz };
  };

  const result = await downloadDatabase({ accountId: '123', licenseKey: 'abc' }, fakeFetch);

  assert.equal(result.toString('utf8'), 'MMDB-CONTENT');
  assert.equal(capturedUrl, 'https://download.maxmind.com/geoip/databases/GeoLite2-Country/download?suffix=tar.gz');
  assert.equal(capturedOpts.headers.Authorization, `Basic ${Buffer.from('123:abc').toString('base64')}`);
});

test('downloadDatabase refuses without both credentials, before making any request', async () => {
  let called = false;
  const fakeFetch = async () => { called = true; return { ok: true, arrayBuffer: async () => Buffer.alloc(0) }; };
  await assert.rejects(() => downloadDatabase({ accountId: '', licenseKey: '' }, fakeFetch), /account ID and license key/i);
  assert.equal(called, false);
});

test('downloadDatabase surfaces a non-OK response as an error, with a hint on 401', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => downloadDatabase({ accountId: '1', licenseKey: '2' }, fakeFetch), /401.*account ID\/license key/i);
});
