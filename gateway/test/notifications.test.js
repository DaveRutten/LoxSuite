// notifications.js requires db.js — same in-memory DB isolation as dateFormat.test.js.
process.env.DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareThreshold, operatorLabel, extractAppriseError } = require('../src/notifications');

test('compareThreshold: gt/gte/lt/lte/eq all compare correctly', () => {
  assert.equal(compareThreshold(10, 'gt', 5), true);
  assert.equal(compareThreshold(5, 'gt', 5), false);
  assert.equal(compareThreshold(5, 'gte', 5), true);
  assert.equal(compareThreshold(4, 'lt', 5), true);
  assert.equal(compareThreshold(5, 'lt', 5), false);
  assert.equal(compareThreshold(5, 'lte', 5), true);
  assert.equal(compareThreshold(5, 'eq', 5), true);
  assert.equal(compareThreshold(5.5, 'eq', 5), false);
});

test('compareThreshold returns false for an unknown operator instead of throwing', () => {
  assert.equal(compareThreshold(10, 'bogus', 5), false);
});

test('operatorLabel maps every known operator to its symbol', () => {
  assert.equal(operatorLabel('gt'), '>');
  assert.equal(operatorLabel('gte'), '≥');
  assert.equal(operatorLabel('lt'), '<');
  assert.equal(operatorLabel('lte'), '≤');
  assert.equal(operatorLabel('eq'), '=');
});

test('operatorLabel falls back to the raw operator string for an unknown one', () => {
  assert.equal(operatorLabel('near'), 'near');
});

test('extractAppriseError pulls just the message out of a WARNING log line', () => {
  const output = '2026-07-31 07:45:50,306 - WARNING - A Connection error occurred sending JSON notification to 127.0.0.1.\n';
  assert.equal(extractAppriseError(output), 'A Connection error occurred sending JSON notification to 127.0.0.1.');
});

test('extractAppriseError picks the last WARNING/ERROR line when several are present', () => {
  const output = [
    '2026-07-31 07:45:50,001 - INFO - Loading Notify plugin json',
    '2026-07-31 07:45:50,100 - WARNING - retrying once',
    '2026-07-31 07:45:50,306 - ERROR - Connection refused',
  ].join('\n');
  assert.equal(extractAppriseError(output), 'Connection refused');
});

test('extractAppriseError falls back to the last line verbatim if nothing matches the log shape', () => {
  assert.equal(extractAppriseError('some unstructured output'), 'some unstructured output');
});

test('extractAppriseError returns null for empty output', () => {
  assert.equal(extractAppriseError(''), null);
  assert.equal(extractAppriseError(null), null);
});

test('subscriberTargets: per subscription channel, push or both', () => {
  const { subscriberTargets } = require('../src/notifications');
  const base = { id: 7, username: 'dave', url: 'tgram://bot/123', push_on: 1 };
  const urls = (rows) => subscriberTargets(rows).map((t) => t.url);
  assert.deepEqual(urls([{ ...base, via: null }]), ['tgram://bot/123', 'loxsuite-push://user/7']);
  assert.deepEqual(urls([{ ...base, via: 'channel' }]), ['tgram://bot/123']);
  assert.deepEqual(urls([{ ...base, via: 'push' }]), ['loxsuite-push://user/7']);
  assert.deepEqual(urls([{ ...base, push_on: 0, via: 'push' }]), []);
  assert.deepEqual(urls([{ ...base, url: '', via: null }]), ['loxsuite-push://user/7']);
  // an old-style push URL as "my channel" counts as push, and isn't sent twice
  assert.deepEqual(urls([{ ...base, url: 'loxsuite-push://user/7', via: null }]), ['loxsuite-push://user/7']);
  assert.deepEqual(urls([{ ...base, url: 'loxsuite-push://user/7', via: 'channel' }]), []);
});
