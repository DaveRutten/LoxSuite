const express = require('express');
const dgram = require('dgram');
const { nanoid } = require('nanoid');
const db = require('../db');
const { CATALOG, DATA_CATALOG } = require('../commandCatalog');
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

// Loxone Virtual Input names aren't in a Miniserver's structure export (see the Miniservers
// section of the README for why), so there's nothing to autocomplete them against there. The
// next best thing: suggest names already typed into an existing mapping, which covers the common
// case of one Virtual Input receiving several different mapped commands.
function loadTargetSuggestions() {
  return db.prepare('SELECT DISTINCT target FROM mappings_mqtt_to_loxone ORDER BY target').all().map((r) => r.target);
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
  const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
  const targetSuggestions = loadTargetSuggestions();
  res.render('mappings-mqtt-to-loxone', { mappings, miniservers, targetSuggestions, error: null, prefillTopic: req.query.topic || '' });
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
  const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
  const targetSuggestions = loadTargetSuggestions();
  res.render('mapping-mqtt-to-loxone-edit', { mapping, miniservers, targetSuggestions, error: null });
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

// User edits to "Common commands"/"Common data" (see commandCatalog.js's own comment) replace the
// built-in catalog wholesale once saved — not merged field-by-field — so the Edit UI always seeds
// itself from whichever of these two is actually in effect, never straight from the hardcoded
// defaults once an override exists.
function loadCommandCatalogs() {
  const row = db.prepare('SELECT commands_json, data_json FROM command_catalog_overrides WHERE id = 1').get();
  let catalog = CATALOG;
  let dataCatalog = DATA_CATALOG;
  let isCustomized = false;
  if (row) {
    if (row.commands_json) {
      try { catalog = JSON.parse(row.commands_json); isCustomized = true; } catch (err) { /* corrupt — fall back to built-in */ }
    }
    if (row.data_json) {
      try { dataCatalog = JSON.parse(row.data_json); isCustomized = true; } catch (err) { /* corrupt — fall back to built-in */ }
    }
  }
  return { catalog, dataCatalog, isCustomized };
}

router.get('/commands', (req, res) => {
  const { devicesByFamily, deviceFamily, allDevices } = discoverDevices();
  const { catalog, dataCatalog, isCustomized } = loadCommandCatalogs();

  res.render('mappings-commands', {
    catalog,
    dataCatalog,
    isCustomized,
    devicesByFamily,
    deviceFamily,
    allDevices,
    presetFamily: req.query.family || (catalog[0] && catalog[0].key) || '',
    presetDevice: req.query.device || '',
    saved: req.query.saved === '1',
  });
});

// Saved as one complete replacement for each catalog (see loadCommandCatalogs's own comment) —
// built by the structured editor in mappings-commands.ejs, which always submits its FULL current
// state (both catalogs) on every save, so there's never a partial/merged write to reason about
// here. Barely-there validation (must parse, must be an array) since the editor itself is what
// builds this JSON — a real hand-crafted-JSON upload path would need much stricter checking.
router.post('/commands/catalog', requirePermission('commands', 'edit'), (req, res) => {
  const { commands_json: commandsJson, data_json: dataJson } = req.body;
  let commandsParsed;
  let dataParsed;
  try {
    commandsParsed = JSON.parse(commandsJson || '[]');
    dataParsed = JSON.parse(dataJson || '[]');
  } catch (err) {
    return res.status(400).send('Malformed catalog JSON — nothing was saved.');
  }
  if (!Array.isArray(commandsParsed) || !Array.isArray(dataParsed)) {
    return res.status(400).send('Catalog JSON must be an array — nothing was saved.');
  }
  db.prepare(
    `INSERT INTO command_catalog_overrides (id, commands_json, data_json, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET commands_json = excluded.commands_json, data_json = excluded.data_json, updated_at = excluded.updated_at`
  ).run(JSON.stringify(commandsParsed), JSON.stringify(dataParsed), new Date().toISOString());
  res.redirect('/mappings/commands?saved=1');
});

router.post('/commands/catalog/reset', requirePermission('commands', 'edit'), (req, res) => {
  db.prepare('DELETE FROM command_catalog_overrides WHERE id = 1').run();
  res.redirect('/mappings/commands');
});

// "Create RGB + White mappings" button (mappings-commands.ejs, shown only for a family with
// supportsShellyRgbw — see shelly-rgbw2.json/shelly-bulb.json) — a color-mode Shelly needs TWO
// Loxone -> MQTT mappings sharing one topic (see applyShellyRgbwTransform's shared rgbwChannelState
// in loxone.js) to work at all, and picking the right transform_arg by hand on each one is exactly
// the two-step, easy-to-get-wrong setup this session's real-hardware debugging kept tripping over.
// transport is fixed to 'udp' and miniserver_id left unset — this page has no miniserver/transport
// context to reuse (unlike the Loxone commands log's own "+ Mapping" button), both are easy to set
// afterward via Edit if wanted.
router.post('/commands/create-rgbw', requirePermission('loxone_to_mqtt', 'edit'), (req, res) => {
  const device = (req.body.device || '').trim();
  const family = (req.body.family || '').trim();
  const rgbMode = req.body.rgb_mode === 'rgb-percent' ? 'rgb-percent' : 'rgb';
  if (!device) return res.redirect(`/mappings/commands?family=${encodeURIComponent(family)}`);

  const { catalog } = loadCommandCatalogs();
  const familyEntry = catalog.find((f) => f.key === family);
  const colorCommand = familyEntry && familyEntry.commands.find((c) => c.key === 'color-set');
  if (!colorCommand) return res.redirect(`/mappings/commands?family=${encodeURIComponent(family)}&device=${encodeURIComponent(device)}`);

  const mqttTopic = colorCommand.topicTemplate.replace('{device}', device).replace('{channel}', '0');

  const insert = db.prepare(
    `INSERT INTO mappings_loxone_to_mqtt (miniserver_id, token, mqtt_topic, qos, retain, transport, value_transform, transform_arg)
     VALUES (NULL, ?, ?, 0, 0, 'udp', 'shelly_rgbw', ?)`
  );
  insert.run(nanoid(16), mqttTopic, rgbMode);
  insert.run(nanoid(16), mqttTopic, 'white');

  res.redirect('/mappings/loxone-to-mqtt');
});

router.get('/loxone-to-mqtt', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const mappings = loadLoxoneToMqttView(baseUrl);
  const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
  // transport/miniserver_id: only ever sent by the Loxone commands log's own "+ Mapping" button
  // (see logs-loxone-commands.ejs), which knows exactly what this specific rejected command
  // actually arrived as — pre-selects both instead of leaving them at their plain defaults.
  res.render('mappings-loxone-to-mqtt', {
    mappings,
    miniservers,
    error: null,
    prefillTopic: req.query.topic || '',
    prefillTransport: req.query.transport === 'udp' ? 'udp' : (req.query.transport === 'http' ? 'http' : ''),
    prefillMiniserverId: Number(req.query.miniserver_id) || null,
  });
});

// value_transform for this (Loxone -> MQTT) direction: 'passthrough' (default), 'translation_table'
// (managed separately, see its own routes), or 'shelly_rgbw' (see applyShellyRgbwTransform in
// loxone.js), whose transform_arg picks which of the three independent Loxone outputs this one
// mapping carries.
const LOXONE_TO_MQTT_TRANSFORMS = ['passthrough', 'translation_table', 'shelly_rgbw'];
const SHELLY_RGBW_MODES = ['white', 'rgb', 'rgb-percent', 'tunablew'];
function normalizeLoxoneToMqttTransform(body) {
  const transform = LOXONE_TO_MQTT_TRANSFORMS.includes(body.value_transform) ? body.value_transform : 'passthrough';
  const transformArg = transform === 'shelly_rgbw' && SHELLY_RGBW_MODES.includes(body.transform_arg) ? body.transform_arg : null;
  return { transform, transformArg };
}

router.post('/loxone-to-mqtt', requirePermission('loxone_to_mqtt', 'edit'), (req, res) => {
  const { miniserver_id, mqtt_topic, qos, retain, transport } = req.body;
  const { transform, transformArg } = normalizeLoxoneToMqttTransform(req.body);
  const token = nanoid(16);

  db.prepare(
    `INSERT INTO mappings_loxone_to_mqtt (miniserver_id, token, mqtt_topic, qos, retain, transport, value_transform, transform_arg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    miniserver_id ? Number(miniserver_id) : null,
    token,
    mqtt_topic,
    Number(qos) || 0,
    retain ? 1 : 0,
    transport === 'udp' ? 'udp' : 'http',
    transform,
    transformArg
  );

  res.redirect('/mappings/loxone-to-mqtt');
});

router.get('/loxone-to-mqtt/:id/edit', (req, res) => {
  const mapping = db.prepare('SELECT * FROM mappings_loxone_to_mqtt WHERE id = ?').get(req.params.id);
  if (!mapping) return res.status(404).send('Mapping not found');
  const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
  res.render('mapping-loxone-to-mqtt-edit', { mapping, miniservers, error: null });
});

router.post('/loxone-to-mqtt/:id/update', requirePermission('loxone_to_mqtt', 'edit'), (req, res) => {
  const { miniserver_id, mqtt_topic, qos, retain, transport } = req.body;
  const { transform, transformArg } = normalizeLoxoneToMqttTransform(req.body);
  const token = (req.body.token || '').trim();

  if (!token) {
    const mapping = db.prepare('SELECT * FROM mappings_loxone_to_mqtt WHERE id = ?').get(req.params.id);
    const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
    return res.render('mapping-loxone-to-mqtt-edit', { mapping, miniservers, error: 'Token is required.' });
  }

  try {
    db.prepare(
      `UPDATE mappings_loxone_to_mqtt
       SET token = ?, miniserver_id = ?, mqtt_topic = ?, qos = ?, retain = ?, transport = ?, value_transform = ?, transform_arg = ?
       WHERE id = ?`
    ).run(
      token,
      miniserver_id ? Number(miniserver_id) : null,
      mqtt_topic,
      Number(qos) || 0,
      retain ? 1 : 0,
      transport === 'udp' ? 'udp' : 'http',
      transform,
      transformArg,
      req.params.id
    );
  } catch (err) {
    // token has a UNIQUE constraint — the only realistic way this UPDATE fails.
    const mapping = db.prepare('SELECT * FROM mappings_loxone_to_mqtt WHERE id = ?').get(req.params.id);
    const miniservers = db.prepare('SELECT * FROM miniservers ORDER BY sort_order, id').all();
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

  const port = process.env.PORT || 5582;
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

// The "+ Reject" quick-action on an accepted row in Logs > Loxone commands (logs-loxone-commands.
// ejs) — that page only ever knows the mqtt_topic an accepted command matched (see loxoneCommandLog
// .js's logAccepted, which logs mapping.mqtt_topic, not the mapping's id), so this looks the
// mapping up by that rather than taking an :id the way the row-level toggle above does. An
// explicit "set disabled" (not a blind toggle) is deliberate: unlike the Mappings page's own
// toggle switch, this button's page never shows the mapping's current enabled state, so flipping
// whichever state it happens to already be in could silently RE-enable a mapping someone already
// turned off for an unrelated reason. No-ops (still redirects) if the topic no longer matches any
// mapping — nothing to disable, not an error.
router.post('/loxone-to-mqtt/disable-by-topic', requirePermission('loxone_to_mqtt', 'edit'), (req, res) => {
  const topic = (req.body.mqtt_topic || '').trim();
  if (topic) db.prepare('UPDATE mappings_loxone_to_mqtt SET enabled = 0 WHERE mqtt_topic = ?').run(topic);
  res.redirect(req.get('referer') || '/logs/loxone-commands');
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
