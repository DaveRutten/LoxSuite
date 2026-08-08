const express = require('express');
const {
  listClients,
  createClient,
  deleteClient,
  setClientPassword,
  addClientRole,
  removeClientRole,
  listRoles,
  createDeviceScopedRole,
  testClientConnection,
} = require('../dynamicSecurity');
const { getLastSeenByUsername } = require('../mosquittoLog');
const { requirePermission } = require('../middleware/requirePermission');
const db = require('../db');

const router = express.Router();

// The gateway's own account must never be removable from the UI — deleting it
// would lock the gateway itself out of the broker.
const PROTECTED_USERNAMES = ['gateway'];

// dynamicSecurity's listClients() only knows the broker's configured accounts, not when they were
// last active — that comes from mosquittoLog.js's tail of the broker's own log (see its comment),
// so this stitches the two together by username for the table below.
function withLastSeen(clients) {
  const lastSeen = getLastSeenByUsername();
  return clients.map((c) => ({ ...c, lastSeen: lastSeen.get(c.username) || null }));
}

async function loadAutoScopeDeviceRoles() {
  return !!(await db.prepare('SELECT auto_scope_device_roles FROM gateway_settings WHERE id = 1').get())?.auto_scope_device_roles;
}

async function renderPage(res, extra = {}) {
  const [clients, roles] = await Promise.all([listClients().catch(() => []), listRoles().catch(() => ['client'])]);
  res.render('mqttUsers', {
    clients: withLastSeen(clients),
    roles,
    protectedUsernames: PROTECTED_USERNAMES,
    autoScopeDeviceRoles: await loadAutoScopeDeviceRoles(),
    error: null,
    testResult: null,
    ...extra,
  });
}

router.get('/', async (req, res) => {
  try {
    await renderPage(res);
  } catch (err) {
    res.render('mqttUsers', { clients: [], roles: ['client'], protectedUsernames: PROTECTED_USERNAMES, autoScopeDeviceRoles: await loadAutoScopeDeviceRoles(), error: err.message, testResult: null });
  }
});

router.post('/', requirePermission('mqtt_users', 'edit'), async (req, res) => {
  const { username, password, rolename, device_topic_prefix } = req.body;
  try {
    if (!username || !password) throw new Error('Username and password are required.');

    // "Per-device MQTT roles" (Settings > MQTT Broker): a filled-in topic prefix creates and
    // assigns a role scoped to just that device's own topics instead of the shared `client` role
    // picked from the dropdown. An empty prefix falls back to that dropdown untouched, same as
    // when the setting is off.
    let effectiveRole = rolename || 'client';
    if ((await loadAutoScopeDeviceRoles()) && (device_topic_prefix || '').trim()) {
      effectiveRole = await createDeviceScopedRole(device_topic_prefix.trim());
    }

    await createClient(username, password, effectiveRole);
    // The only moment the plaintext password is ever in hand (see dynamicSecurity.js's
    // testClientConnection comment) — test it right away instead of leaving "does this actually
    // work" to be discovered only once a real device tries and silently fails to connect.
    const test = await testClientConnection(username, password);
    await renderPage(res, { testResult: { username, ...test } });
  } catch (err) {
    await renderPage(res, { error: err.message });
  }
});

router.post('/:username/password', requirePermission('mqtt_users', 'edit'), async (req, res) => {
  const { username } = req.params;
  const { password } = req.body;
  try {
    if (PROTECTED_USERNAMES.includes(username)) {
      throw new Error(`"${username}" is the gateway's own account — its password is managed on the Settings page.`);
    }
    if (!password) throw new Error('Password is required.');
    await setClientPassword(username, password);
    const test = await testClientConnection(username, password);
    await renderPage(res, { testResult: { username, ...test } });
  } catch (err) {
    await renderPage(res, { error: err.message });
  }
});

router.post('/:username/role', requirePermission('mqtt_users', 'edit'), async (req, res) => {
  const { username } = req.params;
  const { rolename, previous_roles } = req.body;
  try {
    if (PROTECTED_USERNAMES.includes(username)) {
      throw new Error(`"${username}" is the gateway's own account — its role cannot be changed here.`);
    }
    if (!rolename) throw new Error('Role is required.');

    const currentRoles = (previous_roles || '').split(',').map((r) => r.trim()).filter(Boolean);
    for (const oldRole of currentRoles) {
      if (oldRole !== rolename) await removeClientRole(username, oldRole);
    }
    if (!currentRoles.includes(rolename)) await addClientRole(username, rolename);

    res.redirect('/mqtt-users');
  } catch (err) {
    await renderPage(res, { error: err.message });
  }
});

router.post('/:username/delete', requirePermission('mqtt_users', 'edit'), async (req, res) => {
  if (PROTECTED_USERNAMES.includes(req.params.username)) {
    return renderPage(res, { error: `"${req.params.username}" is the gateway's own account and cannot be deleted.` });
  }

  try {
    await deleteClient(req.params.username);
  } catch (err) {
    return renderPage(res, { error: err.message });
  }
  res.redirect('/mqtt-users');
});

module.exports = router;
