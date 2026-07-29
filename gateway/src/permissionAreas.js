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
  { key: 'incoming', label: 'Live traffic' },
  { key: 'logs', label: 'Logs' },
  { key: 'mqtt_users', label: 'MQTT Users' },
  { key: 'mqtt_roles', label: 'MQTT Roles' },
  { key: 'settings', label: 'Settings' },
];

const AREA_KEYS = AREAS.map((a) => a.key);

module.exports = { AREAS, AREA_KEYS };
