// Turns a room's structure (from loxoneStructure.js) into a handful of ready-made dashboard panel
// suggestions — grouped by Loxone's own category `type` and control `type` fields, so this works
// for any project's structure rather than anything specific to one installation. Both the bucket
// list and the per-control-type "which state is the interesting one" choices below were checked
// against a real Miniserver's LoxAPP3.json (68 Switches, 19 LightControllerV2s, 13
// PresenceDetectors, 8 WindowMonitors, ... across every control type actually present) rather than
// assumed from documentation alone — e.g. TimedSwitch and CentralJalousie were deliberately left
// out because neither exposes any state that means "here's its current status" in a real export.

// controlType -> the one state that best answers "what is this doing right now", using Loxone's
// own fixed state-name vocabulary for that type (same names in every installation, not a guess at
// this one's naming). A type with no entry here never contributes a value — better to leave a
// control out of a suggestion than to show something misleading.
const PRIMARY_STATE = {
  Switch: 'active',
  Pushbutton: 'active',
  Dimmer: 'position',
  LightControllerV2: 'activeMoodsNum',
  ColorPickerV2: 'color',
  Jalousie: 'position',
  Gate: 'position',
  IRoomControllerV2: 'tempActual',
  InfoOnlyAnalog: 'value',
  Meter: 'actual',
  Wallbox2: 'actual',
  Ventilation: 'speed',
  PresenceDetector: 'active',
  WindowMonitor: 'numOpen',
  Alarm: 'armed',
  AudioZoneV2: 'power',
  MediaClient: 'power',
};

// A control is offered for a bucket if EITHER its own category carries one of categoryTypes
// (Loxone's own lights/shading/indoortemperature/multimedia tags — catches anything a user put in
// that category, regardless of control type) OR its control type is explicitly listed
// (catches the common case where the category itself isn't formally typed, which is most
// categories on a real installation — 84 of 122 on the one this was checked against). Checked in
// this order; a control only ever lands in the first bucket that claims it.
//
// 'Switch'/'Pushbutton' are deliberately NOT in the lighting controlTypes fallback below, even
// though most light switches on a real install are exactly that type — they're also Loxone's
// go-to type for a ventilation "turbo" button, a shading lock flag, a media-triggered scene, or
// any other one-off command, none of which have a categoryType of their own to rule them out (real
// case that shipped wrongly bucketed: "Ventilatie Turbo Vrijgeven", "Rolluik Vergrendeld", "Muziek
// op beweging" — a fan button, a shading flag, and a media trigger, all swept into Lighting purely
// by control type). Since there's no reliable way to tell "this Switch is a light" from "this
// Switch is something else" without an explicit categoryType, these two only ever land here via
// categoryTypes: ['lights'] — an untyped-category light switch is missed rather than another
// control type being wrongly claimed, matching this file's own better-to-omit-than-mislead
// philosophy (see the PRIMARY_STATE comment above). Dimmer/LightControllerV2/ColorPickerV2 stay in
// controlTypes since those three ARE unambiguous — nothing else uses them.
const BUCKETS = [
  {
    key: 'lighting',
    label: 'Lighting',
    panelType: 'value',
    categoryTypes: ['lights'],
    controlTypes: ['Dimmer', 'LightControllerV2', 'ColorPickerV2'],
  },
  {
    key: 'climate',
    label: 'Climate',
    panelType: 'chart',
    categoryTypes: ['indoortemperature'],
    controlTypes: ['IRoomControllerV2'],
  },
  {
    key: 'shading',
    label: 'Shading',
    panelType: 'value',
    categoryTypes: ['shading'],
    controlTypes: ['Jalousie'],
  },
  {
    key: 'security',
    label: 'Access & Security',
    panelType: 'value',
    categoryTypes: [],
    controlTypes: ['PresenceDetector', 'WindowMonitor', 'Gate', 'Alarm'],
  },
  {
    key: 'energy',
    label: 'Energy',
    panelType: 'chart',
    categoryTypes: [],
    controlTypes: ['Meter', 'Wallbox2'],
  },
  {
    key: 'ventilation',
    label: 'Ventilation',
    panelType: 'value',
    categoryTypes: [],
    controlTypes: ['Ventilation'],
  },
  {
    key: 'media',
    label: 'Media',
    panelType: 'value',
    categoryTypes: ['multimedia'],
    controlTypes: ['AudioZoneV2', 'MediaClient', 'CentralAudioZone'],
  },
];

// availableStates is included per item so the "Suggest dashboard" preview can offer a dropdown of
// every state that control has, not just the one auto-picked as the default — the suggestion is a
// starting point, not the only option, per the explicit ask to be able to pick a different
// variable per controller.
function suggestForRoom(room) {
  const buckets = BUCKETS.map((b) => ({ key: b.key, label: b.label, panelType: b.panelType, items: [] }));

  room.categories.forEach((cat) => {
    cat.controls.forEach((control) => {
      const bucketIndex = BUCKETS.findIndex((b) => b.categoryTypes.includes(cat.type) || b.controlTypes.includes(control.type));
      if (bucketIndex === -1 || control.states.length === 0) return;

      const defaultStateName = PRIMARY_STATE[control.type];
      const defaultState = (defaultStateName && control.states.find((s) => s.stateName === defaultStateName)) || control.states[0];

      buckets[bucketIndex].items.push({
        uuid: defaultState.uuid,
        stateName: defaultState.stateName,
        controlName: control.name,
        label: `${control.name} / ${defaultState.stateName}`,
        availableStates: control.states,
      });
    });
  });

  return buckets.filter((b) => b.items.length > 0);
}

// Every bucket a client-submitted item can legally claim to belong to, and the panel type that
// implies — a fixed property of the bucket (Lighting is always a "value" panel, Climate always a
// "chart"), independent of which exact state ended up picked for one of its rows.
const BUCKET_BY_KEY = new Map(BUCKETS.map((b) => [b.key, b]));

module.exports = { suggestForRoom, BUCKET_BY_KEY };
