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
const topicOverview = new Map(); // topic -> { value, previousValue, lastSeen, count, retained }
const lastForwardedAt = new Map(); // mapping id -> timestamp (ms), for min_interval_ms throttling
const recentTimestamps = []; // ms epoch of recent messages, pruned to RATE_WINDOW_MS, for msgs/sec
const state = { connected: false, host: null, port: null };
let totalMessageCount = 0;

// $SYS/broker/<suffix> -> raw string payload, e.g. suffix "clients/connected" -> "3". Mosquitto
// publishes its own broker-wide health/throughput stats under here every `sys_interval` seconds
// (10s by default, on by default, nothing to opt into) — the real thing, straight from the broker
// process itself, as opposed to messagesPerSecond/totalMessages/topicsSeen below, which are only
// ever this gateway's OWN count of what it happened to see (identical in practice today, since the
// gateway is the only '#' subscriber, but would diverge the moment anything else — mosquitto_sub, a
// second integration — also talks to this broker). Kept as raw suffix->string rather than parsed
// into getBrokerStats' shape immediately: a real broker was found to use a topic with a literal
// space in it ("retained messages/count", not "retained_messages/count"), so indexing by the exact
// suffix string sidesteps having to normalize that.
const brokerStats = new Map();

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

// The gateway registering its OWN Last Will and Testament — the exact MQTT-native "I went away
// ungracefully" signal Shelly/Zigbee2MQTT/Tasmota etc. already give every device they run, which
// LoxSuite itself never had. The broker (not this process) is what actually publishes `offline`
// here the moment it notices this connection is gone without a clean MQTT DISCONNECT first — a
// crash, an OOM-kill, a yanked network cable, a killed container all trigger it, with nothing this
// process needs to do or even be alive for. retain:true so a client that only subscribes later
// still immediately sees the gateway's last known status instead of nothing until its next change.
const LWT_TOPIC = 'loxsuite/gateway/status';

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

function recordMessage(topic, payload, retained) {
  const value = payload.toString().slice(0, 500);
  const now = new Date().toISOString();

  messageLog.unshift({ topic, payload: value, receivedAt: now, retained: !!retained });
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
    // The broker's own retain flag on the message that produced this row's current value — set on
    // essentially every reconnect for many devices (Shelly, Zigbee2MQTT, ...) publish their last
    // known state as retained specifically so a fresh subscriber sees it immediately, without
    // waiting for the device's own next real update. Distinguishing that from a genuinely fresh,
    // just-happened publish is exactly the kind of thing a "why does Incoming Messages show a value
    // from before the gateway even restarted" question needs, and until now had no answer for.
    retained: !!retained,
  });

  totalMessageCount++;
  const nowMs = Date.now();
  recentTimestamps.push(nowMs);
  const cutoff = nowMs - RATE_WINDOW_MS;
  while (recentTimestamps.length && recentTimestamps[0] < cutoff) recentTimestamps.shift();
}

// Mosquitto's own $SYS/broker/* tree — see brokerStats' own comment above. '$SYS/broker/' is 12
// characters; sliced off once here rather than repeated at every call site.
function recordBrokerStat(topic, payload) {
  brokerStats.set(topic.slice(12), payload.toString().slice(0, 200));
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

// A zero-length payload published with retain:true is the MQTT spec's own, universal way to purge
// a topic's retained message from the broker (Mosquitto included — nothing broker-specific here) —
// exactly the "Clear retained" action on Incoming Messages needs for a topic whose only value left
// is a stale replay from a device that's since been renamed, replaced, or removed: without this,
// that stale value keeps replaying to every new subscriber (a fresh mapping, a new monitor, ...)
// forever, with no way to stop it short of publishing over it from outside LoxSuite entirely.
// Removes the topic from topicOverview too — once cleared there's no longer a "current value" for
// it from the broker's own point of view, and if the device is still genuinely alive and publishing
// this topic live (not just retained), its own next publish repopulates the row the normal way.
function clearRetained(topic) {
  if (!client || !state.connected) return;
  client.publish(topic, '', { retain: true });
  topicOverview.delete(topic);
}

// A clean shutdown (SIGTERM — see server.js) sends a real MQTT DISCONNECT, which tells the broker
// to discard the registered Will without publishing it at all — from any OTHER client's point of
// view that would otherwise look like the status topic just freezing on its last "online" forever,
// not like the gateway stopped. Explicitly publishing "offline" here first, and actually waiting
// for it to land (the callback, not a fire-and-forget call) before the process is allowed to exit,
// is what makes a deliberate restart/stop report the same accurate status an ungraceful crash gets
// for free from the broker's own Will delivery. No-op (immediate callback) if there's no live
// connection to publish over in the first place — nothing to correct in that case either way.
function publishOffline(callback) {
  if (!client || !state.connected) {
    callback();
    return;
  }
  client.publish(LWT_TOPIC, 'offline', { qos: 1, retain: true }, () => callback());
}

function attachHandlers(c) {
  c.on('connect', () => {
    state.connected = true;
    // The other half of LWT_TOPIC's own comment above — the broker only ever flips this to
    // "offline" itself (on an ungraceful drop) or gets told to explicitly (see publishOffline,
    // graceful shutdown); it never flips it back to "online" on its own. Every successful
    // (re)connect has to say so itself, including the very first one and every reconnect after a
    // network blip — otherwise a client watching this topic would see a stale "offline" from a
    // PREVIOUS disconnect forever, even while the gateway is right back up and running fine.
    c.publish(LWT_TOPIC, 'online', { qos: 1, retain: true });
    // '#' does not match topics starting with '$' (e.g. $CONTROL, $SYS) per the MQTT spec, so both
    // the dynamic-security response topic and the broker's own $SYS stats need an explicit
    // subscription. The gateway's own MQTT account already has $SYS/# read access — it's granted
    // "admin" (not just "client") dynamic-security role by dynsecBootstrap.js, and that built-in
    // "admin" role's ACLs (confirmed on a real broker) already include subscribePattern $SYS/#, so
    // this needs no ACL change of its own.
    c.subscribe(['#', '$CONTROL/dynamic-security/v1/response', '$SYS/broker/#'], (err) => {
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

  c.on('message', async (topic, payload, packet) => {
    if (topic.startsWith('$SYS/broker/')) { recordBrokerStat(topic, payload); return; }
    if (topic.startsWith('$')) return; // internal broker/control traffic, not an application message

    recordMessage(topic, payload, packet && packet.retain);

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
    // See LWT_TOPIC's own comment above — QoS 1 (not 0) so the broker actually holds onto this
    // one until it's acknowledged delivered/stored, same as the explicit "online"/"offline"
    // publishes below use, rather than the fire-and-forget QoS 0 every other publish in this file
    // uses (those are fine to occasionally drop; a status flag flapping incorrectly isn't).
    will: { topic: LWT_TOPIC, payload: 'offline', qos: 1, retain: true },
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

// Parses a handful of the most generally useful $SYS/broker/* keys (confirmed against a real,
// running Mosquitto 2.x broker — see recordBrokerStat's own comment on why the raw map is keyed by
// exact suffix) into a stable, typed shape for display. Every field is null until the broker's own
// first $SYS publish after this gateway subscribes (up to `sys_interval`, 10s by default) — never
// thrown for a value not seen yet, same "honest unknown" convention every other live-status reading
// in this app already follows.
function num(key) {
  const raw = brokerStats.get(key);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function getBrokerStats() {
  const rawUptime = brokerStats.get('uptime'); // "12345 seconds"
  const uptimeSeconds = rawUptime ? parseInt(rawUptime, 10) : null;
  return {
    version: brokerStats.get('version') || null, // "mosquitto version 2.1.2"
    uptimeSeconds: Number.isNaN(uptimeSeconds) ? null : uptimeSeconds,
    clientsConnected: num('clients/connected'),
    clientsTotal: num('clients/total'),
    clientsMaximum: num('clients/maximum'),
    messagesReceived: num('messages/received'),
    messagesSent: num('messages/sent'),
    bytesReceived: num('bytes/received'),
    bytesSent: num('bytes/sent'),
    retainedMessageCount: num('retained messages/count'),
    subscriptionsCount: num('subscriptions/count'),
    load1minMessagesReceived: num('load/messages/received/1min'),
    load1minMessagesSent: num('load/messages/sent/1min'),
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
  getBrokerStats,
  recordMessage,
  // Exported for the same reason recordMessage is: test/mqttClient.test.js exercises the message-
  // handling logic directly, without a real broker connection to publish a real $SYS/broker/* line.
  recordBrokerStat,
  requestDeviceAnnounce,
  clearRetained,
  publishOffline,
  LWT_TOPIC,
};
