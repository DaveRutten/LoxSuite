// Guards the mapping match optimization (mqttClient.js): the '#' handler runs for every broker
// message, and the old code scanned all enabled mappings per message. buildMappingIndex + select-
// Mappings turn the common exact-topic case into a Map lookup. This pins that selectMappings returns
// EXACTLY the same set the old full scan (filter + topicMatches) did, for exact, +, # and no-match.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMappingIndex, selectMappings, topicMatches } = require('../src/mqttClient');

const rows = [
  { id: 1, mqtt_topic: 'shellies/plug1/relay/0' },   // exact
  { id: 2, mqtt_topic: 'shellies/plug1/relay/0' },   // exact duplicate topic (two mappings)
  { id: 3, mqtt_topic: 'zigbee2mqtt/+/state' },      // single-level wildcard
  { id: 4, mqtt_topic: 'home/#' },                   // multi-level wildcard
  { id: 5, mqtt_topic: 'sensors/temp/kitchen' },     // exact
];
const index = buildMappingIndex(rows);

// reference = the exact behaviour of the old code
const ref = (topic) => rows.filter((m) => topicMatches(m.mqtt_topic, topic)).map((m) => m.id).sort();
const got = (topic) => selectMappings(topic, index).map((m) => m.id).sort();

test('index splits exact vs wildcard mappings', () => {
  assert.equal(index.exact.size, 2);           // two distinct exact topics
  assert.equal(index.exact.get('shellies/plug1/relay/0').length, 2);
  assert.equal(index.wildcards.length, 2);     // the + and the #
});

test('selectMappings matches the old full-scan result for every topic shape', () => {
  for (const topic of [
    'shellies/plug1/relay/0',      // exact, two mappings
    'sensors/temp/kitchen',        // exact, one
    'zigbee2mqtt/livingroom/state',// + wildcard
    'zigbee2mqtt/a/b/state',       // + must NOT match (wrong depth)
    'home/floor1/light',           // # wildcard
    'home',                        // # matches parent too
    'unmapped/topic/here',         // nothing
  ]) {
    assert.deepEqual(got(topic), ref(topic), `mismatch for "${topic}"`);
  }
});

test('an all-exact mapping set needs no wildcard scan', () => {
  const idx = buildMappingIndex([{ id: 9, mqtt_topic: 'a/b/c' }]);
  assert.equal(idx.wildcards.length, 0);
  assert.deepEqual(selectMappings('a/b/c', idx).map((m) => m.id), [9]);
  assert.deepEqual(selectMappings('x/y/z', idx), []);
});
