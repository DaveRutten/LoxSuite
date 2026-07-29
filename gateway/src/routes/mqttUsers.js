const express = require('express');
const {
  listClients,
  createClient,
  deleteClient,
  setClientPassword,
  addClientRole,
  removeClientRole,
  listRoles,
} = require('../dynamicSecurity');
const { getLastSeenByUsername } = require('../mosquittoLog');
const { requirePermission } = require('../middleware/requirePermission');

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

router.get('/', async (req, res) => {
  try {
    const [clients, roles] = await Promise.all([listClients(), listRoles()]);
    res.render('mqttUsers', { clients: withLastSeen(clients), roles, protectedUsernames: PROTECTED_USERNAMES, error: null });
  } catch (err) {
    res.render('mqttUsers', { clients: [], roles: ['client'], protectedUsernames: PROTECTED_USERNAMES, error: err.message });
  }
});

router.post('/', requirePermission('mqtt_users', 'edit'), async (req, res) => {
  const { username, password, rolename } = req.body;
  try {
    if (!username || !password) throw new Error('Username and password are required.');
    await createClient(username, password, rolename || 'client');
    res.redirect('/mqtt-users');
  } catch (err) {
    const [clients, roles] = await Promise.all([listClients().catch(() => []), listRoles().catch(() => ['client'])]);
    res.render('mqttUsers', { clients: withLastSeen(clients), roles, protectedUsernames: PROTECTED_USERNAMES, error: err.message });
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
    res.redirect('/mqtt-users');
  } catch (err) {
    const [clients, roles] = await Promise.all([listClients().catch(() => []), listRoles().catch(() => ['client'])]);
    res.render('mqttUsers', { clients: withLastSeen(clients), roles, protectedUsernames: PROTECTED_USERNAMES, error: err.message });
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
    const [clients, roles] = await Promise.all([listClients().catch(() => []), listRoles().catch(() => ['client'])]);
    res.render('mqttUsers', { clients: withLastSeen(clients), roles, protectedUsernames: PROTECTED_USERNAMES, error: err.message });
  }
});

router.post('/:username/delete', requirePermission('mqtt_users', 'edit'), async (req, res) => {
  if (PROTECTED_USERNAMES.includes(req.params.username)) {
    const [clients, roles] = await Promise.all([listClients().catch(() => []), listRoles().catch(() => ['client'])]);
    return res.render('mqttUsers', {
      clients: withLastSeen(clients),
      roles,
      protectedUsernames: PROTECTED_USERNAMES,
      error: `"${req.params.username}" is the gateway's own account and cannot be deleted.`,
    });
  }

  try {
    await deleteClient(req.params.username);
  } catch (err) {
    const [clients, roles] = await Promise.all([listClients().catch(() => []), listRoles().catch(() => ['client'])]);
    return res.render('mqttUsers', { clients: withLastSeen(clients), roles, protectedUsernames: PROTECTED_USERNAMES, error: err.message });
  }
  res.redirect('/mqtt-users');
});

module.exports = router;
