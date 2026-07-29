const dgram = require('dgram');
const { getClient } = require('./mqttClient');
const { applyLoxoneToMqttTransform, findOrAutoCreateLoxoneMapping } = require('./loxone');

// Mirrors the HTTP inbound flow (routes/loxoneInbound.js), but for a Loxone
// Virtual UDP Output command configured as "<token>=\v" instead of a URL.
function handleMessage(buffer) {
  const text = buffer.toString('utf8').trim();
  const separatorIndex = text.indexOf('=');
  if (separatorIndex === -1) {
    console.warn(`Loxone UDP: ignoring malformed message "${text}" (expected "<token>=<value>")`);
    return;
  }

  const token = text.slice(0, separatorIndex);
  const rawValue = text.slice(separatorIndex + 1);

  const mapping = findOrAutoCreateLoxoneMapping(token, 'udp');
  if (!mapping) {
    console.warn(`Loxone UDP: no enabled mapping found for token "${token}"`);
    return;
  }

  const client = getClient();
  if (!client) return;

  const value = applyLoxoneToMqttTransform(mapping, rawValue);

  client.publish(mapping.mqtt_topic, value, { qos: mapping.qos, retain: !!mapping.retain }, (err) => {
    if (err) console.error(`Loxone UDP: failed to publish for token "${token}":`, err.message);
  });
}

function startUdpServer(port = process.env.LOXONE_UDP_PORT || 11884) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', handleMessage);
  socket.on('error', (err) => console.error('Loxone UDP server error:', err.message));
  socket.bind(port, () => console.log(`Loxone UDP server listening on port ${port}.`));
  return socket;
}

module.exports = { startUdpServer };
