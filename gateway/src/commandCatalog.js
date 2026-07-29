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
const CATALOG = [
  {
    key: 'shelly-gen1',
    label: 'Shelly Gen1',
    topicPrefixPattern: '^shellies/([^/]+)/',
    commands: [
      {
        key: 'relay',
        label: 'Relay switch',
        topicTemplate: 'shellies/{device}/relay/{channel}/command',
        actions: ['on', 'off', 'toggle'],
      },
      {
        key: 'roller',
        label: 'Roller shutter',
        topicTemplate: 'shellies/{device}/roller/{channel}/command',
        actions: ['open', 'close', 'stop'],
      },
      {
        key: 'light',
        label: 'Light (dimmer/bulb)',
        topicTemplate: 'shellies/{device}/light/{channel}/command',
        actions: ['on', 'off', 'toggle'],
      },
    ],
  },
];

module.exports = { CATALOG };
