const { test } = require('node:test');
const assert = require('node:assert/strict');
const { humanizeTopic } = require('../src/topicName');

test('humanizeTopic strips a known root namespace and titlecases device + metric', () => {
  assert.equal(
    humanizeTopic('shellies/shellyplug-ZWEMBADVerwarming/relay/0/power'),
    'Zwembad Verwarming - Power'
  );
});

test('humanizeTopic skips a trailing numeric index to find the real metric', () => {
  // device is the first segment *after* the stripped "homeassistant" root — "sensor" here, not
  // "livingroom" — and the trailing "/0" index is skipped in favor of "temperature" as the metric.
  assert.equal(humanizeTopic('homeassistant/sensor/livingroom/temperature/0'), 'Sensor - Temperature');
});

test('humanizeTopic skips structural words like "set"/"status"/"command"', () => {
  assert.equal(humanizeTopic('shellies/kitchen-light/command/set'), 'Kitchen Light');
});

test('humanizeTopic falls back to just the device name when nothing else is left', () => {
  assert.equal(humanizeTopic('shellies/garage-door'), 'Garage Door');
});

test('humanizeTopic leaves a topic with no known root namespace as its own device/metric split', () => {
  assert.equal(humanizeTopic('myhome/bathroom/humidity'), 'Myhome - Humidity');
});

test('humanizeTopic returns the original string for an empty/slash-only topic', () => {
  assert.equal(humanizeTopic(''), '');
  assert.equal(humanizeTopic('///'), '///');
});

test('humanizeTopic handles camelCase and ALLCAPS segments', () => {
  assert.equal(humanizeTopic('zigbee2mqtt/livingRoomSensor/batteryLevel'), 'Living Room Sensor - Battery Level');
});
