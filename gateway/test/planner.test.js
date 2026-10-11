// Smart charging output to Loxone (planner.js): where the power and "charging allowed" go.
const test = require('node:test');
const assert = require('node:assert/strict');

test('charging output: virtual input by name, or straight to a Loxone object, or "charging allowed" off', async () => {
  const p = require('../src/planner');
  const base = { vi_setpoint: 'LS kW', vi_enable: 'LS laden' };
  assert.equal(p.hasPowerOutput({ ...base }), true);
  assert.equal(p.hasPowerOutput({ setpoint_via: 'direct' }), false, 'direct without an object is nothing');
  assert.equal(p.enableSent({ ...base, enable_via: 'off' }), false);
  assert.equal(p.enableSent({ enable_via: 'direct', enable_action: 'u-1' }), true);
});
