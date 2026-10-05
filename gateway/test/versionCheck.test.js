const test = require('node:test');
const assert = require('node:assert');
const { compareVersions, newestTag } = require('../src/versionCheck');

test('compareVersions orders by number, alpha below release', () => {
  assert.ok(compareVersions('0.34.0-alpha.1', '0.33.1-alpha.1') > 0);
  assert.ok(compareVersions('v0.10.0-alpha.1', '0.9.9-alpha.1') > 0);
  assert.ok(compareVersions('0.34.0-alpha.2', '0.34.0-alpha.10') < 0);
  assert.ok(compareVersions('0.34.0', '0.34.0-alpha.1') > 0);
  assert.strictEqual(compareVersions('v0.34.0-alpha.1', '0.34.0-alpha.1'), 0);
});

test('newestTag ignores list order and non-version tags', () => {
  const tags = [{ name: 'v0.33.1-alpha.1' }, { name: 'v0.34.0-alpha.1' }, { name: 'v0.33.0-alpha.1' }, { name: 'latest' }, { name: 'v0.9.0-alpha.1' }];
  assert.strictEqual(newestTag(tags), 'v0.34.0-alpha.1');
  assert.strictEqual(newestTag([]), null);
});
