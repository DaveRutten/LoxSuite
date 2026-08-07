const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const mqttToLoxone = db.prepare(
    `SELECT m.*, ms.name AS miniserver_name,
       (SELECT COUNT(*) FROM mapping_translations t WHERE t.mapping_id = m.id) AS translation_count
     FROM mappings_mqtt_to_loxone m
     JOIN miniservers ms ON ms.id = m.miniserver_id
     WHERE m.value_transform = 'translation_table'
     ORDER BY m.mqtt_topic`
  ).all();

  const loxoneToMqtt = db.prepare(
    `SELECT l.*, ms.name AS miniserver_name,
       (SELECT COUNT(*) FROM loxone_mapping_translations t WHERE t.mapping_id = l.id) AS translation_count
     FROM mappings_loxone_to_mqtt l
     LEFT JOIN miniservers ms ON ms.id = l.miniserver_id
     WHERE l.value_transform = 'translation_table'
     ORDER BY l.mqtt_topic`
  ).all();

  res.render('transformations', { mqttToLoxone, loxoneToMqtt });
});

router.get('/data/mqtt-to-loxone.json', (req, res) => {
  const rows = db.prepare(
    `SELECT m.id, m.mqtt_topic AS mqttTopic, ms.name AS miniserverName, m.target,
       m.transport, m.enabled, m.min_interval_ms AS minIntervalMs,
       (SELECT COUNT(*) FROM mapping_translations t WHERE t.mapping_id = m.id) AS translationCount
     FROM mappings_mqtt_to_loxone m
     JOIN miniservers ms ON ms.id = m.miniserver_id
     WHERE m.value_transform = 'translation_table'
     ORDER BY m.mqtt_topic`
  ).all().map((r) => ({ ...r, enabled: !!r.enabled }));
  res.json(rows);
});

router.get('/data/loxone-to-mqtt.json', (req, res) => {
  const rows = db.prepare(
    `SELECT l.id, l.mqtt_topic AS mqttTopic, ms.name AS miniserverName,
       l.token, l.transport, l.qos, l.retain, l.enabled,
       (SELECT COUNT(*) FROM loxone_mapping_translations t WHERE t.mapping_id = l.id) AS translationCount
     FROM mappings_loxone_to_mqtt l
     LEFT JOIN miniservers ms ON ms.id = l.miniserver_id
     WHERE l.value_transform = 'translation_table'
     ORDER BY l.mqtt_topic`
  ).all().map((r) => ({ ...r, retain: !!r.retain, enabled: !!r.enabled }));
  res.json(rows);
});

module.exports = router;
