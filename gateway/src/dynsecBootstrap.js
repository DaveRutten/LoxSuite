const mqtt = require('mqtt');
const { nanoid } = require('nanoid');
const db = require('./db');

const REQUEST_TOPIC = '$CONTROL/dynamic-security/v1';
const RESPONSE_TOPIC = '$CONTROL/dynamic-security/v1/response';
const TIMEOUT_MS = 5000;

function sendCommand(client, command) {
  return new Promise((resolve, reject) => {
    const correlationData = nanoid();
    const timer = setTimeout(() => {
      client.removeListener('message', handler);
      reject(new Error('Dynamic security command timed out'));
    }, TIMEOUT_MS);

    function handler(topic, payload) {
      if (topic !== RESPONSE_TOPIC) return;
      let data;
      try {
        data = JSON.parse(payload.toString());
      } catch {
        return;
      }
      const result = (data.responses || []).find((r) => r.correlationData === correlationData);
      if (!result) return;

      clearTimeout(timer);
      client.removeListener('message', handler);
      if (result.error) reject(new Error(result.error));
      else resolve(result.data || {});
    }

    client.on('message', handler);
    client.publish(REQUEST_TOPIC, JSON.stringify({ commands: [{ ...command, correlationData }] }));
  });
}

async function exists(client, command) {
  try {
    await sendCommand(client, command);
    return true;
  } catch (err) {
    if (/not found/i.test(err.message)) return false;
    throw err;
  }
}

async function ensureClientRole(client) {
  if (await exists(client, { command: 'getRole', rolename: 'client' })) return;

  await sendCommand(client, { command: 'createRole', rolename: 'client' });
  for (const acltype of ['publishClientSend', 'publishClientReceive', 'subscribePattern', 'unsubscribePattern']) {
    await sendCommand(client, { command: 'addRoleACL', rolename: 'client', acltype, topic: '#', allow: true });
  }
  console.log('Dynamic security bootstrap: created "client" role (full pub/sub on all topics).');
}

async function ensureGatewayAccount(client, username, password) {
  if (await exists(client, { command: 'getClient', username })) return;

  await sendCommand(client, { command: 'createClient', username, password });
  await sendCommand(client, { command: 'addClientRole', username, rolename: 'client' });
  await sendCommand(client, { command: 'addClientRole', username, rolename: 'admin' });
  console.log(`Dynamic security bootstrap: created MQTT client "${username}" with client+admin roles.`);
}

// Idempotent: safe to run on every startup. Lets the gateway's own MQTT account
// (which mqttClient.js is already retrying to connect as) become valid without
// any manual mosquitto_ctrl steps, once the broker is reachable.
function runBootstrap() {
  const adminUsername = process.env.MQTT_ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.MQTT_ADMIN_PASSWORD;
  if (!adminPassword) {
    console.warn('MQTT_ADMIN_PASSWORD not set — skipping dynamic-security bootstrap.');
    return;
  }

  const settings = db.prepare('SELECT * FROM mqtt_settings WHERE id = 1').get();
  const protocol = settings.use_tls ? 'mqtts' : 'mqtt';
  const client = mqtt.connect(`${protocol}://${settings.host}:${settings.port}`, {
    username: adminUsername,
    password: adminPassword,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    client.subscribe(RESPONSE_TOPIC, async (err) => {
      if (err) {
        console.error('Dynamic security bootstrap: subscribe failed:', err.message);
        client.end(true);
        return;
      }
      try {
        await ensureClientRole(client);
        await ensureGatewayAccount(client, settings.username, settings.password);
        console.log('Dynamic security bootstrap complete.');
      } catch (bootstrapErr) {
        console.error('Dynamic security bootstrap failed:', bootstrapErr.message);
      } finally {
        client.end(true);
      }
    });
  });

  client.on('error', (err) => console.error('Dynamic security bootstrap connection error:', err.message));
}

module.exports = { runBootstrap };
