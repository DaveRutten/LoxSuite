const test = require('node:test');
const assert = require('node:assert');
const { addressCandidates } = require('../src/agenda');
const { decodeEntities } = require('../src/caldav');

test('a name in front of the address is dropped step by step, then postcode + town', () => {
  const c = addressCandidates('Coöperatie VGZ Nieuwe Stationsstraat 12, 6811 KS Arnhem, Nederland');
  assert.strictEqual(c[0], 'Coöperatie VGZ Nieuwe Stationsstraat 12, 6811 KS Arnhem, Nederland');
  assert.ok(c.includes('Nieuwe Stationsstraat 12, 6811 KS Arnhem'));
  assert.strictEqual(c[c.length - 1], '6811 KS Arnhem');
});

test('calendar names: &amp; becomes &', () => {
  assert.strictEqual(decodeEntities('Naam &amp; Naam'), 'Naam & Naam');
  assert.strictEqual(decodeEntities('A &amp;amp; B'), 'A & B');
  assert.strictEqual(decodeEntities('Caf&#233;'), 'Café');
  assert.strictEqual(decodeEntities('Plain'), 'Plain');
});
