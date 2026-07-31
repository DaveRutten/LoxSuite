const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AREAS, AREA_KEYS, LOG_AREAS, MAIN_AREAS } = require('../src/permissionAreas');

test('every area has a unique key', () => {
  assert.equal(new Set(AREA_KEYS).size, AREA_KEYS.length);
});

test('every area has a non-empty label', () => {
  for (const area of AREAS) {
    assert.equal(typeof area.label, 'string');
    assert.ok(area.label.length > 0, `area "${area.key}" has an empty label`);
  }
});

test('AREA_KEYS matches AREAS exactly, same order', () => {
  assert.deepEqual(AREA_KEYS, AREAS.map((a) => a.key));
});

test('LOG_AREAS covers exactly the four Logs tabs', () => {
  assert.deepEqual(
    LOG_AREAS.map((a) => a.key).sort(),
    ['logs_loxone', 'logs_loxone_commands', 'logs_mqtt', 'logs_system'].sort()
  );
});

test('every LOG_AREAS entry is present in AREAS (so it gets seeded/saved like any other area)', () => {
  for (const logArea of LOG_AREAS) {
    assert.ok(AREAS.includes(logArea), `LOG_AREAS entry "${logArea.key}" is missing from AREAS`);
  }
});

test('MAIN_AREAS is exactly AREAS minus LOG_AREAS, with nothing else dropped', () => {
  assert.equal(MAIN_AREAS.length, AREAS.length - LOG_AREAS.length);
  for (const area of MAIN_AREAS) assert.ok(!LOG_AREAS.includes(area));
  for (const area of AREAS) assert.ok(MAIN_AREAS.includes(area) || LOG_AREAS.includes(area));
});
