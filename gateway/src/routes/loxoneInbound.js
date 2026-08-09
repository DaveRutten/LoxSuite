const express = require('express');
// Namespace require (not destructured) — see loxoneUdpServer.js's own comment on why; matches that
// file's own style for the same module now, for the same testability reason.
const mqttClient = require('../mqttClient');
const { applyLoxoneToMqttTransform, findOrAutoCreateLoxoneMapping } = require('../loxone');
const { logAccepted, logRejected } = require('../loxoneCommandLog');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// A wildcard route (not just ":token") so that when auto-create is enabled and
// Loxone sends a real MQTT topic (which contains slashes) instead of a short
// pre-registered token, the full path still reaches this handler.
router.get('/*', asyncHandler(async (req, res) => {
  const token = req.params[0];
  const mapping = await findOrAutoCreateLoxoneMapping(token, 'http');

  if (!mapping) {
    await logRejected({ transport: 'HTTP', address: req.ip, topic: token, reason: 'no matching Loxone → MQTT mapping' });
    return res.status(404).send('Unknown or disabled mapping');
  }

  const rawValue = req.query.value;
  if (rawValue === undefined) {
    await logRejected({ transport: 'HTTP', address: req.ip, topic: mapping.mqtt_topic, reason: 'missing "value" query parameter' });
    return res.status(400).send('Missing "value" query parameter');
  }

  const value = await applyLoxoneToMqttTransform(mapping, rawValue);

  // mqtt.js's own publish() is callback-based, not promise-based — wrapped here (same reasoning as
  // loxoneUdpServer.js's own handleMessage()) so the logAccepted/logRejected DB write is properly
  // awaited instead of fired from inside a plain, un-awaited callback.
  mqttClient.getClient().publish(mapping.mqtt_topic, String(value), { qos: mapping.qos, retain: !!mapping.retain }, async (err) => {
    if (err) {
      console.error(`Failed to publish inbound value for token ${mapping.token}:`, err.message);
      await logRejected({ transport: 'HTTP', address: req.ip, topic: mapping.mqtt_topic, attemptedValue: value, reason: `failed to publish: ${err.message}` });
      return res.status(502).send('Failed to publish to MQTT');
    }
    await logAccepted({ transport: 'HTTP', address: req.ip, topic: mapping.mqtt_topic, value: String(value), mappingId: mapping.id });
    // A plain "OK" is all Loxone itself looks at, but the mapping page's Test feature calls this
    // same endpoint to exercise the real path end-to-end (see routes/mappings.js) and wants to
    // show what actually got published — JSON body costs Loxone nothing since it never reads it.
    res.status(200).json({ ok: true, topic: mapping.mqtt_topic, value: String(value) });
  });
}));

module.exports = router;
