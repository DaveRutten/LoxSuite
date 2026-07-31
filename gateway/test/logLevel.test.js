const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyLogLevel } = require('../src/logLevel');

test('classifyLogLevel recognizes an error line', () => {
  assert.equal(classifyLogLevel('Connection refused by broker'), 'error');
  assert.equal(classifyLogLevel('Client failed to authenticate'), 'error');
});

test('classifyLogLevel recognizes a warning line', () => {
  assert.equal(classifyLogLevel('Client foo has exceeded timeout, disconnecting'), 'warning');
  assert.equal(classifyLogLevel('Attempting to reconnect...'), 'warning');
});

test('classifyLogLevel defaults to info for anything else', () => {
  assert.equal(classifyLogLevel('New client connected from 127.0.0.1:1234'), 'info');
});

test('classifyLogLevel prefers error over warning when a line matches both', () => {
  // "timeout" alone would classify as warning, but "error" always wins when both are present.
  assert.equal(classifyLogLevel('error: connection timed out after retrying'), 'error');
});

test('classifyLogLevel matching is case-insensitive', () => {
  assert.equal(classifyLogLevel('CONNECTION REFUSED'), 'error');
  assert.equal(classifyLogLevel('Timeout waiting for response'), 'warning');
});
