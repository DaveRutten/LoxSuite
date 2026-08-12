# Device templates

This folder (`gateway/device-templates/`, tracked in git) is where LoxSuite's own **built-in**
device definitions live — it gets baked into every Docker image and isn't the place to add your
own. **For a real deployment, drop your own `.json`/`.xml` file into the bind-mounted
`device-templates/user/` folder next to your `docker-compose.yml`** (not this one) — see that
folder's own README, or the shape below (identical format either way).

One file = one device family. A file whose `key` matches an existing device (built-in, or one
fetched from GitHub via Administration → General → Device templates) replaces that device's
fields; anything else becomes a new entry in the picker. No restart needed to pick up a change —
use the **Reload from disk** button on that same admin page.

An invalid file (malformed JSON/XML, or missing a required field) is skipped with a message in the
gateway's own log naming the file and the problem — it never takes the rest of the catalog down
with it.

`heatmeister.json` and `heatmeister-ha.json` in this same folder are real, working examples (SDR
Innovation's HeatMeister radiator/fan-coil controller, and a Home Assistant MQTT Discovery variant
of the same device) — read one of those for a full, real-world shape, or the shorter reference
below.

## Fields

- `key` *(optional)* — a short, URL/topic-safe id. Derived from `label` if omitted.
- `label` *(required)* — shown in the Device type picker.
- `topicPrefixPattern` *(optional)* — a regex (capture group 1 = the device id) used to
  auto-detect a real device of this type from the broker's own traffic. Only meaningful for
  `commands`.
- `commands` *(optional)* — an array of `{ key, label, topicTemplate, actions }`. `topicTemplate`
  and any string in `actions` may contain `{device}` and/or `{channel}`, substituted from what's
  picked in the UI (either placeholder may appear more than once in the same string).
- `dataPoints` *(optional)* — an array of `{ key, label, topicTemplate, channel }`. Same
  `{device}`/`{channel}` substitution; `channel: false` for a topic with no channel number in it
  at all (device-wide).
- `order` *(optional, default `0`)* — only needed if this device's `topicPrefixPattern` is broad
  enough to also match another device's topics (e.g. a generic "unlisted model" fallback for a
  whole product line). Auto-detection matches every device's pattern against real broker traffic
  first-match-wins, in ascending `order` (ties broken alphabetically by filename) — a higher number
  here means "only claim a device no narrower pattern already has."

At least one of `commands`/`dataPoints` is required.

## JSON example

```json
{
  "key": "my-device",
  "label": "My Device",
  "topicPrefixPattern": "^mydevice/([^/]+)/",
  "commands": [
    { "key": "switch", "label": "Switch", "topicTemplate": "mydevice/{device}/switch/{channel}/set", "actions": ["on", "off", "toggle"] }
  ],
  "dataPoints": [
    { "key": "power", "label": "Power (W)", "topicTemplate": "mydevice/{device}/power/{channel}", "channel": true }
  ]
}
```

## XML example

```xml
<family key="my-device" label="My Device" topicPrefixPattern="^mydevice/([^/]+)/">
  <command key="switch" label="Switch" topicTemplate="mydevice/{device}/switch/{channel}/set">
    <action>on</action>
    <action>off</action>
    <action>toggle</action>
  </command>
  <dataPoint key="power" label="Power (W)" topicTemplate="mydevice/{device}/power/{channel}" channel="true" />
</family>
```

Same shape as the JSON/XML the Mappings → Commands page's own catalog editor already lets you
export/import — a file exported from there drops straight into this folder unchanged.
