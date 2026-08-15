// dynamicSecurity.js's other functions are all thin, one-line wrappers around a real MQTT
// round-trip to the broker's own $CONTROL/dynamic-security/v1 topic (see its own sendCommand) —
// nothing worth unit-testing without a real broker, which is why this file has never had a test of
// its own until now. personalRoleName is the one piece of real, pure logic in the module (see its
// own comment on why a client needing something extra becomes a second, personal-only role rather
// than a real per-client ACL, which Mosquitto's dynsec plugin doesn't have at all) — deterministic,
// worth pinning down on its own.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { personalRoleName } = require('../src/dynamicSecurity');

test('personalRoleName slugs a plain username into its own "personal-" role name', () => {
  assert.equal(personalRoleName('shellyplug1'), 'personal-shellyplug1');
});

test('personalRoleName lowercases and replaces non-alphanumeric runs with a single hyphen', () => {
  assert.equal(personalRoleName('Shelly.Plug_1'), 'personal-shelly-plug-1');
});

test('personalRoleName strips leading/trailing hyphens left over from a leading/trailing separator', () => {
  assert.equal(personalRoleName('.leading-dot'), 'personal-leading-dot');
  assert.equal(personalRoleName('trailing-dot.'), 'personal-trailing-dot');
});

// Two usernames that happen to slug to the same string share one personal role — the same
// theoretical collision risk deviceRoleName already accepts for device-scoped roles (see
// dynamicSecurity.js's own comment on this) — pinned down here so a future change can't silently
// "fix" this in a way that breaks the deliberate parity with deviceRoleName instead of on purpose.
test('personalRoleName can collide for two usernames that only differ in separator characters', () => {
  assert.equal(personalRoleName('shelly.user'), personalRoleName('shelly-user'));
});
