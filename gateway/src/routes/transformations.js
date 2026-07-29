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

module.exports = router;
