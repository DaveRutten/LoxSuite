const { nanoid } = require('nanoid');
const mqtt = require('mqtt');
const db = require('./db');
const { getClient } = require('./mqttClient');

const REQUEST_TOPIC = '$CONTROL/dynamic-security/v1';
const RESPONSE_TOPIC = '$CONTROL/dynamic-security/v1/response';
const TIMEOUT_MS = 5000;

// Every ACL type Mosquitto's dynsec plugin recognizes (`mosquitto_ctrl dynsec help`'s own
// aclspec line) — shared by routes/mqttRoles.js (a named role's own ACLs) and routes/mqttUsers.js
// (a client's own personal-role ACLs, see personalRoleName below), so the two ACL-editing forms
// can never quietly drift apart on which types are offered.
const ACL_TYPES = ['publishClientSend', 'publishClientReceive', 'subscribePattern', 'unsubscribePattern'];

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

// Mosquitto's dynsec plugin has no "modify ACL" command — (acltype, topic) is an ACL's identity
// within a role, and addRoleACL already upserts allow in place when that pair is unchanged (the
// common case: flipping Allow/Deny on the same topic). Only when the identifying pair itself
// changes (a different topic filter or ACL type) does this need an actual remove — done AFTER the
// add, not before, so a failed add leaves the original ACL intact instead of momentarily leaving
// the role with neither the old nor the new grant.
async function editRoleAcl(rolename, oldAcltype, oldTopic, newAcltype, newTopic, newAllow) {
  await addRoleAcl(rolename, newAcltype, newTopic, newAllow);
  if (newAcltype !== oldAcltype || newTopic !== oldTopic) {
    await removeRoleAcl(rolename, oldAcltype, oldTopic);
  }
}

// Backs Settings > MQTT Broker's "Per-device MQTT roles" toggle: instead of a new device account
// getting the shared `client` role (full publish/subscribe on every topic, "#"), it gets a role
// restricted to just its own topic prefix. Mirrors dynsecBootstrap.js's own full-access grant on
// `client` (same four ACL types), just scoped to "<prefix>/#" instead of "#".
function deviceRoleName(topicPrefix) {
  const slug = topicPrefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `device-${slug}`;
}

async function createDeviceScopedRole(topicPrefix) {
  const prefix = topicPrefix.replace(/^\/+|\/+$/g, '');
  if (!prefix) throw new Error('Device topic prefix is required.');

  const rolename = deviceRoleName(prefix);
  const topic = `${prefix}/#`;

  try {
    await createRole(rolename);
  } catch (err) {
    // Another device already using the same topic prefix created this exact role — reuse it
    // rather than failing the whole "add device" flow over a name collision.
  }
  for (const acltype of ['publishClientSend', 'publishClientReceive', 'subscribePattern', 'unsubscribePattern']) {
    await addRoleAcl(rolename, acltype, topic, true);
  }
  return rolename;
}

// Mosquitto's dynsec plugin has no concept of a per-client ACL at all (confirmed against a real
// broker — `mosquitto_ctrl dynsec help` lists ACLs only under Roles, nothing under Clients) — every
// permission a client has comes from a role, always. What this backs (Settings > MQTT Users' own
// "Extra permissions" section) is really "give ONE client something extra beyond its shared role,
// without touching that role" — done by giving the client a SECOND role, held only by them, that
// only that section's own add/edit/delete ACL actions ever touch. Same slug scheme as
// deviceRoleName above, just its own "personal-" prefix so the two role families can never collide
// — and the same theoretical two-different-usernames-slugify-to-the-same-name risk deviceRoleName
// already accepts, unchanged here.
//
// SECURITY PROPERTY, confirmed empirically against a real broker (createRole/addRoleACL/
// addClientRole/mosquitto_sub, not just read from docs) rather than assumed: a `deny` ACL on the
// client's BASE role always wins over an `allow` on this personal role for the same topic, in
// EITHER role-attach order, at the default (-1/unset) priority both ends up at here — Mosquitto's
// dynsec evaluates "does anything applicable say deny" rather than "first/last matching rule
// wins." A personal role can only ever grant something extra on topics its base role stays silent
// on; it can never re-open something the base role explicitly denies. Whoever manages the base
// role (routes/mqttRoles.js) always has the final word — exactly what this feature was asked for.
// This only holds as long as ensurePersonalRole/addRoleAcl below never pass an explicit priority
// (they don't) — an explicit HIGHER priority on the personal role's own ACL would break this
// guarantee, so don't add one without re-verifying this property against a real broker again.
function personalRoleName(username) {
  const slug = String(username).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `personal-${slug}`;
}

// Idempotent: safe to call every time the "Extra permissions" section actually adds its first ACL,
// not just once — createRole errors (role name taken) are swallowed exactly like
// createDeviceScopedRole's own reuse-if-exists comment above, and addClientRole errors the same way
// since re-adding a role a client already holds errors too (confirmed against a real broker: "addClientRole:
// Error: Internal error", not a silent no-op) — there's no cheap "does this client already have this
// role" check worth making first when the failure mode either way is "nothing changed."
async function ensurePersonalRole(username) {
  const rolename = personalRoleName(username);
  try {
    await createRole(rolename);
  } catch (err) {
    // Already exists from an earlier "extra permission" added for this same user — fine.
  }
  try {
    await addClientRole(username, rolename);
  } catch (err) {
    // Already assigned — fine.
  }
  return rolename;
}

// A one-shot, standalone connection attempt with a specific username/password — used right after
// createClient()/setClientPassword() (see routes/mqttUsers.js), the only moment the plaintext
// password is ever in hand. Unlike a Miniserver, an existing MQTT user's password isn't stored
// anywhere in LoxSuite (dynsec only ever receives it, never returns it) — so there is no
// "re-test this saved user" equivalent to the Miniservers page's per-row "Test now" button; testing
// only ever makes sense in the same request the credential was just set.
async function testClientConnection(username, password, timeoutMs = 5000) {
  const settings = await db.prepare('SELECT * FROM mqtt_settings WHERE id = 1').get();
  const protocol = settings.use_tls ? 'mqtts' : 'mqtt';

  return new Promise((resolve) => {
    const start = Date.now();
    const client = mqtt.connect(`${protocol}://${settings.host}:${settings.port}`, {
      clientId: `loxsuite-test-${nanoid(6)}`,
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
  ACL_TYPES,
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
  editRoleAcl,
  createDeviceScopedRole,
  personalRoleName,
  ensurePersonalRole,
  testClientConnection,
};
