const { CATALOG } = require('./commandCatalog');
const { getTopicOverview } = require('./mqttClient');
const { getClients } = require('./mosquittoLog');
const { BRAND_PREFIX_RE, ROOT_NAMESPACES } = require('./topicName');

// A root namespace's device segment is whatever comes right after it, e.g.
// "shellies/<this>/relay/0" or "zigbee2mqtt/<this>/set" — used below to
// register a device ID even when no catalog family's stricter pattern
// matches it (see discoverDevices()).
const ROOT_NAMESPACE_RE = new RegExp(`^(?:${[...ROOT_NAMESPACES].join('|')})/([^/]+)/`);

// Shelly devices broadcast their own identity — {id, mac, ...} — on "<prefix>/announce" and the
// shared "shellies/announce" topic whenever they (re)connect. "id" is the device's current, real
// topic prefix (whatever it's been renamed to), and "mac" is its fixed hardware address, whose
// last 6 hex digits are also embedded in its factory-default MQTT client ID (e.g. client ID
// "shellyplug-s-02086E" for mac "807D3A02086E"). That overlap is a real fact reported by the
// device itself — not a string-matching guess — so it survives a rename that changes the topic
// prefix but leaves the client ID at its factory default.
function announcedPrefixesByMacSuffix(topicEntries) {
  const byMacSuffix = {};
  topicEntries.forEach((t) => {
    if (!/\/announce$/.test(t.topic) || !t.value) return;
    let payload;
    try {
      payload = JSON.parse(t.value);
    } catch (e) {
      return;
    }
    const macSuffix = String(payload.mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase().slice(-6);
    if (payload.id && macSuffix.length === 6) byMacSuffix[macSuffix] = payload.id;
  });
  return byMacSuffix;
}

// Scans every topic the broker has actually seen for each catalog family's
// topicPrefixPattern, so the resulting device IDs are the real values used in
// that device's own traffic — not necessarily the same as its raw MQTT client
// ID (a device's configured topic prefix can be customized separately from
// its client ID/hostname).
function discoverDevices() {
  const topicEntries = getTopicOverview();
  const topics = topicEntries.map((t) => t.topic);
  const devicesByFamily = {};
  const deviceFamily = {};
  const allIds = new Set();

  CATALOG.forEach((family) => {
    const re = new RegExp(family.topicPrefixPattern);
    const ids = new Set();
    topics.forEach((topic) => {
      const m = topic.match(re);
      if (m) {
        ids.add(m[1]);
        allIds.add(m[1]);
        if (!deviceFamily[m[1]]) deviceFamily[m[1]] = family.key;
      }
    });
    devicesByFamily[family.key] = [...ids].sort();
  });

  // A family's topicPrefixPattern hardcodes that model's factory brand token
  // (e.g. "shellyplug-s-"), so it stops matching the moment a device is
  // renamed away from its factory-default topic prefix on the device itself
  // — a normal, supported thing to do, not a misconfiguration. Also register
  // every device segment seen under a known root namespace regardless of
  // which (if any) family pattern matched, so resolveTopicPrefix() can still
  // recognize a renamed device's real topic prefix — we just won't know which
  // specific family it belongs to.
  topics.forEach((topic) => {
    const m = topic.match(ROOT_NAMESPACE_RE);
    if (m) allIds.add(m[1]);
  });

  return {
    devicesByFamily,
    deviceFamily,
    allDevices: [...allIds].sort(),
    announcedByMacSuffix: announcedPrefixesByMacSuffix(topicEntries),
  };
}

// Best-effort match between a raw MQTT client ID and a known topic prefix:
// exact match first (the common case — a device's client ID and topic prefix
// are usually the same string), then the device's own announced MAC (see
// announcedPrefixesByMacSuffix above — a confirmed fact, not a guess), then a
// brand-prefix-insensitive match (Shelly: clientId "shellyplug-s-A1B2C3" vs.
// topic prefix "A1B2C3"). Beyond that there is no protocol-level way to
// reliably link the two when they genuinely differ — the broker never tells
// subscribers which client published a message — so anything past this point
// would be a guess.
function resolveTopicPrefix(clientId, knownPrefixes, announcedByMacSuffix) {
  if (knownPrefixes.includes(clientId)) return clientId;
  if (announcedByMacSuffix) {
    const m = clientId.match(/(?:^|[-_])([0-9a-f]{6})$/i);
    const announced = m && announcedByMacSuffix[m[1].toLowerCase()];
    if (announced) return announced;
  }
  const stripped = clientId.replace(BRAND_PREFIX_RE, '').toLowerCase();
  const match = knownPrefixes.find((p) => p.replace(BRAND_PREFIX_RE, '').toLowerCase() === stripped);
  if (match) return match;
  // Some other families' client IDs are "<product>_<name>" while their topic prefix is just
  // "<name>" (e.g. a HeatMeister module: client ID "heatbooster_radiator-gang", topic prefix
  // "radiator-gang") — a suffix match, bounded by a separator so "gang" alone can't spuriously
  // match inside "radiator-gang", covers that without being specific to any one brand.
  const lowerClientId = clientId.toLowerCase();
  const suffixMatch = knownPrefixes.find((p) => {
    const lowerPrefix = p.toLowerCase();
    if (!lowerClientId.endsWith(lowerPrefix) || lowerClientId.length === lowerPrefix.length) return false;
    const boundaryChar = lowerClientId.charAt(lowerClientId.length - lowerPrefix.length - 1);
    return boundaryChar === '_' || boundaryChar === '-' || boundaryChar === '/';
  });
  return suffixMatch || null;
}

// Whether `topic` is one of `prefix`'s own — as a full path segment, not a substring match (so a
// prefix "light" can't spuriously match some unrelated ".../lighting/..." topic): either leading
// ("prefix/rest", the common case — a renamed device's own custom prefix replaces its entire topic
// root, no namespace wrapper left at all) or nested one level in ("shellies/prefix/rest" — a
// still-factory-default device's own topicPrefixPattern always expects that "shellies/" namespace
// in front of it, which CATALOG-pattern matching needs but a resolved prefix string alone doesn't
// carry). Deliberately NOT reusing discoverDevices()'s own CATALOG-pattern matching for this: that
// approach can't recognize a renamed device's topics at all (none of those patterns match anything
// without a "shellies/" namespace in front), which is exactly the case activeTopics() below most
// needs to get right.
function topicBelongsToPrefix(topic, prefix) {
  return topic === prefix || topic.startsWith(`${prefix}/`) || topic.includes(`/${prefix}/`);
}

// Topic suggestions for the mapping "Add" forms' own mqtt_topic autocomplete — restricted to
// topics belonging to a device that's CURRENTLY connected (mosquittoLog.js's own getClients()),
// not every topic this gateway has ever seen: a disconnected device's last-known topics are
// exactly the ones someone would map and then never see a value come in for. Suggested strings are
// the real topics as actually published, which already use whatever topic prefix (custom-renamed
// or still factory-default) the device itself chose — resolveTopicPrefix() is what keeps a renamed
// device's raw MQTT client ID (all that mosquittoLog.js's connection log ever sees) from leaking
// into this as literal topic text.
function activeTopics() {
  const { allDevices, announcedByMacSuffix } = discoverDevices();
  const activePrefixes = [
    ...new Set(
      getClients()
        .filter((c) => c.status === 'connected')
        .map((c) => resolveTopicPrefix(c.clientId, allDevices, announcedByMacSuffix))
        .filter(Boolean)
    ),
  ];
  if (activePrefixes.length === 0) return [];

  const topics = getTopicOverview().map((t) => t.topic);
  const active = topics.filter((topic) => activePrefixes.some((prefix) => topicBelongsToPrefix(topic, prefix)));
  return [...new Set(active)].sort();
}

module.exports = { discoverDevices, resolveTopicPrefix, activeTopics };
