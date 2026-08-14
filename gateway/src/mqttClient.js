const mqtt = require('mqtt');
const db = require('./db');
const { forwardToLoxone } = require('./loxone');
// Namespace require (not destructured) — see loxoneUdpServer.js's own comment on the same pattern:
// lets test/mqttClient.test.js stub monitorCollector.recordMqttValue without a real DB write.
const monitorCollector = require('./monitorCollector');
const { decrypt } = require('./secretCrypto');

const MAX_LOG = 200;
const RATE_WINDOW_MS = 10000;
const messageLog = [];
const topicOverview = new Map(); // topic -> { value, previousValue, lastSeen, count }
const lastForwardedAt = new Map(); // mapping id -> timestamp (ms), for min_interval_ms throttling
const recentTimestamps = []; // ms epoch of recent messages, pruned to RATE_WINDOW_MS, for msgs/sec
const state = { connected: false, host: null, port: null };
let totalMessageCount = 0;

// Every enabled mappings_mqtt_to_loxone row — refreshed via reloadMappings() below, read by the
// message handler as a plain in-memory array instead of a fresh query per message. Mirrors
// monitorCollector.js's own mqttTopicMonitors cache for the identical reason: the broker
// subscription below is '#' (every topic on the broker), so without this the exact same "all
// enabled mappings" query ran once per incoming MQTT message of ANY topic, before even checking
// whether it matched one — a real, measured slow-query source on Postgres (a full table scan over
// the network on every message, not just a mapped one), confirmed against a real install logging
// 600ms-1.5s per hit during a burst of a few messages arriving close together.
let enabledMappings = [];

let client = null;

function topicMatches(pattern, topic) {
  const patternParts = pattern.split('/');
  const topicParts = topic.split('/');

  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (part === '#') return true;
    if (i >= topicParts.length) return false;
    if (part === '+') continue;
    if (part !== topicParts[i]) return false;
  }
  return patternParts.length === topicParts.length;
}

function recordMessage(topic, payload) {
  const value = payload.toString().slice(0, 500);
  const now = new Date().toISOString();

  messageLog.unshift({ topic, payload: value, receivedAt: now });
  if (messageLog.length > MAX_LOG) messageLog.length = MAX_LOG;

  // Fire-and-forget by design (recordMessage itself stays a plain sync function, called from the
  // hot per-message path) — but recordMqttValue is async (a monitor_history DB write), and an
  // unhandled rejection here would otherwise vanish as a generic Node warning instead of a clear
  // log line if that write ever fails.
  monitorCollector.recordMqttValue(topic, value).catch((err) => console.error(`Failed to record monitor value for "${topic}":`, err.message));

  const existing = topicOverview.get(topic);
  topicOverview.set(topic, {
    value,
    previousValue: existing ? existing.value : null,
    lastSeen: now,
    count: existing ? existing.count + 1 : 1,
  });

  totalMessageCount++;
  const nowMs = Date.now();
  recentTimestamps.push(nowMs);
  const cutoff = nowMs - RATE_WINDOW_MS;
  while (recentTimestamps.length && recentTimestamps[0] < cutoff) recentTimestamps.shift();
}

async function loadSettings() {
  const settings = await db.prepare('SELECT * FROM mqtt_settings WHERE id = 1').get();
  return settings ? { ...settings, password: decrypt(settings.password) } : settings;
}

// Called once at startup (startMqttClient below) and after every create/update/toggle/delete of an
// MQTT-to-Loxone mapping (see routes/mappings.js) — same "reload the cache right after the mutation
// that could have changed it" convention monitorCollector.js's own reloadMqttMonitors() already
// uses for its topic->monitor cache.
async function reloadMappings() {
  enabledMappings = await db.prepare('SELECT * FROM mappings_mqtt_to_loxone WHERE enabled = 1').all();
}

function shouldThrottle(mapping) {
  if (!mapping.min_interval_ms) return false;
  const last = lastForwardedAt.get(mapping.id);
  return last !== undefined && Date.now() - last < mapping.min_interval_ms;
}

// Shelly Gen1's own MQTT protocol feature — publishing "announceall" to shellies/command makes
// every currently-connected Gen1 device immediately republish its own <prefix>/announce (see
// deviceDiscovery.js's use of that payload to resolve a renamed device's real topic prefix from its
// raw MQTT client ID). Triggered once on every successful (re)connect below, since a device that
// reconnects faster than this gateway's own subscribe completes would otherwise have its one-shot,
// non-retained announce lost for good until its NEXT reconnect — exactly why a device only ever
// showed up correctly again after being power-cycled by hand. Also exported for a manual "Rescan
// devices" action (routes/incoming.js) for whenever a fresher answer is wanted without restarting
// anything.
function requestDeviceAnnounce() {
  if (client && state.connected) client.publish('shellies/command', 'announceall');
}

function attachHandlers(c) {
  c.on('connect', () => {
    state.connected = true;
    // '#' does not match topics starting with '$' (e.g. $CONTROL, $SYS) per the MQTT spec,
    // so the dynamic-security response topic needs an explicit subscription.
    c.subscribe(['#', '$CONTROL/dynamic-security/v1/response'], (err) => {
      if (err) console.error('MQTT subscribe error:', err.message);
      else {
        console.log('Connected to MQTT broker, subscribed to all topics.');
        requestDeviceAnnounce();
      }
    });
  });

  c.on('reconnect', () => console.log('Reconnecting to MQTT broker...'));
  c.on('close', () => { state.connected = false; });
  c.on('error', (err) => console.error('MQTT client error:', err.message));

  c.on('message', async (topic, payload) => {
    if (topic.startsWith('$')) return; // internal broker/control traffic, not an application message

    recordMessage(topic, payload);

    const matching = enabledMappings.filter((m) => topicMatches(m.mqtt_topic, topic));

    for (const mapping of matching) {
      if (shouldThrottle(mapping)) continue;
      // Set the throttle timestamp before awaiting the network call (not after
      // success) so a second message arriving mid-flight is correctly throttled
      // instead of racing past this check while the first call is still pending.
      lastForwardedAt.set(mapping.id, Date.now());

      try {
        await forwardToLoxone(mapping, payload, topic);
      } catch (err) {
        console.error(`Failed to forward "${topic}" to miniserver ${mapping.miniserver_id}:`, err.message);
        await db.prepare('UPDATE miniservers SET last_error = ? WHERE id = ?').run(err.message, mapping.miniserver_id);
      }
    }
  });
}

function connectWithSettings(settings) {
  if (client) {
    client.removeAllListeners();
    client.end(true);
  }

  state.connected = false;
  state.host = settings.host;
  state.port = settings.port;

  const protocol = settings.use_tls ? 'mqtts' : 'mqtt';
  client = mqtt.connect(`${protocol}://${settings.host}:${settings.port}`, {
    // A fixed clientId, not mqtt.js's own random "mqttjs_xxxxxxxx" default — every reconnect
    // (a network blip, a broker restart, the auth-failure loop a wrong password causes) would
    // otherwise show up as a brand new, differently-named client each time, in both Mosquitto's
    // own log and this app's own Client Activity page, instead of being recognizable as the one
    // gateway process reconnecting. A real MQTT broker disconnects whatever was already connected
    // under the same clientId when a new connection claims it — exactly what should happen here,
    // since only one gateway process is ever meant to hold this identity at a time.
    clientId: 'loxsuite-gateway',
    username: settings.username || undefined,
    password: settings.password || undefined,
    reconnectPeriod: 5000,
  });
  attachHandlers(client);
}

async function reconnect() {
  connectWithSettings(await loadSettings());
}

function getClient() {
  return client;
}

function getTopicOverview() {
  return Array.from(topicOverview.entries())
    .map(([topic, info]) => ({ topic, ...info }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

function clearTopicOverview() {
  topicOverview.clear();
}

function getStats() {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  const recentCount = recentTimestamps.filter((t) => t >= cutoff).length;
  return {
    messagesPerSecond: Math.round((recentCount / (RATE_WINDOW_MS / 1000)) * 10) / 10,
    totalMessages: totalMessageCount,
    topicsSeen: topicOverview.size,
  };
}

// Used to be a bare module-load-time call (connectWithSettings(loadSettings());) — safe when
// loadSettings() was a synchronous better-sqlite3 read, but the async facade means it can't be
// awaited at plain require() time. server.js's main() calls this explicitly after db.init() instead.
async function startMqttClient() {
  await reloadMappings();
  connectWithSettings(await loadSettings());
}

module.exports = {
  getClient,
  state,
  startMqttClient,
  reconnect,
  reloadMappings,
  getMessageLog: () => messageLog,
  getTopicOverview,
  clearTopicOverview,
  getStats,
  recordMessage,
  requestDeviceAnnounce,
};
