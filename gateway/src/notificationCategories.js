// The notification center's categories: which kind of notification (event_type) belongs where, for the
// bell's chips and the filters of the Notifications page (routes/notificationCenter.js).
const CATEGORIES = [
  { key: 'energy', label: 'Energy', icon: 'bolt', types: ['energy_device', 'energy_meter_status'] },
  { key: 'quality', label: 'Set-up & data', icon: 'gauge', types: ['energy_config'] },
  { key: 'charging', label: 'Car & charging', icon: 'car', types: ['car_reminder', 'charging_plan', 'car_climate', 'vehicle_source_status'] },
  { key: 'loxone', label: 'Loxone', icon: 'server', types: ['miniserver_status', 'firmware_changed', 'gateway_client_firmware_mismatch', 'battery_weak', 'device_firmware_changed', 'device_offline'] },
  { key: 'monitor', label: 'Monitor', icon: 'chart', types: ['monitor_threshold', 'threshold_ladder', 'mqtt_client_status'] },
  { key: 'system', label: 'LoxSuite', icon: 'shield', types: ['system_check', 'backup_failed', 'backup_succeeded', 'loxsuite_update_available', 'ai_ollama_pull'] },
];
const BY_TYPE = new Map(CATEGORIES.flatMap((c) => c.types.map((t) => [t, c])));
const OTHER = { key: 'other', label: 'Other', icon: 'bulb', types: [] };

// Pure: the category of an event type (Other when unknown).
function categoryOf(eventType) { return BY_TYPE.get(eventType) || OTHER; }

// Pure: events -> groups per local day, newest first: [{ day, events }]. dayOf(iso) -> 'YYYY-MM-DD'.
function byDay(events, dayOf) {
  const out = [];
  for (const e of events || []) {
    const d = dayOf(e.created_at);
    if (!out.length || out[out.length - 1].day !== d) out.push({ day: d, events: [] });
    out[out.length - 1].events.push(e);
  }
  return out;
}

module.exports = { CATEGORIES, OTHER, categoryOf, byDay };
