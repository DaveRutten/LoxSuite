// Reference catalog for "Common commands" — topic templates for well-known MQTT
// device families, used by the interactive command builder. {device} and {channel}
// are placeholders filled in client-side from the selected device/channel.
//
// topicPrefixPattern is used server-side to find real device IDs for a family:
// it's matched against every topic the broker has actually seen, and capture
// group 1 is taken as the device ID. This reads the ID out of the device's own
// traffic (e.g. its state topics), which is the actual value used in its topics
// — not necessarily the same as its raw MQTT client ID (a device's configured
// "MQTT prefix" can differ from its client ID/hostname).
//
// Shelly's two generations use genuinely different MQTT shapes, not just different topic
// strings — Gen1 puts the channel IN the topic and sends a bare "on"/"off"/... string as the
// payload; Gen2/Gen3 (Plus/Pro/Mini) use ONE static topic per device and a JSON-RPC document as
// the payload, with the channel/switch id embedded INSIDE that JSON instead. {channel} is valid
// in an `actions` string for exactly this reason — it's substituted the same way {device} already
// is wherever it appears, topic or payload.
//
// Gen1 itself is listed per real product name (Shelly 1, Shelly Plug S, ...) rather than one
// generic "Shelly Gen1" bucket — every one of them uses the exact same handful of underlying
// topic shapes (relay/roller/light/color/white), confirmed against a real Loxone Config
// VirtualOutput export covering a dozen+ of these, but picking your own product's name out of a
// dropdown is a lot friendlier than knowing that they're all secretly the same thing. Order here
// matters: topicPrefixPattern auto-detection (see deviceDiscovery.js) is first-match-wins, so a
// model whose own ID prefix is a literal superstring of another's (shellyplug-s-... starts with
// "shellyplug-") has to come BEFORE the shorter one, and the fully generic Gen1 fallback has to
// stay last of all.
function relayCommand() {
  return { key: 'relay', label: 'Relay switch', topicTemplate: 'shellies/{device}/relay/{channel}/command', actions: ['on', 'off', 'toggle'] };
}
function rollerCommand() {
  return { key: 'roller', label: 'Roller shutter', topicTemplate: 'shellies/{device}/roller/{channel}/command', actions: ['open', 'close', 'stop'] };
}
function lightCommand() {
  return { key: 'light', label: 'Light (dimmer)', topicTemplate: 'shellies/{device}/light/{channel}/command', actions: ['on', 'off', 'toggle'] };
}
function colorCommand() {
  return { key: 'color', label: 'Color', topicTemplate: 'shellies/{device}/color/{channel}/command', actions: ['on', 'off', 'toggle'] };
}
function whiteCommand() {
  return { key: 'white', label: 'White channel', topicTemplate: 'shellies/{device}/white/{channel}/command', actions: ['on', 'off', 'toggle'] };
}

const CATALOG = [
  { key: 'shelly-1', label: 'Shelly 1', topicPrefixPattern: '^shellies/(shelly1-[^/]+)/', commands: [relayCommand()] },
  { key: 'shelly-1l', label: 'Shelly 1L', topicPrefixPattern: '^shellies/(shelly1l-[^/]+)/', commands: [relayCommand()] },
  { key: 'shelly-1pm', label: 'Shelly 1PM', topicPrefixPattern: '^shellies/(shelly1pm-[^/]+)/', commands: [relayCommand()] },
  // Plug S's own id prefix ("shellyplug-s-...") starts with plain Plug's ("shellyplug-"), so it
  // has to be checked first or every Plug S would get claimed as a plain Plug instead.
  { key: 'shelly-plug-s', label: 'Shelly Plug S', topicPrefixPattern: '^shellies/(shellyplug-s-[^/]+)/', commands: [relayCommand()] },
  { key: 'shelly-plug', label: 'Shelly Plug', topicPrefixPattern: '^shellies/(shellyplug-[^/]+)/', commands: [relayCommand()] },
  { key: 'shelly-2', label: 'Shelly 2 (relay or roller)', topicPrefixPattern: '^shellies/(shellyswitch-[^/]+)/', commands: [relayCommand(), rollerCommand()] },
  { key: 'shelly-25', label: 'Shelly 2.5 (relay or roller)', topicPrefixPattern: '^shellies/(shellyswitch25-[^/]+)/', commands: [relayCommand(), rollerCommand()] },
  { key: 'shelly-4pro', label: 'Shelly 4Pro', topicPrefixPattern: '^shellies/(shelly4pro-[^/]+)/', commands: [relayCommand()] },
  { key: 'shelly-dimmer', label: 'Shelly Dimmer / Dimmer 2', topicPrefixPattern: '^shellies/(shellydimmer2?-[^/]+)/', commands: [lightCommand()] },
  { key: 'shelly-bulb', label: 'Shelly Bulb (RGBW, color mode)', topicPrefixPattern: '^shellies/(shellybulb-[^/]+)/', commands: [colorCommand(), whiteCommand()] },
  { key: 'shelly-bulb-duo', label: 'Shelly Bulb Duo (white/tunable)', topicPrefixPattern: '^shellies/(shellybulbduo-[^/]+)/', commands: [lightCommand()] },
  { key: 'shelly-vintage', label: 'Shelly Vintage', topicPrefixPattern: '^shellies/(shellyvintage-[^/]+)/', commands: [lightCommand()] },
  { key: 'shelly-rgbw2', label: 'Shelly RGBW2', topicPrefixPattern: '^shellies/(shellyrgbw2-[^/]+)/', commands: [colorCommand(), whiteCommand()] },
  { key: 'shelly-em', label: 'Shelly EM (energy meter + relay)', topicPrefixPattern: '^shellies/(shellyem-[^/]+)/', commands: [relayCommand()] },
  { key: 'shelly-3em', label: 'Shelly 3EM (energy meter + relay)', topicPrefixPattern: '^shellies/(shelly3em-[^/]+)/', commands: [relayCommand()] },
  { key: 'shelly-uni', label: 'Shelly Uni', topicPrefixPattern: '^shellies/(shellyuni-[^/]+)/', commands: [relayCommand()] },
  {
    key: 'shelly-gen2-simple',
    label: 'Shelly Gen2/Gen3 (Plus/Pro, simple mode)',
    // Gen2/Gen3 devices also expose a much simpler, Gen1-flavored MQTT command set alongside
    // their full JSON-RPC one below — plain "on"/"off"/"toggle"/"open"/"close"/"stop" strings
    // published to a per-component topic, no JSON needed. Confirmed working topic shape (from a
    // real Loxone community reference): "shellies/<device>/command/switch:<channel>" and
    // ".../command/cover:<channel>" — note the colon before the channel number, not another slash.
    // The "shellies/" prefix itself has to be turned on in the device's own MQTT settings (Gen2+
    // devices subscribe under their bare device ID by default, not "shellies/..." the way Gen1
    // always did) — if you haven't done that, use the plain RPC family below instead, whose own
    // pattern already expects the un-prefixed default.
    topicPrefixPattern: '^shellies/(shelly[a-z0-9]+-[0-9a-f]+)/',
    commands: [
      {
        key: 'switch',
        label: 'Switch (relay)',
        topicTemplate: 'shellies/{device}/command/switch:{channel}',
        actions: ['on', 'off', 'toggle'],
      },
      {
        key: 'cover',
        label: 'Cover (roller shutter)',
        topicTemplate: 'shellies/{device}/command/cover:{channel}',
        actions: ['open', 'close', 'stop'],
      },
    ],
  },
  {
    key: 'shelly-gen2',
    label: 'Shelly Gen2/Gen3 (Plus/Pro/Mini, full RPC/JSON)',
    // Gen2+ device IDs look like "shellyplus1-08b61fcb2ce8" / "shellypro2pm-a8032ab...", and every
    // one of them publishes its own status under "<device>/status/...", not just "<device>/rpc" —
    // matched loosely against the first path segment so any Gen2/Gen3 model is picked up. This is
    // the un-prefixed DEFAULT topic base (no "shellies/") — the simple-mode family above needs
    // that prefix turned on in the device's own settings, this one doesn't.
    topicPrefixPattern: '^(shelly[a-z0-9]+-[0-9a-f]+)/',
    commands: [
      {
        key: 'switch',
        label: 'Switch (relay)',
        topicTemplate: '{device}/rpc',
        actions: [
          '{"id":1,"src":"loxsuite","method":"Switch.Set","params":{"id":{channel},"on":true}}',
          '{"id":1,"src":"loxsuite","method":"Switch.Set","params":{"id":{channel},"on":false}}',
          '{"id":1,"src":"loxsuite","method":"Switch.Toggle","params":{"id":{channel}}}',
        ],
      },
      {
        key: 'cover',
        label: 'Cover (roller shutter)',
        topicTemplate: '{device}/rpc',
        actions: [
          '{"id":1,"src":"loxsuite","method":"Cover.Open","params":{"id":{channel}}}',
          '{"id":1,"src":"loxsuite","method":"Cover.Close","params":{"id":{channel}}}',
          '{"id":1,"src":"loxsuite","method":"Cover.Stop","params":{"id":{channel}}}',
        ],
      },
      {
        key: 'light',
        label: 'Light (dimmer)',
        topicTemplate: '{device}/rpc',
        actions: [
          '{"id":1,"src":"loxsuite","method":"Light.Set","params":{"id":{channel},"on":true}}',
          '{"id":1,"src":"loxsuite","method":"Light.Set","params":{"id":{channel},"on":false}}',
          '{"id":1,"src":"loxsuite","method":"Light.Set","params":{"id":{channel},"on":true,"brightness":50}}',
        ],
      },
    ],
  },
  // The fully generic Gen1 fallback — deliberately LAST of all (not just last among the Gen1
  // entries): its own topicPrefixPattern (`^shellies/([^/]+)/`) would otherwise greedily claim
  // Gen2/Gen3 simple-mode devices too, whose topics also start with "shellies/" once that prefix
  // is turned on — auto-detection is first-match-wins (see deviceDiscovery.js), so anything this
  // broad has to be checked only once nothing more specific already matched.
  {
    key: 'shelly-gen1',
    label: 'Shelly Gen1 (other/unlisted model)',
    topicPrefixPattern: '^shellies/([^/]+)/',
    commands: [relayCommand(), rollerCommand(), lightCommand(), colorCommand(), whiteCommand()],
  },
];

// "Common data" — read-only telemetry/status topics for the Monitor page, the mirror image of
// CATALOG above (which is write-only, for sending commands). Gen1 only for now: its power/energy/
// position/temperature topics publish a bare number as the payload, exactly what Monitor already
// knows how to track as-is. Gen2/Gen3 publishes the equivalent as one JSON blob per component
// (e.g. the whole switch:0 status object) rather than a flat number per topic, and Monitor has no
// JSON-path extraction to pull a single field like "apower" back out of that — so there's nothing
// useful to list here for Gen2/Gen3 until Monitor gains that. channel: false means the topic is
// device-wide (no channel number in it at all), unlike everything else here which always has one.
//
// Scoped to the models whose power/state topics are confidently documented (the plain relay/
// light family this file already relies on elsewhere) — EM/3EM's own energy-meter topics use a
// different "emeter/N/..." shape this doesn't cover yet, and color/RGBW/Vintage bulbs don't
// commonly expose power/energy the same way relays do, so those are left with just the reference
// entry (or none) rather than guessing at a topic shape that hasn't actually been confirmed.
function relayStateData() {
  return { key: 'relay-state', label: 'Relay state (on/off/overpower)', topicTemplate: 'shellies/{device}/relay/{channel}', channel: true };
}
function relayPowerData() {
  return { key: 'relay-power', label: 'Relay power (W)', topicTemplate: 'shellies/{device}/relay/{channel}/power', channel: true };
}
function relayEnergyData() {
  // Reports in units of 10 Wh, not plain Wh (confirmed against Shelly's own docs) — a well-known
  // quirk of this whole legacy relay/energy family. A dashboard panel's own Value scale (×10)
  // turns the raw reading into real Wh for display.
  return { key: 'relay-energy', label: 'Relay energy (running total, ×10 = Wh)', topicTemplate: 'shellies/{device}/relay/{channel}/energy', channel: true };
}
function temperatureData() {
  return { key: 'temperature', label: 'Device temperature (°C)', topicTemplate: 'shellies/{device}/temperature', channel: false };
}
function rollerStateData() {
  return { key: 'roller-state', label: 'Roller state (open/close/stop)', topicTemplate: 'shellies/{device}/roller/{channel}', channel: true };
}
function rollerPositionData() {
  return { key: 'roller-position', label: 'Roller position (0-100)', topicTemplate: 'shellies/{device}/roller/{channel}/pos', channel: true };
}
function lightPowerData() {
  return { key: 'light-power', label: 'Light/dimmer power (W)', topicTemplate: 'shellies/{device}/light/{channel}/power', channel: true };
}
function lightEnergyData() {
  return { key: 'light-energy', label: 'Light/dimmer energy (running total, ×10 = Wh)', topicTemplate: 'shellies/{device}/light/{channel}/energy', channel: true };
}

const DATA_CATALOG = [
  { key: 'shelly-1', label: 'Shelly 1', dataPoints: [relayStateData(), temperatureData()] },
  { key: 'shelly-1l', label: 'Shelly 1L', dataPoints: [relayStateData(), temperatureData()] },
  { key: 'shelly-1pm', label: 'Shelly 1PM', dataPoints: [relayStateData(), relayPowerData(), relayEnergyData(), temperatureData()] },
  { key: 'shelly-plug-s', label: 'Shelly Plug S', dataPoints: [relayStateData(), relayPowerData(), relayEnergyData(), temperatureData()] },
  { key: 'shelly-plug', label: 'Shelly Plug', dataPoints: [relayStateData(), relayPowerData(), relayEnergyData()] },
  { key: 'shelly-2', label: 'Shelly 2', dataPoints: [relayStateData(), rollerStateData(), rollerPositionData()] },
  { key: 'shelly-25', label: 'Shelly 2.5', dataPoints: [relayStateData(), relayPowerData(), relayEnergyData(), rollerStateData(), rollerPositionData(), temperatureData()] },
  { key: 'shelly-4pro', label: 'Shelly 4Pro', dataPoints: [relayStateData(), temperatureData()] },
  { key: 'shelly-dimmer', label: 'Shelly Dimmer / Dimmer 2', dataPoints: [lightPowerData(), lightEnergyData(), temperatureData()] },
  { key: 'shelly-uni', label: 'Shelly Uni', dataPoints: [relayStateData(), temperatureData()] },
  {
    key: 'shelly-gen1',
    label: 'Shelly Gen1 (other/unlisted model)',
    dataPoints: [relayStateData(), relayPowerData(), relayEnergyData(), rollerStateData(), rollerPositionData(), lightPowerData(), lightEnergyData(), temperatureData()],
  },
];

module.exports = { CATALOG, DATA_CATALOG };
