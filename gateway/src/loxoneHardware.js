const { XMLParser } = require('fast-xml-parser');
const db = require('./db');
const { fetchMiniserver } = require('./loxone');
const { checkBatteryWeak, checkDeviceFirmwareChanged, checkDeviceOffline } = require('./notifications');

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
      asArray(mm.TreeTurbo).forEach((tt) => {
        asArray(tt.Zone).forEach((z) => {
          const za = z.$ || {};
          push({ category: 'audio_zone', type: 'Audio zone', name: za.Name, version: za.VER, mac: za.MAC });
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

const selectExisting = db.prepare(
  'SELECT device_key, version, online, batt_weak, bat_too_weak_for_update FROM loxone_hardware_devices WHERE miniserver_id = ?'
);
const deleteForMiniserver = db.prepare('DELETE FROM loxone_hardware_devices WHERE miniserver_id = ?');
// Same log_entries table logs-loxone.ejs already reads from (source='loxone') — every hardware
// transition below is written here UNCONDITIONALLY, regardless of whether any notification rule
// exists for it, so the Loxone log stays the complete record and alerting stays a separate,
// opt-in concern on top of it (see checkBatteryWeak/checkDeviceFirmwareChanged/checkDeviceOffline,
// which only fire for rules that were actually configured).
const insertLogLine = db.prepare(
  'INSERT INTO log_entries (source, source_id, source_label, line, recorded_at) VALUES (?, ?, ?, ?, ?)'
);
const insertDevice = db.prepare(`
  INSERT INTO loxone_hardware_devices
    (miniserver_id, device_key, category, type, name, place, serial, version, min_version, hw_version,
     online, battery, batt_weak, bat_too_weak_for_update, quality_ext, quality_dev, hops, time_diff, mac, updated_at)
  VALUES
    (@miniserverId, @deviceKey, @category, @type, @name, @place, @serial, @version, @minVersion, @hwVersion,
     @online, @battery, @battWeak, @batTooWeakForUpdate, @qualityExt, @qualityDev, @hops, @timeDiff, @mac, @updatedAt)
`);

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

    // Read before this poll's own delete+reinsert overwrites them — the only way to know what
    // "changed since last time" actually means for battery/firmware transitions below.
    const previous = new Map(selectExisting.all(miniserver.id).map((r) => [r.device_key, r]));
    const now = new Date().toISOString();

    const applyAll = db.transaction(() => {
      deleteForMiniserver.run(miniserver.id);
      for (const item of items) {
        insertDevice.run({
          miniserverId: miniserver.id,
          deviceKey: item.deviceKey,
          category: item.category,
          type: item.type || null,
          name: item.name || null,
          place: item.place || null,
          serial: item.serial || null,
          version: item.version || null,
          minVersion: item.minVersion || null,
          hwVersion: item.hwVersion || null,
          online: item.online === null ? null : (item.online ? 1 : 0),
          battery: item.battery,
          battWeak: item.battWeak ? 1 : 0,
          batTooWeakForUpdate: item.batTooWeakForUpdate ? 1 : 0,
          qualityExt: item.qualityExt,
          qualityDev: item.qualityDev,
          hops: item.hops,
          timeDiff: item.timeDiff,
          mac: item.mac || null,
          updatedAt: now,
        });
      }
    });
    applyAll();

    // Transition-only, same reasoning as checkFirmwareChanged's own !miniserver.firmware_version
    // guard — a device seen for the first time ever (no `prev` row) has nothing to have "changed"
    // from, so it never fires here.
    for (const item of items) {
      const prev = previous.get(item.deviceKey);
      if (!prev) continue;
      const label = item.name || item.type || item.deviceKey;

      if (item.version && prev.version && item.version !== prev.version) {
        insertLogLine.run('loxone', miniserver.id, miniserver.name, `Hardware: "${label}" firmware changed from ${prev.version} to ${item.version}.`, now);
        checkDeviceFirmwareChanged(miniserver, item, prev.version);
      }

      const wasWeak = !!prev.batt_weak || !!prev.bat_too_weak_for_update;
      const isWeak = item.battWeak || item.batTooWeakForUpdate;
      if (isWeak && !wasWeak) {
        insertLogLine.run('loxone', miniserver.id, miniserver.name, `Hardware: "${label}" battery weak${item.battery != null ? ` (${item.battery}%)` : ''}.`, now);
        checkBatteryWeak(miniserver, item);
      }

      // null on either side means "this category never reports Online at all" (Audioserver/Zone/
      // some Plugins) — not a genuine transition to detect.
      if (item.online !== null && prev.online !== null && Number(prev.online) !== (item.online ? 1 : 0)) {
        insertLogLine.run('loxone', miniserver.id, miniserver.name, `Hardware: "${label}" is now ${item.online ? 'online' : 'offline'}.`, now);
        checkDeviceOffline(miniserver, item, item.online);
      }
    }
  } catch (err) {
    console.error(`Failed to fetch Loxone hardware status for miniserver ${miniserver.id} (${miniserver.name}):`, err.message);
  }
}

function pollAllMiniservers() {
  const miniservers = db.prepare('SELECT * FROM miniservers').all();
  miniservers.forEach(pollMiniserver);
}

function startHardwarePolling() {
  pollAllMiniservers();
  setInterval(pollAllMiniservers, POLL_MS);
}

module.exports = { startHardwarePolling, flattenStatus };
