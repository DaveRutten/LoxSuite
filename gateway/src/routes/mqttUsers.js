const express = require('express');
const {
  ACL_TYPES,
  listClients,
  createClient,
  deleteClient,
  setClientPassword,
  addClientRole,
  removeClientRole,
  listRolesVerbose,
  createDeviceScopedRole,
  addRoleAcl,
  removeRoleAcl,
  editRoleAcl,
  deleteRole,
  personalRoleName,
  ensurePersonalRole,
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

// Each client's own "Extra permissions" section (see dynamicSecurity.js's own personalRoleName
// comment on why this is a second, per-client-only role rather than a real per-client ACL) needs
// two things the base listClients() call doesn't give it: which of a client's roles is its
// "real"/base one vs its own personal one, and that personal role's actual ACLs to show as
// editable. rolesByName answers the second; this answers the first, and also strips the personal
// role out of the plain roles array so it can never show up as a pickable option in the base-role
// <select> (picking your own personal role as your base role would be nonsensical) or get removed
// by the base-role save handler below (see its own comment on why that matters).
function withPersonalRoleSplit(clients) {
  return clients.map((c) => {
    const ownPersonalRole = personalRoleName(c.username);
    return {
      ...c,
      personalRoleName: ownPersonalRole,
      baseRoles: (c.roles || []).filter((r) => r.rolename !== ownPersonalRole),
    };
  });
}

async function loadAutoScopeDeviceRoles() {
  return !!(await db.prepare('SELECT auto_scope_device_roles FROM gateway_settings WHERE id = 1').get())?.auto_scope_device_roles;
}

async function renderPage(res, extra = {}) {
  const [clients, verboseRoles] = await Promise.all([listClients().catch(() => []), listRolesVerbose().catch(() => [])]);
  // rolesByName feeds both the base-role <select> options (its own keys, minus any "personal-*"
  // role — those only ever get created/managed through a specific client's own "Extra permissions"
  // section, never picked as anyone's base role) and each client row's read-only "inherited from
  // role" ACL list (looked up by rolename, see withPersonalRoleSplit above).
  const rolesByName = Object.fromEntries(verboseRoles.map((r) => [r.rolename, r]));
  const roles = verboseRoles.map((r) => r.rolename).filter((name) => !name.startsWith('personal-'));
  res.render('mqttUsers', {
    clients: withPersonalRoleSplit(withLastSeen(clients)),
    roles: roles.length ? roles : ['client'],
    rolesByName,
    aclTypes: ACL_TYPES,
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
    res.render('mqttUsers', {
      clients: [], roles: ['client'], rolesByName: {}, aclTypes: ACL_TYPES, protectedUsernames: PROTECTED_USERNAMES,
      autoScopeDeviceRoles: await loadAutoScopeDeviceRoles(), error: err.message, testResult: null,
    });
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

    // previous_roles' hidden field (see mqttUsers.ejs) already excludes this user's own personal
    // role, but that exclusion is filtered again here too — this handler must never be the thing
    // that strips someone's "Extra permissions" role just because they changed their base role.
    const ownPersonalRole = personalRoleName(username);
    const currentRoles = (previous_roles || '').split(',').map((r) => r.trim()).filter((r) => r && r !== ownPersonalRole);
    for (const oldRole of currentRoles) {
      if (oldRole !== rolename) await removeClientRole(username, oldRole);
    }
    if (!currentRoles.includes(rolename)) await addClientRole(username, rolename);

    res.redirect('/mqtt-users');
  } catch (err) {
    await renderPage(res, { error: err.message });
  }
});

// The three "Extra permissions" actions below all operate on one client's own personal role (see
// dynamicSecurity.js's own personalRoleName/ensurePersonalRole comments) — same
// add/edit/delete-ACL shape routes/mqttRoles.js already offers for a named role, just scoped to
// the one role a specific client alone holds, auto-created on its own first ACL here.
router.post('/:username/acls', requirePermission('mqtt_users', 'edit'), async (req, res) => {
  const { username } = req.params;
  const { acltype, topic, allow } = req.body;
  try {
    if (PROTECTED_USERNAMES.includes(username)) {
      throw new Error(`"${username}" is the gateway's own account — it already has full access and needs no extra permissions.`);
    }
    if (!acltype || !topic) throw new Error('ACL type and topic filter are required.');
    const rolename = await ensurePersonalRole(username);
    await addRoleAcl(rolename, acltype, topic, allow === '1');
    res.redirect('/mqtt-users');
  } catch (err) {
    await renderPage(res, { error: err.message });
  }
});

router.post('/:username/acls/edit', requirePermission('mqtt_users', 'edit'), async (req, res) => {
  const { username } = req.params;
  const { old_acltype: oldAcltype, old_topic: oldTopic, acltype, topic, allow } = req.body;
  try {
    if (!acltype || !topic) throw new Error('ACL type and topic filter are required.');
    await editRoleAcl(personalRoleName(username), oldAcltype, oldTopic, acltype, topic, allow === '1');
    res.redirect('/mqtt-users');
  } catch (err) {
    await renderPage(res, { error: err.message });
  }
});

router.post('/:username/acls/delete', requirePermission('mqtt_users', 'edit'), async (req, res) => {
  const { username } = req.params;
  const { acltype, topic } = req.body;
  try {
    await removeRoleAcl(personalRoleName(username), acltype, topic);
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
  // Best-effort cleanup of this user's own "Extra permissions" role, if it ever created one —
  // deleteRole errors (role never existed, this user never used the feature) are swallowed rather
  // than surfaced, the same "not found is fine here" treatment dynsecBootstrap.js's own exists()
  // helper gives the identical situation, since the client itself is already gone either way by
  // this point and a leftover, now-unassigned personal role is harmless clutter, not a real error.
  await deleteRole(personalRoleName(req.params.username)).catch(() => {});
  res.redirect('/mqtt-users');
});

module.exports = router;
