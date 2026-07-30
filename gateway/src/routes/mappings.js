const express = require('express');
const dgram = require('dgram');
const { nanoid } = require('nanoid');
const db = require('../db');
const { CATALOG } = require('../commandCatalog');
const { getClient } = require('../mqttClient');
const { applyLoxoneToMqttTransform } = require('../loxone');
const { discoverDevices } = require('../deviceDiscovery');
const { requirePermission } = require('../middleware/requirePermission');

const router = express.Router();

// This one router serves three distinct Access Roles areas by URL prefix (mqtt_to_loxone,
// loxone_to_mqtt, commands) — each GET/POST below is gated individually rather than once at the
// app.use() mount in server.js.
router.use('/mqtt-to-loxone', requirePermission('mqtt_to_loxone', 'view'));
router.use('/loxone-to-mqtt', requirePermission('loxone_to_mqtt', 'view'));
router.use('/commands', requirePermission('commands', 'view'));

function loadMqttToLoxoneView() {
  return db.prepare(
    `SELECT m.*, ms.name AS miniserver_name
     FROM mappings_mqtt_to_loxone m
     JOIN miniservers ms ON ms.id = m.miniserver_id
     ORDER BY m.mqtt_topic`
  ).all();
}

const loxoneTranslationValuesStmt = db.prepare('SELECT match_value FROM loxone_mapping_translations WHERE mapping_id = ? ORDER BY match_value');

function loadLoxoneToMqttView(baseUrl) {
  const udpPort = process.env.LOXONE_UDP_PORT || 11885;
  return db.prepare(
    `SELECT l.*, ms.name AS miniserver_name
     FROM mappings_loxone_to_mqtt l
     LEFT JOIN miniservers ms ON ms.id = l.miniserver_id
     ORDER BY l.mqtt_topic`
  ).all().map((row) => ({
    ...row,
    callbackUrl: `${baseUrl}/api/loxone-in/${row.token}?value=\\v`,
    udpMessage: `${row.token}=\\v`,
    udpPort,
    // Powers the Test row's value picker — for a translation_table mapping, only these inputs are
    // actually meaningful to "send as if from Loxone" (anything else has no defined translation
    // and would forward untouched, which is rarely what testing that kind of mapping is for).
    translationValues: row.value_transform === 'translation_table'
      ? loxoneTranslationValuesStmt.all(row.id).map((t) => t.match_value)
      : null,
  }));
}

router.get('/mqtt-to-loxone', (req, res) => {
  const mappings = loadMqttToLoxoneView();
  const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY name').all();
  res.render('mappings-mqtt-to-loxone', { mappings, miniservers, error: null, prefillTopic: req.query.topic || '' });
});

router.post('/mqtt-to-loxone', requirePermission('mqtt_to_loxone', 'edit'), (req, res) => {
  const { miniserver_id, mqtt_topic, transport, target, value_transform, transform_arg, min_interval_ms } = req.body;
  db.prepare(
    `INSERT INTO mappings_mqtt_to_loxone (miniserver_id, mqtt_topic, transport, target, value_transform, transform_arg, min_interval_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(miniserver_id, mqtt_topic, transport, target, value_transform, transform_arg || null, Number(min_interval_ms) || 0);

  res.redirect('/mappings/mqtt-to-loxone');
});

router.get('/mqtt-to-loxone/:id/edit', (req, res) => {
  const mapping = db.prepare('SELECT * FROM mappings_mqtt_to_loxone WHERE id = ?').get(req.params.id);
  if (!mapping) return res.status(404).send('Mapping not found');
  const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY name').all();
  res.render('mapping-mqtt-to-loxone-edit', { mapping, miniservers, error: null });
});

router.post('/mqtt-to-loxone/:id/update', requirePermission('mqtt_to_loxone', 'edit'), (req, res) => {
  const { miniserver_id, mqtt_topic, transport, target, value_transform, transform_arg, min_interval_ms } = req.body;
  db.prepare(
    `UPDATE mappings_mqtt_to_loxone
     SET miniserver_id = ?, mqtt_topic = ?, transport = ?, target = ?, value_transform = ?, transform_arg = ?, min_interval_ms = ?
     WHERE id = ?`
  ).run(miniserver_id, mqtt_topic, transport, target, value_transform, transform_arg || null, Number(min_interval_ms) || 0, req.params.id);

  res.redirect('/mappings/mqtt-to-loxone');
});

router.post('/mqtt-to-loxone/:id/toggle', requirePermission('mqtt_to_loxone', 'edit'), (req, res) => {
  db.prepare('UPDATE mappings_mqtt_to_loxone SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  res.redirect('/mappings/mqtt-to-loxone');
});

router.post('/mqtt-to-loxone/enable-all', requirePermission('mqtt_to_loxone', 'edit'), (req, res) => {
  db.prepare('UPDATE mappings_mqtt_to_loxone SET enabled = 1').run();
  res.redirect('/mappings/mqtt-to-loxone');
});

router.post('/mqtt-to-loxone/disable-all', requirePermission('mqtt_to_loxone', 'edit'), (req, res) => {
  db.prepare('UPDATE mappings_mqtt_to_loxone SET enabled = 0').run();
  res.redirect('/mappings/mqtt-to-loxone');
});

router.post('/mqtt-to-loxone/:id/delete', requirePermission('mqtt_to_loxone', 'edit'), (req, res) => {
  db.prepare('DELETE FROM mappings_mqtt_to_loxone WHERE id = ?').run(req.params.id);
  res.redirect('/mappings/mqtt-to-loxone');
});

router.get('/mqtt-to-loxone/:id/translations', (req, res) => {
  const mapping = db.prepare(
    `SELECT m.*, ms.name AS miniserver_name FROM mappings_mqtt_to_loxone m
     JOIN miniservers ms ON ms.id = m.miniserver_id WHERE m.id = ?`
  ).get(req.params.id);
  if (!mapping) return res.status(404).send('Mapping not found');

  const translations = db.prepare('SELECT * FROM mapping_translations WHERE mapping_id = ? ORDER BY match_value').all(mapping.id);
  res.render('mapping-translations', { mapping, translations, error: null });
});

router.post('/mqtt-to-loxone/:id/translations', requirePermission('mqtt_to_loxone', 'edit'), (req, res) => {
  const { match_value, output_value } = req.body;
  try {
    db.prepare('INSERT INTO mapping_translations (mapping_id, match_value, output_value) VALUES (?, ?, ?)')
      .run(req.params.id, match_value, output_value);
  } catch (err) {
    // likely a duplicate match_value for this mapping — ignore, the UNIQUE constraint protects data integrity
  }
  res.redirect(`/mappings/mqtt-to-loxone/${req.params.id}/translations`);
});

router.post('/mqtt-to-loxone/:id/translations/:translationId/delete', requirePermission('mqtt_to_loxone', 'edit'), (req, res) => {
  db.prepare('DELETE FROM mapping_translations WHERE id = ? AND mapping_id = ?').run(req.params.translationId, req.params.id);
  res.redirect(`/mappings/mqtt-to-loxone/${req.params.id}/translations`);
});

router.get('/commands', (req, res) => {
  const { devicesByFamily, deviceFamily, allDevices } = discoverDevices();

  res.render('mappings-commands', {
    catalog: CATALOG,
    devicesByFamily,
    deviceFamily,
    allDevices,
    presetFamily: req.query.family || (CATALOG[0] && CATALOG[0].key) || '',
    presetDevice: req.query.device || '',
  });
});

router.get('/loxone-to-mqtt', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const mappings = loadLoxoneToMqttView(baseUrl);
  const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY name').all();
  res.render('mappings-loxone-to-mqtt', { mappings, miniservers, error: null, prefillTopic: req.query.topic || '' });
});

router.post('/loxone-to-mqtt', requirePermission('loxone_to_mqtt', 'edit'), (req, res) => {
  const { miniserver_id, mqtt_topic, qos, retain, transport, value_transform } = req.body;
  const token = nanoid(16);

  db.prepare(
    `INSERT INTO mappings_loxone_to_mqtt (miniserver_id, token, mqtt_topic, qos, retain, transport, value_transform)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    miniserver_id ? Number(miniserver_id) : null,
    token,
    mqtt_topic,
    Number(qos) || 0,
    retain ? 1 : 0,
    transport === 'udp' ? 'udp' : 'http',
    value_transform === 'translation_table' ? 'translation_table' : 'passthrough'
  );

  res.redirect('/mappings/loxone-to-mqtt');
});

router.get('/loxone-to-mqtt/:id/edit', (req, res) => {
  const mapping = db.prepare('SELECT * FROM mappings_loxone_to_mqtt WHERE id = ?').get(req.params.id);
  if (!mapping) return res.status(404).send('Mapping not found');
  const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY name').all();
  res.render('mapping-loxone-to-mqtt-edit', { mapping, miniservers, error: null });
});

router.post('/loxone-to-mqtt/:id/update', requirePermission('loxone_to_mqtt', 'edit'), (req, res) => {
  const { miniserver_id, mqtt_topic, qos, retain, transport, value_transform } = req.body;
  const token = (req.body.token || '').trim();

  if (!token) {
    const mapping = db.prepare('SELECT * FROM mappings_loxone_to_mqtt WHERE id = ?').get(req.params.id);
    const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY name').all();
    return res.render('mapping-loxone-to-mqtt-edit', { mapping, miniservers, error: 'Token is required.' });
  }

  try {
    db.prepare(
      `UPDATE mappings_loxone_to_mqtt
       SET token = ?, miniserver_id = ?, mqtt_topic = ?, qos = ?, retain = ?, transport = ?, value_transform = ?
       WHERE id = ?`
    ).run(
      token,
      miniserver_id ? Number(miniserver_id) : null,
      mqtt_topic,
      Number(qos) || 0,
      retain ? 1 : 0,
      transport === 'udp' ? 'udp' : 'http',
      value_transform === 'translation_table' ? 'translation_table' : 'passthrough',
      req.params.id
    );
  } catch (err) {
    // token has a UNIQUE constraint — the only realistic way this UPDATE fails.
    const mapping = db.prepare('SELECT * FROM mappings_loxone_to_mqtt WHERE id = ?').get(req.params.id);
    const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY name').all();
    return res.render('mapping-loxone-to-mqtt-edit', { mapping, miniservers, error: `"${token}" is already used by another mapping — tokens must be unique.` });
  }

  res.redirect('/mappings/loxone-to-mqtt');
});

// Exercises the *real* inbound path instead of re-implementing it here: for an HTTP mapping this
// calls the gateway's own /api/loxone-in/<token> endpoint (the exact URL Loxone's Virtual Output
// would call), and for a UDP mapping it sends the exact "<token>=<value>" datagram Loxone would
// send to the UDP listener. That way "Test" proves the token lookup, transform, and publish all
// actually work end-to-end, not just that a publish call by itself succeeds.
router.post('/loxone-to-mqtt/:id/test', requirePermission('loxone_to_mqtt', 'edit'), async (req, res) => {
  const mapping = db.prepare('SELECT * FROM mappings_loxone_to_mqtt WHERE id = ?').get(req.params.id);
  if (!mapping) return res.status(404).json({ ok: false, error: 'Mapping not found.' });

  const rawValue = (req.body.value || '').toString();
  if (!rawValue) return res.status(400).json({ ok: false, error: 'Enter a value to send.' });

  if (mapping.transport === 'udp') {
    const port = Number(process.env.LOXONE_UDP_PORT) || 11885;
    const message = `${mapping.token}=${rawValue}`;
    const socket = dgram.createSocket('udp4');
    socket.send(Buffer.from(message), port, '127.0.0.1', (err) => {
      socket.close();
      if (err) return res.status(502).json({ ok: false, error: err.message });
      // UDP is fire-and-forget on the real Loxone side too, so there's no publish confirmation
      // to relay here — this shows what the listener will apply the transform to, not proof it landed.
      const expectedValue = applyLoxoneToMqttTransform(mapping, rawValue);
      res.json({
        ok: true,
        topic: mapping.mqtt_topic,
        sentValue: String(expectedValue),
        via: `UDP "${message}" → 127.0.0.1:${port}, same as a real Loxone Virtual UDP Output`,
      });
    });
    return;
  }

  const port = process.env.PORT || 3000;
  const url = `http://127.0.0.1:${port}/api/loxone-in/${mapping.token}?value=${encodeURIComponent(rawValue)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return res.status(502).json({ ok: false, error: `Inbound endpoint responded ${response.status}${text ? `: ${text}` : ''}` });
    }
    const data = await response.json();
    res.json({ ok: true, topic: data.topic, sentValue: data.value, via: `HTTP GET ${url}, same URL Loxone's Virtual Output would call` });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

router.post('/loxone-to-mqtt/:id/toggle', requirePermission('loxone_to_mqtt', 'edit'), (req, res) => {
  db.prepare('UPDATE mappings_loxone_to_mqtt SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  res.redirect('/mappings/loxone-to-mqtt');
});

router.post('/loxone-to-mqtt/enable-all', requirePermission('loxone_to_mqtt', 'edit'), (req, res) => {
  db.prepare('UPDATE mappings_loxone_to_mqtt SET enabled = 1').run();
  res.redirect('/mappings/loxone-to-mqtt');
});

router.post('/loxone-to-mqtt/disable-all', requirePermission('loxone_to_mqtt', 'edit'), (req, res) => {
  db.prepare('UPDATE mappings_loxone_to_mqtt SET enabled = 0').run();
  res.redirect('/mappings/loxone-to-mqtt');
});

router.post('/loxone-to-mqtt/:id/delete', requirePermission('loxone_to_mqtt', 'edit'), (req, res) => {
  db.prepare('DELETE FROM mappings_loxone_to_mqtt WHERE id = ?').run(req.params.id);
  res.redirect('/mappings/loxone-to-mqtt');
});

router.get('/loxone-to-mqtt/:id/translations', (req, res) => {
  const mapping = db.prepare(
    `SELECT l.*, ms.name AS miniserver_name FROM mappings_loxone_to_mqtt l
     LEFT JOIN miniservers ms ON ms.id = l.miniserver_id WHERE l.id = ?`
  ).get(req.params.id);
  if (!mapping) return res.status(404).send('Mapping not found');

  const translations = db.prepare('SELECT * FROM loxone_mapping_translations WHERE mapping_id = ? ORDER BY match_value').all(mapping.id);
  res.render('loxone-mapping-translations', { mapping, translations, error: null });
});

router.post('/loxone-to-mqtt/:id/translations', requirePermission('loxone_to_mqtt', 'edit'), (req, res) => {
  const { match_value, output_value } = req.body;
  try {
    db.prepare('INSERT INTO loxone_mapping_translations (mapping_id, match_value, output_value) VALUES (?, ?, ?)')
      .run(req.params.id, match_value, output_value);
  } catch (err) {
    // likely a duplicate match_value for this mapping — ignore, the UNIQUE constraint protects data integrity
  }
  res.redirect(`/mappings/loxone-to-mqtt/${req.params.id}/translations`);
});

router.post('/loxone-to-mqtt/:id/translations/:translationId/delete', requirePermission('loxone_to_mqtt', 'edit'), (req, res) => {
  db.prepare('DELETE FROM loxone_mapping_translations WHERE id = ? AND mapping_id = ?').run(req.params.translationId, req.params.id);
  res.redirect(`/mappings/loxone-to-mqtt/${req.params.id}/translations`);
});

module.exports = router;
