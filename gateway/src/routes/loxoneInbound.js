const express = require('express');
const { getClient } = require('../mqttClient');
const { applyLoxoneToMqttTransform, findOrAutoCreateLoxoneMapping } = require('../loxone');
const { logAccepted, logRejected } = require('../loxoneCommandLog');

const router = express.Router();

// A wildcard route (not just ":token") so that when auto-create is enabled and
// Loxone sends a real MQTT topic (which contains slashes) instead of a short
// pre-registered token, the full path still reaches this handler.
router.get('/*', (req, res) => {
  const token = req.params[0];
  const mapping = findOrAutoCreateLoxoneMapping(token, 'http');

  if (!mapping) {
    logRejected({ transport: 'HTTP', address: req.ip, topic: token, reason: 'no matching Loxone → MQTT mapping' });
    return res.status(404).send('Unknown or disabled mapping');
  }

  const rawValue = req.query.value;
  if (rawValue === undefined) {
    logRejected({ transport: 'HTTP', address: req.ip, topic: mapping.mqtt_topic, reason: 'missing "value" query parameter' });
    return res.status(400).send('Missing "value" query parameter');
  }

  const value = applyLoxoneToMqttTransform(mapping, rawValue);

  getClient().publish(mapping.mqtt_topic, String(value), { qos: mapping.qos, retain: !!mapping.retain }, (err) => {
    if (err) {
      console.error(`Failed to publish inbound value for token ${mapping.token}:`, err.message);
      logRejected({ transport: 'HTTP', address: req.ip, topic: mapping.mqtt_topic, attemptedValue: value, reason: `failed to publish: ${err.message}` });
      return res.status(502).send('Failed to publish to MQTT');
    }
    logAccepted({ transport: 'HTTP', address: req.ip, topic: mapping.mqtt_topic, value: String(value) });
    // A plain "OK" is all Loxone itself looks at, but the mapping page's Test feature calls this
    // same endpoint to exercise the real path end-to-end (see routes/mappings.js) and wants to
    // show what actually got published — JSON body costs Loxone nothing since it never reads it.
    res.status(200).json({ ok: true, topic: mapping.mqtt_topic, value: String(value) });
  });
});

module.exports = router;
