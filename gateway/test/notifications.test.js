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
