const express = require('express');
const db = require('../db');
const mqttClient = require('../mqttClient');
const { requirePermission } = require('../middleware/requirePermission');

const router = express.Router();

function loadSettings() {
  return db.prepare('SELECT * FROM mqtt_settings WHERE id = 1').get();
}

function loadGatewaySettings() {
  return db.prepare('SELECT * FROM gateway_settings WHERE id = 1').get();
}

router.get('/', (req, res) => {
  res.render('settings', { settings: loadSettings(), gatewaySettings: loadGatewaySettings(), error: null, saved: false });
});

router.post('/', requirePermission('settings', 'edit'), (req, res) => {
  const { host, port, username, password, use_tls } = req.body;

  if (!host || !port) {
    return res.render('settings', {
      settings: loadSettings(),
      gatewaySettings: loadGatewaySettings(),
      error: 'Host and port are required.',
      saved: false,
    });
  }

  db.prepare(
    'UPDATE mqtt_settings SET host = ?, port = ?, username = ?, password = ?, use_tls = ? WHERE id = 1'
  ).run(host, Number(port), username || null, password || null, use_tls ? 1 : 0);

  mqttClient.reconnect();

  res.render('settings', { settings: loadSettings(), gatewaySettings: loadGatewaySettings(), error: null, saved: true });
});

router.post('/auto-create', requirePermission('settings', 'edit'), (req, res) => {
  db.prepare('UPDATE gateway_settings SET auto_create_loxone_mappings = ? WHERE id = 1').run(req.body.enabled ? 1 : 0);
  res.render('settings', { settings: loadSettings(), gatewaySettings: loadGatewaySettings(), error: null, saved: true });
});

module.exports = router;
