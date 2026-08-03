const dgram = require('dgram');
const { getClient } = require('./mqttClient');
const { applyLoxoneToMqttTransform, findOrAutoCreateLoxoneMapping, splitUdpMessage } = require('./loxone');
const { logAccepted, logRejected } = require('./loxoneCommandLog');

// Mirrors the HTTP inbound flow (routes/loxoneInbound.js), but for a Loxone
// Virtual UDP Output command configured as "<token>=\v" (or "<token> \v") instead of a URL.
function handleMessage(buffer, rinfo) {
  const text = buffer.toString('utf8').trim();
  const address = rinfo ? rinfo.address : null;
  const port = rinfo ? rinfo.port : null;
  const from = rinfo ? `${rinfo.address}:${rinfo.port}` : 'unknown sender';
  console.log(`Loxone UDP: received "${text}" from ${from}`);

  const parsed = splitUdpMessage(text, 'udp');
  if (!parsed) {
    console.warn(`Loxone UDP: ignoring malformed message "${text}" (expected "<token>=<value>" or "<token> <value>")`);
    logRejected({ transport: 'UDP', address, port, topic: text, reason: 'malformed message (expected "<token>=<value>" or "<token> <value>")' });
    return;
  }

  const { token, rawValue } = parsed;

  const mapping = findOrAutoCreateLoxoneMapping(token, 'udp');
  if (!mapping) {
    console.warn(`Loxone UDP: no enabled mapping found for token or topic "${token}"`);
    logRejected({ transport: 'UDP', address, port, topic: token, attemptedValue: rawValue, reason: 'no matching Loxone → MQTT mapping' });
    return;
  }

  const client = getClient();
  if (!client) {
    console.warn(`Loxone UDP: MQTT client not connected, dropping message for "${token}"`);
    logRejected({ transport: 'UDP', address, port, topic: mapping.mqtt_topic, attemptedValue: rawValue, reason: 'MQTT broker not connected' });
    return;
  }

  const value = applyLoxoneToMqttTransform(mapping, rawValue);

  console.log(`Loxone UDP: publishing "${value}" to "${mapping.mqtt_topic}" (matched via "${token}")`);
  client.publish(mapping.mqtt_topic, value, { qos: mapping.qos, retain: !!mapping.retain }, (err) => {
    if (err) {
      console.error(`Loxone UDP: failed to publish for token "${token}":`, err.message);
      logRejected({ transport: 'UDP', address, port, topic: mapping.mqtt_topic, attemptedValue: value, reason: `failed to publish: ${err.message}` });
    } else {
      console.log(`Loxone UDP: published "${value}" to "${mapping.mqtt_topic}" OK`);
      logAccepted({ transport: 'UDP', address, port, topic: mapping.mqtt_topic, value, mappingId: mapping.id });
    }
  });
}

function startUdpServer(port = process.env.LOXONE_UDP_PORT || 11885) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', handleMessage);
  socket.on('error', (err) => console.error('Loxone UDP server error:', err.message));
  socket.bind(port, () => console.log(`Loxone UDP server listening on port ${port}.`));
  return socket;
}

module.exports = { startUdpServer };
