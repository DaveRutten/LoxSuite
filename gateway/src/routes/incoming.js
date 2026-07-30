const express = require('express');
const db = require('../db');
const { getTopicOverview, clearTopicOverview } = require('../mqttClient');
const { getClients, clearClients } = require('../mosquittoLog');
const { commandRecognitionString } = require('../loxone');
const { discoverDevices, resolveTopicPrefix } = require('../deviceDiscovery');
const { requirePermission } = require('../middleware/requirePermission');

const router = express.Router();

router.get('/', (req, res) => res.redirect('/incoming/messages'));

router.get('/messages', (req, res) => {
  const topics = getTopicOverview().map((t) => ({ ...t, recognition: commandRecognitionString(t.topic) }));
  res.render('incoming-messages', { topics });
});

router.post('/messages/clear', requirePermission('incoming', 'edit'), (req, res) => {
  clearTopicOverview();
  res.redirect('/incoming/messages');
});

router.get('/clients', (req, res) => {
  const { allDevices } = discoverDevices();
  const clients = getClients().map((c) => {
    const prefix = resolveTopicPrefix(c.clientId, allDevices);
    return { ...c, displayName: prefix || c.clientId, resolvedFromTopic: !!prefix };
  });
  const settings = db.prepare('SELECT client_retention_hours FROM gateway_settings WHERE id = 1').get();
  res.render('incoming-clients', { clients, retentionHours: settings.client_retention_hours });
});

router.post('/clients/clear', requirePermission('incoming', 'edit'), (req, res) => {
  clearClients();
  res.redirect('/incoming/clients');
});

router.post('/clients/settings', requirePermission('incoming', 'edit'), (req, res) => {
  const hours = Number(req.body.client_retention_hours);
  if (Number.isFinite(hours) && hours > 0) {
    db.prepare('UPDATE gateway_settings SET client_retention_hours = ? WHERE id = 1').run(Math.round(hours));
  }
  // Referer-based (not a fixed '/incoming/clients') since this form now lives on the Settings
  // page — same pattern already used by /logs/settings.
  res.redirect(req.get('referer') || '/incoming/clients');
});

module.exports = router;
