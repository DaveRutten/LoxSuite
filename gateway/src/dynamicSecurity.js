const { nanoid } = require('nanoid');
const mqtt = require('mqtt');
const db = require('./db');
const { getClient } = require('./mqttClient');

const REQUEST_TOPIC = '$CONTROL/dynamic-security/v1';
const RESPONSE_TOPIC = '$CONTROL/dynamic-security/v1/response';
const TIMEOUT_MS = 5000;

// Mosquitto's dynamic-security plugin exposes user/role management over MQTT
// control topics rather than a REST API — see mosquitto_ctrl dynsec help.
function sendCommand(command) {
  return new Promise((resolve, reject) => {
    const client = getClient();
    if (!client) {
      reject(new Error('MQTT client not connected'));
      return;
    }

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

async function listClients() {
  const data = await sendCommand({ command: 'listClients', verbose: true });
  return (data.clients || []).filter((c) => c.username !== 'admin');
}

async function createClient(username, password, rolename = 'client') {
  await sendCommand({ command: 'createClient', username, password });
  await sendCommand({ command: 'addClientRole', username, rolename });
}

async function deleteClient(username) {
  await sendCommand({ command: 'deleteClient', username });
}

async function setClientPassword(username, password) {
  await sendCommand({ command: 'setClientPassword', username, password });
}

async function addClientRole(username, rolename) {
  await sendCommand({ command: 'addClientRole', username, rolename });
}

async function removeClientRole(username, rolename) {
  await sendCommand({ command: 'removeClientRole', username, rolename });
}

async function listRoles() {
  const data = await sendCommand({ command: 'listRoles' });
  return data.roles || [];
}

async function listRolesVerbose() {
  const data = await sendCommand({ command: 'listRoles', verbose: true });
  return data.roles || [];
}

async function createRole(rolename) {
  await sendCommand({ command: 'createRole', rolename });
}

async function deleteRole(rolename) {
  await sendCommand({ command: 'deleteRole', rolename });
}

async function addRoleAcl(rolename, acltype, topic, allow) {
  await sendCommand({ command: 'addRoleACL', rolename, acltype, topic, allow: !!allow });
}

async function removeRoleAcl(rolename, acltype, topic) {
  await sendCommand({ command: 'removeRoleACL', rolename, acltype, topic });
}

// A one-shot, standalone connection attempt with a specific username/password — used right after
// createClient()/setClientPassword() (see routes/mqttUsers.js), the only moment the plaintext
// password is ever in hand. Unlike a Miniserver, an existing MQTT user's password isn't stored
// anywhere in LoxSuite (dynsec only ever receives it, never returns it) — so there is no
// "re-test this saved user" equivalent to the Miniservers page's per-row "Test now" button; testing
// only ever makes sense in the same request the credential was just set.
function testClientConnection(username, password, timeoutMs = 5000) {
  const settings = db.prepare('SELECT * FROM mqtt_settings WHERE id = 1').get();
  const protocol = settings.use_tls ? 'mqtts' : 'mqtt';

  return new Promise((resolve) => {
    const start = Date.now();
    const client = mqtt.connect(`${protocol}://${settings.host}:${settings.port}`, {
      username,
      password,
      connectTimeout: timeoutMs,
      reconnectPeriod: 0, // one-shot — a failed attempt must not keep silently retrying in the background
    });

    let settled = false;
    function finish(ok, error) {
      if (settled) return;
      settled = true;
      client.removeAllListeners();
      client.end(true);
      resolve({ ok, ms: Date.now() - start, error: error || null });
    }

    client.once('connect', () => finish(true));
    client.once('error', (err) => finish(false, err.message));
    setTimeout(() => finish(false, 'Timed out'), timeoutMs);
  });
}

module.exports = {
  listClients,
  createClient,
  deleteClient,
  setClientPassword,
  addClientRole,
  removeClientRole,
  listRoles,
  listRolesVerbose,
  createRole,
  deleteRole,
  addRoleAcl,
  removeRoleAcl,
  testClientConnection,
};
