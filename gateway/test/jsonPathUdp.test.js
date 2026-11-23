// A Shelly Motion (Gen1) sends everything as one JSON message on shellies/<id>/status, while Loxone's
// Virtual Inputs listen for one value per topic ("…/status/motion", "…/status/bat"). Guards that a UDP
// mapping with a json_path carries the picked field in its topic, and that JSON true/false go as 1/0.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyTransform, udpTopicFor } = require('../src/loxone');

const status = '{"motion":true,"timestamp":1795440259,"active":true,"vibration":false,"lux":313,"bat":32}';

test('json_path picks the field, with JSON booleans as 1/0', async () => {
  assert.equal(await applyTransform(status, { value_transform: 'json_path', transform_arg: 'bat' }), 32);
  assert.equal(await applyTransform(status, { value_transform: 'json_path', transform_arg: 'motion' }), '1');
  assert.equal(await applyTransform(status, { value_transform: 'json_path', transform_arg: 'vibration' }), '0');
  assert.equal(await applyTransform('{"a":{"b":7}}', { value_transform: 'json_path', transform_arg: 'a.b' }), 7);
  assert.equal(await applyTransform('{"a":{"b":7}}', { value_transform: 'json_path', transform_arg: 'a' }), '{"b":7}');
});

test('a UDP json_path mapping adds the field to the topic, other mappings keep the topic', () => {
  const topic = 'shellies/shellymotionsensor-Slp2BedR/status';
  assert.equal(udpTopicFor({ value_transform: 'json_path', transform_arg: 'bat' }, topic), `${topic}/bat`);
  assert.equal(udpTopicFor({ value_transform: 'json_path', transform_arg: 'a.b' }, topic), `${topic}/a/b`);
  assert.equal(udpTopicFor({ value_transform: 'passthrough', transform_arg: null }, topic), topic);
  assert.equal(udpTopicFor({ value_transform: 'json_path', transform_arg: '' }, topic), topic);
});
