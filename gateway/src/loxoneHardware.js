const { XMLParser } = require('fast-xml-parser');
const db = require('./db');
const { fetchMiniserver } = require('./loxone');
const { checkBatteryWeak, checkDeviceFirmwareChanged, checkDeviceOffline } = require('./notifications');
const { getStructure } = require('./loxoneStructure');
const { ensureConnection, getLiveValue } = require('./loxoneWebSocket');

// Confirmed real, documented endpoint (not guessed, same as loxoneLog.js's own def.log): GET
// /data/status, Basic Auth, returns one <Status><Miniserver>...</Miniserver></Status> XML document
// describing every piece of hardware the Miniserver knows about (Air/Tree/1-Wire devices,
// Extensions, third-party Plugin devices, Audioserver zones) — battery/firmware/signal-quality
// included. Polled far less often than def.log (LOXONE_LOG_POLL_MS in logCollector.js): hardware
// status changes on the order of minutes-to-hours, not the sub-second cadence a log stream can.
const POLL_MS = 5 * 60 * 1000;

// Only these tags can legitimately repeat as siblings at some depth in the tree (a device family,
// a list of Air devices under an Extension, ...) — forcing them to always parse as arrays (even
// when exactly one is present) means the flattening code below never has to branch on "is this one
// object or an array of one," the same reasoning deviceTemplates.js's own XMLParser config gives.
const ARRAY_TAGS = new Set([
  'NetworkDevices', 'Plugin', 'GenDev', 'TreeBranch', 'TreeDevice', 'Link', 'Extension',
  'AirDevice', 'OneWireDevice', 'MultiMediaServer', 'TreeTurbo', 'Zone',
]);

// parseAttributeValue/parseTagValue off, same as deviceTemplates.js's own parser — a Serial like
// "00000000" or a Code like "-2147352395" must stay a string, not get silently reinterpreted.
//
// attributesGroupName is NOT optional here, unlike deviceTemplates.js's own (attribute-only)
// parser: confirmed against a real /data/status document that a MultiMediaServer (Audioserver)
// element has BOTH its own "TreeTurbo" attribute (a version string) AND a child <TreeTurbo> element
// of the same name (the actual Tree Turbo speaker zones). With attributesGroupName unset, the two
// collide under the plain default config and the child element's real data is silently discarded —
// grouping attributes under their own "$" key keeps every attribute (node.$.Foo) unambiguous from
// any same-named child tag (node.Foo).
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributesGroupName: '$',
  attributeNamePrefix: '',
  textNodeName: 'text',
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (tagName) => ARRAY_TAGS.has(tagName),
});

function asArray(v) {
  return v == null ? [] : (Array.isArray(v) ? v : [v]);
}
function bool(v) {
  return v === 'true';
}
function num(v) {
  return v == null || v === '' ? null : Number(v);
}

// Best available stable identity for a hardware item — a real Serial when the device has one
// (Air/Tree/Extension/1-Wire), else its GenericID (Plugin/GenDev, which have no Serial at all),
// else a MAC (Audioserver/zone), else a last-resort category+name pairing. NOT always a literal
// hardware serial number despite what the eventual `serial` column implies — see db.js's own
// comment on loxone_hardware_devices.
function deviceKeyFor(item) {
  return item.serial || item.genericId || item.mac || `${item.category}:${item.name}`;
}

function baseItem(fields) {
  return {
    serial: null, place: null, version: null, minVersion: null, hwVersion: null,
    online: null, battery: null, battWeak: false, batTooWeakForUpdate: false,
    qualityExt: null, qualityDev: null, hops: null, timeDiff: null, mac: null, genericId: null,
    zoneOf: null, audioOutput: null,
    ...fields,
  };
}

// Walks the parsed /data/status document into a flat list of hardware items. DummyDev="true"
// entries (an unpopulated Extension/Tree slot Loxone Config still lists as a placeholder — e.g. a
// spare relay extension port never actually wired to anything) are skipped entirely, since they
// aren't real installed hardware and would otherwise clutter the overview as permanently "offline"
// rows nobody can act on. TreeBranch itself (a bus segment, not a physical box on its own) is
// walked for its TreeDevice children only, never added as a row in its own right.
function flattenStatus(parsed) {
  const items = [];
  const status = parsed.Status || {};
  const miniserverNode = status.Miniserver || {};

  function push(fields) {
    items.push(baseItem(fields));
  }

  // Every element's own attributes live under its "$" key (see xmlParser's attributesGroupName
  // comment above) — a child TAG of the same name (TreeTurbo being the one real example) stays a
  // direct property instead, so the two can never collide.
  function walkTreeBranch(branch) {
    asArray(branch.TreeDevice).forEach((td) => {
      const a = td.$ || {};
      if (bool(a.DummyDev)) return;
      push({
        category: 'tree', type: 'Tree device', name: a.Name, place: a.Place, serial: a.Serial,
        version: a.Version, hwVersion: a.HwVersion, online: bool(a.Online), timeDiff: num(a.TimeDiff),
      });
    });
  }

  function walkAirDevice(ad) {
    const a = ad.$ || {};
    if (bool(a.DummyDev)) return;
    push({
      category: 'air', type: a.Type, name: a.Name, place: a.Place, serial: a.Serial,
      version: a.Version, minVersion: a.MinVersion, hwVersion: a.HwVersion, online: bool(a.Online),
      battery: num(a.Battery), battWeak: bool(a.BattWeak), batTooWeakForUpdate: bool(a.BatTooWeakForUpdate),
      qualityExt: num(a.QualityExt), qualityDev: num(a.QualityDev), hops: num(a.Hops), timeDiff: num(a.TimeDiff),
    });
  }

  function walkOneWire(ow) {
    const a = ow.$ || {};
    push({ category: 'onewire', type: '1-Wire device', name: a.Name, serial: a.Serial, online: bool(a.Online), timeDiff: num(a.TimeDiff) });
  }

  function walkExtension(ext) {
    const a = ext.$ || {};
    if (!bool(a.DummyDev)) {
      push({
        category: 'extension', type: a.Type, name: a.Name, serial: a.Serial,
        version: a.Version, hwVersion: a.HwVersion, online: bool(a.Online), mac: a.Mac,
      });
    }
    asArray(ext.TreeBranch).forEach(walkTreeBranch);
    asArray(ext.AirDevice).forEach(walkAirDevice);
    asArray(ext.OneWireDevice).forEach(walkOneWire);
  }

  function walkNetworkDevices(nd) {
    asArray(nd.Plugin).forEach((p) => {
      const pa = p.$ || {};
      push({ category: 'plugin', type: pa.Type, name: pa.Name, version: pa.Version, online: bool(pa.Online), genericId: pa.GenericID });
      asArray(p.GenDev).forEach((gd) => {
        const ga = gd.$ || {};
        push({ category: 'gendev', type: ga.Type, name: ga.Name, place: ga.Place, online: bool(ga.Online), genericId: ga.GenericID });
      });
    });
    asArray(nd.MultiMediaServer).forEach((mm) => {
      const mma = mm.$ || {};
      push({ category: 'audio_server', type: 'Audioserver', name: mma.Name, place: mma.Place, version: mma.Version, mac: mma.MAC });
      // TreeTurbo.Zone here is the PHYSICAL Stereo Extension hardware attached to this
      // Audioserver over its Tree Turbo bus — e.g. "Stereo Extension 1", its own real MAC — a
      // completely different thing from an AudioZoneV2 room zone (Badkamer, Woonkamer, ...)
      // despite the confusingly identical XML tag name and this app's own earlier "audio_zone"
      // category once conflating the two. Kept as its own 'audio_extension' category rather than
      // merged back into 'audio_zone' specifically to avoid repeating that mistake. online stays
      // null (honest "unknown," matching every other never-verified reading on this page) — CState
      // is present on this XML element but its meaning isn't documented or confirmed anywhere, so
      // it's deliberately not interpreted as a status rather than guessed. There is no confirmed
      // way (checked both this XML and the Structure File's own AudioZoneV2.details) to tell which
      // physical extension a given room zone's audio actually comes out of — Loxone Config likely
      // knows that wiring, but doesn't appear to expose it through either API.
      asArray(mm.TreeTurbo).forEach((tt) => {
        asArray(tt.Zone).forEach((z) => {
          const za = z.$ || {};
          // The Zone element itself carries no Place of its own — physically it's Tree-bus wired
          // right to its Audioserver, so the parent's Place (mma.Place, already used for the
          // audio_server row above) is the correct place for it too, not a guess.
          push({ category: 'audio_extension', type: 'Audio extension', name: za.Name, place: mma.Place, version: za.VER, mac: za.MAC });
        });
      });
    });
  }

  asArray(miniserverNode.TreeBranch).forEach(walkTreeBranch);
  asArray(miniserverNode.NetworkDevices).forEach(walkNetworkDevices);
  asArray(miniserverNode.Link).forEach((link) => asArray(link.Extension).forEach(walkExtension));
  // ManagedTablets/Audio's own NetworkDevices are siblings of <Miniserver>, not inside it.
  asArray(status.NetworkDevices).forEach(walkNetworkDevices);

  return items.map((item) => ({ ...item, deviceKey: deviceKeyFor(item) }));
}

// AudioZoneV2's own details.speakerConfig — a bitmask of the physical HARDWARE KIND a zone's
// audio plays through, per Loxone's own Structure File documentation (v17.0). Says which kind, not
// which specific unit — e.g. "a Stereo Extension" (Bit 1) never says which of possibly several a
// Miniserver has, and the API exposes no field anywhere (checked both this and the /data/status
// XML's own TreeTurbo.Zone entries) that links a zone to one specific physical extension's MAC.
// Bits can combine (e.g. a zone with both a Subwoofer and a Stereo Extension) — every set bit gets
// its own label, most-specific-first, joined for display; an unset/unrecognized value (0, or a bit
// this list doesn't cover yet) returns null rather than a misleading empty string.
const SPEAKER_CONFIG_BITS = [
  { bit: 1 << 0, label: 'Stereo Extension' },
  { bit: 1 << 1, label: 'Master Speakers' },
  { bit: 1 << 2, label: 'Audioserver Channel' },
  { bit: 1 << 8, label: 'Subwoofer' },
  { bit: 1 << 9, label: 'Client Speaker' },
  { bit: 1 << 10, label: 'Speaker' },
  { bit: 1 << 11, label: 'Bluetooth' },
];
function describeSpeakerConfig(value) {
  if (typeof value !== 'number' || value === 0) return null;
  const labels = SPEAKER_CONFIG_BITS.filter((b) => value & b.bit).map((b) => b.label);
  return labels.length ? labels.join(', ') : null;
}

// -5 rebooting, -2 not reachable, -1 unknown, 0 offline, 1 initializing, 2 online (Loxone's own
// Structure File documentation, AudioZoneV2/mediaServer states) — only the two ends of that scale
// are a clean, reportable transition; -1/1/-2/-5 collapse to null ("don't know yet") same as every
// other category's online column already does for an ambiguous reading.
function audioStateToOnline(value) {
  if (value == null) return null;
  const n = Number(value);
  if (n >= 2) return 1;
  if (n === 0) return 0;
  return null;
}

// Same live-value resolution monitorCollector.js's pollLoxoneMonitor already uses for "Loxone
// (direct, polled)" monitors: the websocket push cache (loxoneWebSocket.js) answers almost every
// state instantly; /jdev/sps/io/<uuid> is only a fallback for the few it doesn't cover yet — and,
// confirmed against a real installation, AudioZoneV2's own clientState/serverState are NOT among
// them (that endpoint 404s for both), so the websocket cache is the only path that actually works
// here. A brand new connection (see getAudioZoneItems's own waitForOpen call) reaches "open"
// noticeably before Loxone's own initial state dump has finished landing in that cache (measured
// ~150-200ms on a real installation) — retried a few times, cheaply, rather than a single read
// that would otherwise race the dump and permanently read "unknown" for a connection's first ever
// poll. Every retry after the very first poll finds an already-warm cache and returns immediately.
async function resolveLiveState(miniserver, uuid) {
  if (!uuid) return null;
  for (let attempt = 0; attempt < 15; attempt++) {
    const cached = getLiveValue(miniserver.id, uuid);
    if (cached !== undefined) return cached;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  try {
    const res = await fetchMiniserver(miniserver, `/jdev/sps/io/${encodeURIComponent(uuid)}`, { timeoutMs: 8000 });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.LL?.value ?? null;
  } catch {
    return null;
  }
}

// The Audioserver's OWN web UI (confirmed against a real unit, unauthenticated) answers a plain
// GET /version with clean JSON — {"version":"17.02.08.11"} — unlike the /data/status XML's own
// Version attribute for it, which is a whole descriptive string (model, MAC, API level, ...) meant
// for display in Loxone Config, not really "just the version". mediaServer.host (Structure File)
// is "<ip>:7091", a different internal protocol port that doesn't understand /version at all
// (confirmed — answers a JSON error instead) — only the bare host, default port 80, works.
async function fetchAudioserverVersion(host) {
  const ip = String(host || '').split(':')[0];
  if (!ip) return null;
  try {
    const res = await fetch(`http://${ip}/version`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.version || null;
  } catch {
    return null;
  }
}

// An Audioserver's item.version alternates, poll to poll, between this function's own plain
// firmware number ("17.02.08.11") and /data/status's verbose descriptive string ("MINISERVER V
// 17.2.08.11 <mac> | ~API:2.0~") whenever the direct fetch above happens to fail (different
// subnet, firewalled, a transient blip) and pollMiniserver's own fallback below keeps the XML's
// version instead — see that fallback's own comment. Comparing those two representations of the
// identical firmware verbatim fired a false "firmware changed" notification every time reachability
// flipped one way then back; extracting just the dotted version number (and normalizing away each
// segment's own leading zeros — "17.2.08.11" vs "17.02.08.11" is the same version, not a bump from
// 2 to 02) makes the comparison recognize them as equal either way.
function extractFirmwareVersion(version) {
  const match = String(version || '').match(/\d+(?:\.\d+){2,3}/);
  if (!match) return version || null;
  return match[0].split('.').map((n) => String(Number(n))).join('.');
}

// Reads the Structure File (LoxAPP3.json, cached indefinitely per Miniserver by
// loxoneStructure.js — cheap to call every poll) for AudioZoneV2 controls, resolving each one's
// live online status and its parent mediaServer's own name/MAC/online/firmware. Returns
// { serverOnlineByMac, serverVersionByMac, zoneItems } — the two serverBy* maps let pollMiniserver
// enrich the XML-derived 'audio_server' row (which has a MAC but no online status, and only the
// XML's own messy Version string) by matching against the mediaServer's own MAC (confirmed present
// on a real installation, alongside its friendly name and host); zoneItems are new 'audio_zone'
// rows in their own right, keyed by the control's own stable UUID (device_key) rather than a MAC —
// a zone has no MAC of its own anywhere in either API.
async function getAudioZoneItems(miniserver) {
  try {
    const structure = await getStructure(miniserver);
    const mediaServers = structure.mediaServer || {};
    // Same idempotent "start one if needed, leave an existing one alone" connection every other
    // live-value consumer in the app shares (monitorCollector.js, Live Data, ...) — waitForOpen
    // resolves immediately if it's already open (the normal case, after the very first poll ever),
    // so this only actually waits on a genuinely first-ever connection to this Miniserver.
    await ensureConnection(miniserver).waitForOpen(8000);

    const serverOnlineByMac = new Map();
    const serverVersionByMac = new Map();
    const serverNameByUuid = new Map();
    for (const [uuid, server] of Object.entries(mediaServers)) {
      serverNameByUuid.set(uuid, server.name || null);
      if (server.mac) {
        const online = audioStateToOnline(await resolveLiveState(miniserver, server.states?.serverState));
        serverOnlineByMac.set(server.mac.toUpperCase(), online);
        const version = await fetchAudioserverVersion(server.host);
        if (version) serverVersionByMac.set(server.mac.toUpperCase(), version);
      }
    }

    const zoneItems = [];
    for (const control of Object.values(structure.controls || {})) {
      if (control.type !== 'AudioZoneV2') continue;
      const details = control.details || {};
      const online = audioStateToOnline(await resolveLiveState(miniserver, control.states?.clientState));
      zoneItems.push(baseItem({
        category: 'audio_zone',
        type: 'Audio zone',
        name: control.name || null,
        deviceKey: control.uuidAction,
        online,
        zoneOf: serverNameByUuid.get(details.server) || null,
        audioOutput: describeSpeakerConfig(details.speakerConfig),
      }));
    }
    return { serverOnlineByMac, serverVersionByMac, zoneItems };
  } catch (err) {
    // No Audioserver on this Miniserver, structure file unreachable, unexpected shape, ... —
    // degrades to "no audio zone rows/enrichment this poll," never breaks the rest of the
    // hardware poll (which has already succeeded by the time this runs — see pollMiniserver).
    console.error(`Failed to read audio zone status for miniserver ${miniserver.id} (${miniserver.name}):`, err.message);
    return { serverOnlineByMac: new Map(), serverVersionByMac: new Map(), zoneItems: [] };
  }
}

const selectExisting = db.prepare(
  'SELECT device_key, version, online, batt_weak, bat_too_weak_for_update FROM loxone_hardware_devices WHERE miniserver_id = ?'
);
// The delete+reinsert pair below live inside pollMiniserver's own transaction, prepared fresh
// against its tx handle rather than cached here at module level — see db/knex.js's own comment on
// why a statement prepared against the outer db can't be used inside a transaction. Positional (?)
// placeholders for the insert, not better-sqlite3's own @name object-binding style this used to
// use — the async facade routes every query through Knex's raw(), whose own named-binding syntax
// is :name (colon, not @), so keeping the named style would need special-casing object-vs-array
// bindings in the facade for the sake of two files (see notifications.js's own version of this same
// change) — matching the plain ?-positional style every other query in the app already uses
// instead is simpler.
//
// Same log_entries table logs-loxone.ejs already reads from (source='loxone') — every hardware
// transition below is written here UNCONDITIONALLY, regardless of whether any notification rule
// exists for it, so the Loxone log stays the complete record and alerting stays a separate,
// opt-in concern on top of it (see checkBatteryWeak/checkDeviceFirmwareChanged/checkDeviceOffline,
// which only fire for rules that were actually configured).
const insertLogLine = db.prepare(
  'INSERT INTO log_entries (source, source_id, source_label, line, recorded_at) VALUES (?, ?, ?, ?, ?)'
);

async function pollMiniserver(miniserver) {
  // Skip entirely while the Miniserver itself is known to be offline (per healthcheck.js's own
  // ping, the same status checkMiniserverStatus's own "Miniserver online/offline" rule already
  // alerts on) — status is also null/unset before that check has run even once, which this treats
  // the same way. Matters most during a reboot: /data/status can start responding again before the
  // Air/Tree mesh has resynced, with every device briefly reporting Online="false" at once — that
  // would otherwise flood the Loxone log and any device_offline/battery_weak rule with one false
  // alert per device, on top of the Miniserver's own (already sufficient) offline notification.
  if (miniserver.status !== 'online') return;
  try {
    const res = await fetchMiniserver(miniserver, '/data/status', { timeoutMs: 15000 });
    if (!res.ok) throw new Error(`Miniserver responded with HTTP ${res.status}`);
    const text = await res.text();
    const items = flattenStatus(xmlParser.parse(text));

    // Only bother reading the Structure File at all when there's actually an Audioserver on this
    // Miniserver — most installs have none, and getStructure/resolveLiveState would otherwise run
    // every 5-minute poll for nothing.
    if (items.some((item) => item.category === 'audio_server')) {
      const { serverOnlineByMac, serverVersionByMac, zoneItems } = await getAudioZoneItems(miniserver);
      for (const item of items) {
        if (item.category !== 'audio_server' || !item.mac) continue;
        const mac = item.mac.toUpperCase();
        if (serverOnlineByMac.has(mac)) item.online = serverOnlineByMac.get(mac);
        // The Audioserver's own /version replaces the XML's whole descriptive Version string
        // (model/MAC/API level, meant for Loxone Config's own display) with just the plain
        // firmware number — falls back to that XML string if the Audioserver's web UI couldn't
        // be reached directly (different subnet, firewalled, ...), never leaves it blank.
        if (serverVersionByMac.has(mac)) item.version = serverVersionByMac.get(mac);
      }
      items.push(...zoneItems);
    }

    // Read before this poll's own delete+reinsert overwrites them — the only way to know what
    // "changed since last time" actually means for battery/firmware transitions below.
    const previous = new Map((await selectExisting.all(miniserver.id)).map((r) => [r.device_key, r]));
    const now = new Date().toISOString();

    await db.transaction(async (tx) => {
      await tx.prepare('DELETE FROM loxone_hardware_devices WHERE miniserver_id = ?').run(miniserver.id);
      const insert = tx.prepare(`
        INSERT INTO loxone_hardware_devices
          (miniserver_id, device_key, category, type, name, place, serial, version, min_version, hw_version,
           online, battery, batt_weak, bat_too_weak_for_update, quality_ext, quality_dev, hops, time_diff, mac,
           zone_of, audio_output, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        await insert.run(
          miniserver.id,
          item.deviceKey,
          item.category,
          item.type || null,
          item.name || null,
          item.place || null,
          item.serial || null,
          item.version || null,
          item.minVersion || null,
          item.hwVersion || null,
          item.online === null ? null : (item.online ? 1 : 0),
          item.battery,
          item.battWeak ? 1 : 0,
          item.batTooWeakForUpdate ? 1 : 0,
          item.qualityExt,
          item.qualityDev,
          item.hops,
          item.timeDiff,
          item.mac || null,
          item.zoneOf || null,
          item.audioOutput || null,
          now
        );
      }
    });

    // A Gateway Client setup means the Gateway's own /data/status already reports every one of its
    // Clients' hardware too (see routes/hardware.js's own dedup comment — confirmed against a real
    // installation, not just Audioservers/zones) — so polling a Client Miniserver sees the exact
    // same devices its Gateway already saw (or is about to see) in its own, independent poll.
    // Logging still happens unconditionally below (each Miniserver's own Loxone log should read as
    // a complete, honest record of what it itself reported), but firing a notification from BOTH
    // copies of one physical transition would mean two separate alerts for the same real event —
    // suppressed here in favor of the Gateway's own poll, the same "prefer the Gateway's copy"
    // choice routes/hardware.js's display-side dedup already makes.
    const skipNotify = !!miniserver.gateway_client_of;

    // Transition-only, same reasoning as checkFirmwareChanged's own !miniserver.firmware_version
    // guard — a device seen for the first time ever (no `prev` row) has nothing to have "changed"
    // from, so it never fires here.
    for (const item of items) {
      const prev = previous.get(item.deviceKey);
      if (!prev) continue;
      const label = item.name || item.type || item.deviceKey;

      if (item.version && prev.version && extractFirmwareVersion(item.version) !== extractFirmwareVersion(prev.version)) {
        await insertLogLine.run('loxone', miniserver.id, miniserver.name, `Hardware: "${label}" firmware changed from ${prev.version} to ${item.version}.`, now);
        if (!skipNotify) await checkDeviceFirmwareChanged(miniserver, item, prev.version);
      }

      const wasWeak = !!prev.batt_weak || !!prev.bat_too_weak_for_update;
      const isWeak = item.battWeak || item.batTooWeakForUpdate;
      if (isWeak && !wasWeak) {
        await insertLogLine.run('loxone', miniserver.id, miniserver.name, `Hardware: "${label}" battery weak${item.battery != null ? ` (${item.battery}%)` : ''}.`, now);
        if (!skipNotify) await checkBatteryWeak(miniserver, item);
      }

      // null on either side means "this category never reports Online at all" (Audioserver/Zone/
      // some Plugins) — not a genuine transition to detect.
      if (item.online !== null && prev.online !== null && Number(prev.online) !== (item.online ? 1 : 0)) {
        await insertLogLine.run('loxone', miniserver.id, miniserver.name, `Hardware: "${label}" is now ${item.online ? 'online' : 'offline'}.`, now);
        if (!skipNotify) await checkDeviceOffline(miniserver, item, item.online);
      }
    }
  } catch (err) {
    console.error(`Failed to fetch Loxone hardware status for miniserver ${miniserver.id} (${miniserver.name}):`, err.message);
  }
}

async function pollAllMiniservers() {
  const miniservers = await db.prepare('SELECT * FROM miniservers').all();
  await Promise.all(miniservers.map((ms) => pollMiniserver(ms)));
}

function startHardwarePolling() {
  pollAllMiniservers();
  setInterval(pollAllMiniservers, POLL_MS);
}

module.exports = { startHardwarePolling, flattenStatus };
