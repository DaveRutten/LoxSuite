const express = require('express');
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
  res.render('incoming-clients', { clients });
});

router.post('/clients/clear', requirePermission('incoming', 'edit'), (req, res) => {
  clearClients();
  res.redirect('/incoming/clients');
});

module.exports = router;
