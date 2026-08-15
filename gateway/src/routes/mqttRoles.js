const express = require('express');
const { ACL_TYPES, listRolesVerbose, createRole, deleteRole, addRoleAcl, removeRoleAcl, editRoleAcl } = require('../dynamicSecurity');
const { requirePermission } = require('../middleware/requirePermission');

const router = express.Router();

// These roles are wired into the bootstrap/gateway logic — removing them would
// break the gateway's own broker connection or the default device role.
const PROTECTED_ROLES = ['admin', 'client'];

router.get('/', async (req, res) => {
  try {
    const roles = await listRolesVerbose();
    res.render('mqttRoles', { roles, protectedRoles: PROTECTED_ROLES, aclTypes: ACL_TYPES, error: null });
  } catch (err) {
    res.render('mqttRoles', { roles: [], protectedRoles: PROTECTED_ROLES, aclTypes: ACL_TYPES, error: err.message });
  }
});

router.post('/', requirePermission('mqtt_roles', 'edit'), async (req, res) => {
  const { rolename } = req.body;
  try {
    if (!rolename) throw new Error('Role name is required.');
    await createRole(rolename);
    res.redirect('/mqtt-roles');
  } catch (err) {
    const roles = await listRolesVerbose().catch(() => []);
    res.render('mqttRoles', { roles, protectedRoles: PROTECTED_ROLES, aclTypes: ACL_TYPES, error: err.message });
  }
});

router.post('/:rolename/delete', requirePermission('mqtt_roles', 'edit'), async (req, res) => {
  if (PROTECTED_ROLES.includes(req.params.rolename)) {
    const roles = await listRolesVerbose().catch(() => []);
    return res.render('mqttRoles', {
      roles,
      protectedRoles: PROTECTED_ROLES,
      aclTypes: ACL_TYPES,
      error: `"${req.params.rolename}" is a built-in role used by the gateway and cannot be deleted.`,
    });
  }
  try {
    await deleteRole(req.params.rolename);
  } catch (err) {
    const roles = await listRolesVerbose().catch(() => []);
    return res.render('mqttRoles', { roles, protectedRoles: PROTECTED_ROLES, aclTypes: ACL_TYPES, error: err.message });
  }
  res.redirect('/mqtt-roles');
});

router.post('/:rolename/acls', requirePermission('mqtt_roles', 'edit'), async (req, res) => {
  const { acltype, topic, allow } = req.body;
  try {
    if (!acltype || !topic) throw new Error('ACL type and topic filter are required.');
    await addRoleAcl(req.params.rolename, acltype, topic, allow === '1');
  } catch (err) {
    const roles = await listRolesVerbose().catch(() => []);
    return res.render('mqttRoles', { roles, protectedRoles: PROTECTED_ROLES, aclTypes: ACL_TYPES, error: err.message });
  }
  res.redirect('/mqtt-roles');
});

router.post('/:rolename/acls/edit', requirePermission('mqtt_roles', 'edit'), async (req, res) => {
  const { old_acltype: oldAcltype, old_topic: oldTopic, acltype, topic, allow } = req.body;
  try {
    if (!acltype || !topic) throw new Error('ACL type and topic filter are required.');
    await editRoleAcl(req.params.rolename, oldAcltype, oldTopic, acltype, topic, allow === '1');
  } catch (err) {
    const roles = await listRolesVerbose().catch(() => []);
    return res.render('mqttRoles', { roles, protectedRoles: PROTECTED_ROLES, aclTypes: ACL_TYPES, error: err.message });
  }
  res.redirect('/mqtt-roles');
});

router.post('/:rolename/acls/delete', requirePermission('mqtt_roles', 'edit'), async (req, res) => {
  const { acltype, topic } = req.body;
  try {
    await removeRoleAcl(req.params.rolename, acltype, topic);
  } catch (err) {
    const roles = await listRolesVerbose().catch(() => []);
    return res.render('mqttRoles', { roles, protectedRoles: PROTECTED_ROLES, aclTypes: ACL_TYPES, error: err.message });
  }
  res.redirect('/mqtt-roles');
});

module.exports = router;
