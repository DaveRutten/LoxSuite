const { CATALOG } = require('./commandCatalog');
const { getTopicOverview } = require('./mqttClient');
const { BRAND_PREFIX_RE } = require('./topicName');

// Scans every topic the broker has actually seen for each catalog family's
// topicPrefixPattern, so the resulting device IDs are the real values used in
// that device's own traffic — not necessarily the same as its raw MQTT client
// ID (a device's configured topic prefix can be customized separately from
// its client ID/hostname).
function discoverDevices() {
  const topics = getTopicOverview().map((t) => t.topic);
  const devicesByFamily = {};
  const deviceFamily = {};

  CATALOG.forEach((family) => {
    const re = new RegExp(family.topicPrefixPattern);
    const ids = new Set();
    topics.forEach((topic) => {
      const m = topic.match(re);
      if (m) {
        ids.add(m[1]);
        if (!deviceFamily[m[1]]) deviceFamily[m[1]] = family.key;
      }
    });
    devicesByFamily[family.key] = [...ids].sort();
  });

  return { devicesByFamily, deviceFamily, allDevices: Object.keys(deviceFamily).sort() };
}

// Best-effort match between a raw MQTT client ID and a known topic prefix:
// exact match first (the common case — a device's client ID and topic prefix
// are usually the same string), then a brand-prefix-insensitive match. There
// is no protocol-level way to reliably link the two when they genuinely
// differ — the broker never tells subscribers which client published a
// message — so anything beyond this heuristic would be a guess.
function resolveTopicPrefix(clientId, knownPrefixes) {
  if (knownPrefixes.includes(clientId)) return clientId;
  const stripped = clientId.replace(BRAND_PREFIX_RE, '').toLowerCase();
  const match = knownPrefixes.find((p) => p.replace(BRAND_PREFIX_RE, '').toLowerCase() === stripped);
  return match || null;
}

module.exports = { discoverDevices, resolveTopicPrefix };
