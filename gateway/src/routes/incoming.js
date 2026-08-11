const express = require('express');
const db = require('../db');
const { getTopicOverview, clearTopicOverview } = require('../mqttClient');
const { getClients, clearClients } = require('../mosquittoLog');
const { commandRecognitionString } = require('../loxone');
const { discoverDevices, resolveTopicPrefix } = require('../deviceDiscovery');
const { loadCommandCatalogs } = require('../commandCatalog');
const { getDisplayTimezone } = require('../dateFormat');
const scheduledDeviceCommands = require('../scheduledDeviceCommands');
const { requirePermission } = require('../middleware/requirePermission');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

router.get('/', (req, res) => res.redirect('/incoming/messages'));

router.get('/messages', asyncHandler(async (req, res) => {
  const topics = getTopicOverview().map((t) => ({ ...t, recognition: commandRecognitionString(t.topic) }));
  // Every MQTT topic already tracked by a monitor — same "grey out instead of letting someone
  // create a second, identical monitor" treatment as Live Data's own Loxone states (see
  // routes/liveData.js), just keyed by topic instead of uuid.
  const monitoredTopics = (await db.prepare("SELECT mqtt_topic FROM monitors WHERE source_type = 'mqtt'").all()).map((r) => r.mqtt_topic);
  // Same "show what's already true about this row" idea, for the other two per-row actions this
  // page also offers: Map (does an MQTT -> Loxone mapping already exist for this exact topic?) and
  // Widget (does its monitor already have at least one dashboard panel pinned to it?).
  const mappedTopics = (await db.prepare('SELECT DISTINCT mqtt_topic FROM mappings_mqtt_to_loxone').all()).map((r) => r.mqtt_topic);
  const widgetedTopics = (await db.prepare(
    `SELECT DISTINCT m.mqtt_topic FROM monitors m
     JOIN dashboard_panel_monitors dpm ON dpm.monitor_id = m.id
     WHERE m.source_type = 'mqtt'`
  ).all()).map((r) => r.mqtt_topic);
  res.render('incoming-messages', { topics, monitoredTopics, mappedTopics, widgetedTopics });
}));

router.post('/messages/clear', requirePermission('incoming', 'edit'), (req, res) => {
  clearTopicOverview();
  res.redirect('/incoming/messages');
});

// LoxSuite's own MQTT connections (the gateway's persistent connection, the one-shot
// dynamic-security bootstrap, and ad-hoc Test buttons — see mqttClient.js/dynsecBootstrap.js/
// dynamicSecurity.js/routes/setup.js) all connect under a stable "loxsuite-..." clientId rather
// than a random one, specifically so they can be told apart from real devices here.
function isSystemClient(clientId) {
  return clientId.startsWith('loxsuite-');
}

router.get('/clients', asyncHandler(async (req, res) => {
  const { allDevices, deviceFamily, announcedByMacSuffix } = discoverDevices();
  const allClients = getClients().map((c) => {
    const prefix = resolveTopicPrefix(c.clientId, allDevices, announcedByMacSuffix);
    return { ...c, displayName: prefix || c.clientId, resolvedFromTopic: !!prefix };
  });
  const deviceClients = allClients.filter((c) => !isSystemClient(c.clientId));
  const systemClients = allClients.filter((c) => isSystemClient(c.clientId));
  const tab = req.query.tab === 'system' ? 'system' : 'device';
  const settings = await db.prepare('SELECT client_retention_hours FROM gateway_settings WHERE id = 1').get();
  // How many "Schedule command" rows (see /schedules below) already exist per device — shown as a
  // small count next to that button so a schedule already set up isn't invisible from this page.
  const scheduleCounts = {};
  (await scheduledDeviceCommands.listSchedules()).forEach((s) => {
    scheduleCounts[s.device_key] = (scheduleCounts[s.device_key] || 0) + 1;
  });
  res.render('incoming-clients', {
    clients: tab === 'system' ? systemClients : deviceClients,
    deviceCount: deviceClients.length,
    systemCount: systemClients.length,
    tab,
    retentionHours: settings.client_retention_hours,
    // Which Common Commands family (if any) each resolved device id actually belongs to — see
    // incoming-clients.ejs's own "Suggest commands" link, which used to only ever guess "Shelly"
    // from the name itself. That breaks down for any device whose id isn't self-describing (a
    // HeatMeister module is just whatever name you gave it in its own config, e.g.
    // "radiator-gang" — nothing in that string says "heatmeister"), unlike deviceFamily here,
    // which already knows the real answer from which topicPrefixPattern actually matched.
    deviceFamily,
    scheduleCounts,
  });
}));

router.post('/clients/clear', requirePermission('incoming', 'edit'), (req, res) => {
  clearClients();
  res.redirect('/incoming/clients');
});

router.post('/clients/settings', requirePermission('incoming', 'edit'), asyncHandler(async (req, res) => {
  const hours = Number(req.body.client_retention_hours);
  if (Number.isFinite(hours) && hours > 0) {
    await db.prepare('UPDATE gateway_settings SET client_retention_hours = ? WHERE id = 1').run(Math.round(hours));
  }
  // Referer-based (not a fixed '/incoming/clients') since this form now lives on the Settings
  // page — same pattern already used by /logs/settings.
  res.redirect(req.get('referer') || '/incoming/clients');
}));

router.get('/schedules', asyncHandler(async (req, res) => {
  const { allDevices, deviceFamily } = discoverDevices();
  const { catalog } = await loadCommandCatalogs();
  const tz = getDisplayTimezone();
  const now = new Date();

  const schedules = (await scheduledDeviceCommands.listSchedules()).map((s) => ({
    ...s,
    nextRun: s.enabled ? scheduledDeviceCommands.computeNextRun(s, tz, now) : null,
  }));

  res.render('incoming-schedules', {
    schedules,
    allDevices,
    deviceFamily,
    catalog,
    presetDevice: req.query.device || '',
    presetFamilyKey: req.query.family || deviceFamily[req.query.device || ''] || '',
    // Client Activity's own Device column falls back to the raw MQTT client ID whenever it
    // couldn't match one to a real topic prefix seen in that device's own traffic (see
    // resolveTopicPrefix in deviceDiscovery.js) — there's no protocol-level way to ask the broker
    // "who published this topic", so that fallback is a best-effort GUESS, not a confirmed match.
    // A device renamed in its own web UI (changing its topic prefix) without its MQTT client ID
    // also changing looks exactly like this: the two strings then share nothing for that guess to
    // work from at all. Carried through as its own query param (not re-derived here) since by the
    // time this page loads, deviceFamily/allDevices only know about CONFIRMED topic prefixes —
    // they have no way to tell "this exact device string came from a client ID fallback" on their own.
    deviceUnconfirmed: !!req.query.device && req.query.resolved === '0',
    timezone: tz,
    error: req.query.error || null,
  });
}));

// Shared by the create route and the Add form's own "Test" button below — device-level commands
// only for now (a topicTemplate with no {channel} of its own, e.g. a Shelly's "Reboot"): a
// per-channel one (relay/roller/...) would need a channel picker this UI doesn't have yet, and the
// same filter is applied client-side when building the dropdown, this is just the server-side half
// of that same rule.
function resolveCommand(catalog, familyKey, commandValue, deviceKey) {
  const family = catalog.find((f) => f.key === familyKey);
  if (!family) throw new Error('Unknown device family.');
  const [commandKey, actionIndexRaw] = String(commandValue || '').split('::');
  const command = (family.commands || []).find((c) => c.key === commandKey && !c.topicTemplate.includes('{channel}'));
  const actionIndex = Number(actionIndexRaw);
  if (!command || !command.actions[actionIndex]) throw new Error('Unknown command.');
  return {
    label: command.actions.length > 1 ? `${command.label}: ${command.actions[actionIndex]}` : command.label,
    topic: command.topicTemplate.replace('{device}', deviceKey),
    payload: command.actions[actionIndex],
  };
}

router.post('/schedules', requirePermission('incoming', 'edit'), asyncHandler(async (req, res) => {
  const { device_key: deviceKey, family_key: familyKey, command_value: commandValue, interval_type: intervalType, interval_days: intervalDays, time_of_day: timeOfDay } = req.body;
  try {
    const { catalog } = await loadCommandCatalogs();
    const resolved = resolveCommand(catalog, familyKey, commandValue, deviceKey);
    // Same array-vs-single-string quirk every other checkbox group in this app works around
    // (Express only gives an array once MORE than one same-named box is checked).
    const weekdaysRaw = req.body.weekdays;
    const weekdaysCsv = Array.isArray(weekdaysRaw) ? weekdaysRaw.join(',') : (weekdaysRaw || '');

    await scheduledDeviceCommands.createSchedule({
      device_key: deviceKey,
      family_key: familyKey,
      command_label: resolved.label,
      mqtt_topic: resolved.topic,
      mqtt_payload: resolved.payload,
      interval_type: intervalType,
      interval_days: intervalDays,
      weekdays: weekdaysCsv,
      time_of_day: timeOfDay,
    });
    res.redirect('/incoming/schedules');
  } catch (err) {
    res.redirect(`/incoming/schedules?error=${encodeURIComponent(err.message)}&device=${encodeURIComponent(deviceKey || '')}&family=${encodeURIComponent(familyKey || '')}`);
  }
}));

// Backs the Add-schedule form's own "Test" button — fires the currently-picked device/command
// once, before a schedule even exists to save, so a typo'd device id or a command that doesn't
// actually do anything on this specific device gets caught right there instead of after committing
// to a recurring schedule for it. JSON in/out (fetch()'d from the form, see incoming-schedules.ejs)
// rather than a redirect, so the rest of the not-yet-saved form (interval type, weekdays, ...)
// doesn't get thrown away just to show the result of a test send.
router.post('/schedules/test-send', requirePermission('incoming', 'edit'), asyncHandler(async (req, res) => {
  const { device_key: deviceKey, family_key: familyKey, command_value: commandValue } = req.body;
  try {
    const { catalog } = await loadCommandCatalogs();
    const resolved = resolveCommand(catalog, familyKey, commandValue, deviceKey);
    await scheduledDeviceCommands.testSend(resolved.topic, resolved.payload);
    res.json({ ok: true, topic: resolved.topic, payload: resolved.payload });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}));

router.post('/schedules/:id/update', requirePermission('incoming', 'edit'), asyncHandler(async (req, res) => {
  const { interval_type: intervalType, interval_days: intervalDays, time_of_day: timeOfDay } = req.body;
  const weekdaysRaw = req.body.weekdays;
  const weekdaysCsv = Array.isArray(weekdaysRaw) ? weekdaysRaw.join(',') : (weekdaysRaw || '');
  try {
    await scheduledDeviceCommands.updateSchedule(req.params.id, {
      interval_type: intervalType, interval_days: intervalDays, weekdays: weekdaysCsv, time_of_day: timeOfDay,
    });
    res.redirect('/incoming/schedules');
  } catch (err) {
    res.redirect(`/incoming/schedules?error=${encodeURIComponent(err.message)}`);
  }
}));

router.post('/schedules/:id/toggle', requirePermission('incoming', 'edit'), asyncHandler(async (req, res) => {
  const schedule = await scheduledDeviceCommands.getSchedule(req.params.id);
  if (schedule) await scheduledDeviceCommands.setEnabled(schedule.id, !schedule.enabled);
  res.redirect('/incoming/schedules');
}));

router.post('/schedules/:id/run-now', requirePermission('incoming', 'edit'), asyncHandler(async (req, res) => {
  await scheduledDeviceCommands.runNow(req.params.id); // failure is recorded on the row itself (last_status/last_error), not thrown here
  res.redirect('/incoming/schedules');
}));

router.post('/schedules/:id/delete', requirePermission('incoming', 'edit'), asyncHandler(async (req, res) => {
  await scheduledDeviceCommands.deleteSchedule(req.params.id);
  res.redirect('/incoming/schedules');
}));

module.exports = router;
