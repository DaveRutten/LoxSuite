const test = require('node:test');
const assert = require('node:assert');
const { fillProfile, hourOfDayProfile } = require('../src/prices');

test('fillProfile gives hours without data the median of the others', () => {
  const prof = hourOfDayProfile([{ start: '2026-10-05T01:00:00Z', price: 0.2 }, { start: '2026-10-05T02:00:00Z', price: 0.3 }, { start: '2026-10-05T03:00:00Z', price: 0.25 }], (ms) => new Date(ms).getUTCHours());
  const full = fillProfile(prof);
  assert.strictEqual(full.length, 24);
  assert.ok(full.every((p) => p !== null));
  assert.strictEqual(full[1], 0.2);
  assert.strictEqual(full[12], 0.25);
});
