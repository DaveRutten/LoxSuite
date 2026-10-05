// "Use in Monitor": which of a set of published MQTT topics already have a monitor, and adding the
// chosen ones (vehicle page, OCPP statistics). The pages show monitored values as checked and linked,
// so what was added before is visible again after a reload or an update.
const db = require('./db');

// topics: { key: topic } -> { key: monitorId } for the keys that are monitored already.
async function monitoredMap(topics) {
  const list = Object.values(topics);
  if (!list.length) return {};
  const rows = await db.prepare(`SELECT id, mqtt_topic FROM monitors WHERE source_type = 'mqtt' AND mqtt_topic IN (${list.map(() => '?').join(', ')})`).all(...list);
  const byTopic = new Map(rows.map((r) => [r.mqtt_topic, r.id]));
  const out = {};
  for (const [k, t] of Object.entries(topics)) if (byTopic.has(t)) out[k] = byTopic.get(t);
  return out;
}

// Adds monitors for the wanted keys that don't have one yet. -> { created, skipped, ids }
async function addMonitors(topics, wanted, labelOf) {
  const created = [];
  const skipped = [];
  for (const key of wanted) {
    const topic = topics[key];
    const exists = await db.prepare("SELECT id FROM monitors WHERE source_type = 'mqtt' AND mqtt_topic = ?").get(topic);
    if (exists) { skipped.push(key); continue; }
    await db.prepare("INSERT INTO monitors (source_type, label, mqtt_topic, enabled, created_at, config) VALUES ('mqtt', ?, ?, 1, ?, '{}')")
      .run(labelOf(key), topic, new Date().toISOString());
    created.push(key);
  }
  if (created.length) await require('./monitorCollector').reloadMqttMonitors();
  return { created, skipped, ids: await monitoredMap(topics) };
}

module.exports = { monitoredMap, addMonitors };
