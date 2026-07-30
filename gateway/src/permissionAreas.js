// The fixed set of view/edit-gated pages (Access Roles' permission matrix). Shared between the
// DB seed (db.js), the permission-check middleware, and the Administration UI so the list only
// exists in one place.
const AREAS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'monitor', label: 'Monitor' },
  { key: 'miniservers', label: 'Miniservers' },
  { key: 'mqtt_to_loxone', label: 'MQTT → Loxone' },
  { key: 'loxone_to_mqtt', label: 'Loxone → MQTT' },
  { key: 'commands', label: 'Common commands' },
  { key: 'transformations', label: 'Transformations' },
  { key: 'incoming', label: 'Live Data (MQTT)' },
  { key: 'logs', label: 'Logs' },
  { key: 'mqtt_users', label: 'MQTT Users' },
  { key: 'mqtt_roles', label: 'MQTT Roles' },
  { key: 'settings', label: 'Settings' },
  // Edit here means "can grant a whole Access Role access to a dashboard they own" (see
  // dashboards.js's canManageRoleShares) — separate from the plain 'dashboard' area's edit, which
  // only covers a single dashboard's own panels/sharing with individual users. Deliberately not
  // folded into 'dashboard' itself: handing out access to an entire group at once is a bigger,
  // less reversible action than either of those, so a role can be trusted with one but not both.
  { key: 'dashboard_group_share', label: 'Dashboard: share with groups' },
  // Edit here means "can rename/delete a personal dashboard someone else owns, when shared with
  // this user as an editor" (see dashboards.js's canManageDashboard) — normally that stays
  // owner-only no matter how permissive the share is, since deleting someone else's dashboard is
  // a step beyond editing its panels; a role granted this can go that one step further.
  { key: 'dashboard_manage_shared', label: 'Dashboard: rename/delete dashboards shared with you' },
];

const AREA_KEYS = AREAS.map((a) => a.key);

module.exports = { AREAS, AREA_KEYS };
