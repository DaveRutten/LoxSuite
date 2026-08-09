const dgram = require('dgram');
// Namespace require (not destructured) — same style server.js already uses for this module,
// and what lets test/loxoneUdpServer.test.js stub mqttClient.getClient without a real broker: a
// destructured `const { getClient } = require(...)` freezes in the function reference at require
// time, so reassigning the exported property afterward (what a test stub does) wouldn't be seen
// here.
const mqttClient = require('./mqttClient');
const { applyLoxoneToMqttTransform, findOrAutoCreateLoxoneMapping, splitUdpMessage } = require('./loxone');
const { logAccepted, logRejected } = require('./loxoneCommandLog');

// Mirrors the HTTP inbound flow (routes/loxoneInbound.js), but for a Loxone
// Virtual UDP Output command configured as "<token>=\v" (or "<token> \v") instead of a URL.
async function handleMessage(buffer, rinfo) {
  const text = buffer.toString('utf8').trim();
  const address = rinfo ? rinfo.address : null;
  const port = rinfo ? rinfo.port : null;
  const from = rinfo ? `${rinfo.address}:${rinfo.port}` : 'unknown sender';
  console.log(`Loxone UDP: received "${text}" from ${from}`);

  // Missing this await used to make `parsed` a Promise (always truthy, so the malformed-message
  // check below never fired) and `{ token, rawValue }` destructure to undefined — findOrAutoCreate
  // LoxoneMapping(undefined, ...) then throws ("Undefined binding(s) detected") from the facade's
  // own bound-parameter check, silently caught by startUdpServer's outer .catch() as a bare
  // console.error with NO command-log entry at all and NO MQTT publish — every UDP-transport
  // Loxone command (Shelly RGBW/dimmer/relay mappings included) failing exactly like this since
  // splitUdpMessage became async (Phase 1 of the db-backend plan) and this one call site was missed.
  const parsed = await splitUdpMessage(text, 'udp');
  if (!parsed) {
    console.warn(`Loxone UDP: ignoring malformed message "${text}" (expected "<token>=<value>" or "<token> <value>")`);
    await logRejected({ transport: 'UDP', address, port, topic: text, reason: 'malformed message (expected "<token>=<value>" or "<token> <value>")' });
    return;
  }

  const { token, rawValue } = parsed;

  const mapping = await findOrAutoCreateLoxoneMapping(token, 'udp');
  if (!mapping) {
    console.warn(`Loxone UDP: no enabled mapping found for token or topic "${token}"`);
    await logRejected({ transport: 'UDP', address, port, topic: token, attemptedValue: rawValue, reason: 'no matching Loxone → MQTT mapping' });
    return;
  }

  const client = mqttClient.getClient();
  if (!client) {
    console.warn(`Loxone UDP: MQTT client not connected, dropping message for "${token}"`);
    await logRejected({ transport: 'UDP', address, port, topic: mapping.mqtt_topic, attemptedValue: rawValue, reason: 'MQTT broker not connected' });
    return;
  }

  const value = await applyLoxoneToMqttTransform(mapping, rawValue);

  console.log(`Loxone UDP: publishing "${value}" to "${mapping.mqtt_topic}" (matched via "${token}")`);
  // mqtt.js's own publish() is callback-based, not promise-based — wrapped here so handleMessage()
  // genuinely waits for both the publish AND the resulting log write to finish (logAccepted/
  // logRejected are themselves async DB writes) before returning, rather than firing them from
  // inside a plain, un-awaited callback: the previous shape let handleMessage() resolve — and
  // startUdpServer's caller move on to the next message — before that write was guaranteed to have
  // actually happened.
  await new Promise((resolve) => {
    client.publish(mapping.mqtt_topic, value, { qos: mapping.qos, retain: !!mapping.retain }, async (err) => {
      if (err) {
        console.error(`Loxone UDP: failed to publish for token "${token}":`, err.message);
        await logRejected({ transport: 'UDP', address, port, topic: mapping.mqtt_topic, attemptedValue: value, reason: `failed to publish: ${err.message}` });
      } else {
        console.log(`Loxone UDP: published "${value}" to "${mapping.mqtt_topic}" OK`);
        await logAccepted({ transport: 'UDP', address, port, topic: mapping.mqtt_topic, value, mappingId: mapping.id });
      }
      resolve();
    });
  });
}

function startUdpServer(port = process.env.LOXONE_UDP_PORT || 11885) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (buffer, rinfo) => {
    handleMessage(buffer, rinfo).catch((err) => console.error('Loxone UDP: failed to handle message:', err.message));
  });
  socket.on('error', (err) => console.error('Loxone UDP server error:', err.message));
  socket.bind(port, () => console.log(`Loxone UDP server listening on port ${port}.`));
  return socket;
}

module.exports = { startUdpServer, handleMessage };
