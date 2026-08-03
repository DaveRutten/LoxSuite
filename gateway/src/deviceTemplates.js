// Loads user-supplied "Common commands"/"Common data" device families from a folder on disk (one
// file per device, .json or .xml — see device-templates/README.md for the format), merged on top
// of the built-in CATALOG/DATA_CATALOG in commandCatalog.js at startup. This is a SEPARATE
// mechanism from that page's own DB-backed catalog editor (command_catalog_overrides, see
// routes/mappings.js) — that one is for point-and-click edits made through the web UI and replaces
// the whole catalog wholesale once saved; this one is for a device definition you'd rather hand-
// write, keep in version control, or share with someone else, without touching the UI at all. A
// file's own "key" can also match an existing BUILT-IN device's key on purpose, to override just
// that one instead of adding a new device — same "replace in place" behavior the UI's own JSON/XML
// import already has.
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const TEMPLATES_DIR = process.env.DEVICE_TEMPLATES_PATH || path.join(__dirname, '../device-templates');
// Docker image only (see Dockerfile's `COPY device-templates ./device-templates-defaults` and
// docker-entrypoint.sh's first-boot seeding of the bind-mounted TEMPLATES_DIR from this same
// folder) — doesn't exist at all outside the image (a bare `node src/server.js` checkout has no
// "-defaults" copy, only the tracked device-templates/ folder that TEMPLATES_DIR already points
// at by default). Scanned unconditionally alongside TEMPLATES_DIR below specifically so a
// misconfigured or not-yet-updated bind mount (stale docker-compose.yml/Unraid template missing
// the new volume line, wrong host path, ...) degrades to "the built-ins still work, your own
// customizations just aren't picked up yet" instead of silently emptying the ENTIRE Common
// Commands catalog — every device in it, including every built-in one, used to live only in
// TEMPLATES_DIR once the hardcoded arrays in commandCatalog.js were removed.
const BUNDLED_DEFAULTS_DIR = path.join(__dirname, '../device-templates-defaults');

// parseAttributeValue/parseTagValue both off: this schema uses plain numeric-looking strings all
// over the place (a Shelly brightness command's "0"/"50"/"100", a channel index, ...) that must
// stay strings — the parser's own type-guessing would otherwise silently turn "0" into the number
// 0, breaking a strict-equality check anywhere downstream that expects a string. isArray forces
// command/dataPoint/action to always be arrays even when a family only has exactly one of them —
// without it, a single <command> would parse as a plain object instead of a one-element array.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: 'text',
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (tagName) => tagName === 'command' || tagName === 'dataPoint' || tagName === 'action',
});

function slug(s) {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Same shape a family already has everywhere else in this app (CATALOG/DATA_CATALOG entries, the
// UI's own JSON import) — just read off an already-parsed plain object, whether that object came
// from JSON.parse or the XML parser below.
function normalizeFamily(raw, sourceLabel) {
  if (!raw || typeof raw !== 'object') throw new Error('not an object');
  const label = raw.label || raw.key;
  if (!label) throw new Error('missing "label" (and "key")');
  const key = raw.key || slug(label);
  if (!key) throw new Error('"label" produced an empty key — set "key" explicitly');

  const family = { key, label };
  if (raw.topicPrefixPattern) family.topicPrefixPattern = raw.topicPrefixPattern;
  // Opt-in flag (see shelly-rgbw2.json/shelly-bulb.json's own families) — lets the Suggest
  // Commands page (mappings-commands.ejs) offer its "Create RGB + White mappings" button only for
  // a family that actually has a meaningful Shelly RGBW/White transform to wire up to, rather than
  // showing it (uselessly) for every device type.
  if (raw.supportsShellyRgbw === true || raw.supportsShellyRgbw === 'true') family.supportsShellyRgbw = true;
  // Auto-detection (deviceDiscovery.js) matches every family's topicPrefixPattern against real
  // broker traffic, first-match-wins BY ARRAY ORDER — so a broad, catch-all pattern (e.g. Shelly
  // Gen1's own generic "other/unlisted model" fallback, ^shellies/([^/]+)/, which would otherwise
  // greedily also match Gen2/Gen3's simpler command shape) has to load and sort AFTER every
  // narrower one. Default 0 sorts before any positive value; only a catch-all fallback like that
  // should ever need to set this to something higher.
  family.order = Number(raw.order) || 0;

  const rawCommands = Array.isArray(raw.commands) ? raw.commands : (Array.isArray(raw.command) ? raw.command : null);
  if (rawCommands && rawCommands.length) {
    family.commands = rawCommands.map((c, i) => {
      if (!c || !c.topicTemplate) throw new Error(`command #${i + 1} is missing "topicTemplate"`);
      const rawActions = Array.isArray(c.actions) ? c.actions : (Array.isArray(c.action) ? c.action : []);
      return { key: c.key || slug(c.label) || `command-${i + 1}`, label: c.label || c.key || `Command ${i + 1}`, topicTemplate: c.topicTemplate, actions: rawActions.map(String) };
    });
  }

  const rawDataPoints = Array.isArray(raw.dataPoints) ? raw.dataPoints : (Array.isArray(raw.dataPoint) ? raw.dataPoint : null);
  if (rawDataPoints && rawDataPoints.length) {
    family.dataPoints = rawDataPoints.map((d, i) => {
      if (!d || !d.topicTemplate) throw new Error(`dataPoint #${i + 1} is missing "topicTemplate"`);
      return { key: d.key || slug(d.label) || `data-${i + 1}`, label: d.label || d.key || `Data point ${i + 1}`, topicTemplate: d.topicTemplate, channel: d.channel !== false && d.channel !== 'false' };
    });
  }

  if (!family.commands && !family.dataPoints) throw new Error('has neither "commands" nor "dataPoints" — nothing to load');
  return family;
}

// One JSON/XML file can hold a single family object OR an array of them (same rule the UI's own
// import already follows) — everything else in the folder (a stray README, a .bak file, ...) is
// silently ignored rather than warned about, since only .json/.xml are ever treated as templates.
function parseTemplateFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, 'utf8');

  let parsed;
  if (ext === '.json') {
    parsed = JSON.parse(raw);
  } else if (ext === '.xml') {
    const doc = xmlParser.parse(raw);
    if (!doc.family) throw new Error('no <family> root element found');
    parsed = doc.family;
  } else {
    return null; // not a recognized extension — not this loader's concern
  }

  const families = Array.isArray(parsed) ? parsed : [parsed];
  return families.map((f) => normalizeFamily(f, path.basename(filePath)));
}

// Scans one directory once (see commandCatalog.js — this only ever runs at module load, i.e. at
// gateway startup; a file dropped in or edited afterward needs a restart to be picked up, same as
// every other piece of static config this app reads once at boot). A malformed or invalid file is
// logged and skipped — one bad file must never take the whole Common Commands catalog down with
// it, built-in devices included. Returns [] without a word if the directory itself doesn't exist —
// completely normal for BUNDLED_DEFAULTS_DIR outside Docker, and for TEMPLATES_DIR the very first
// time (before the entrypoint's seeding step, or a bare checkout that never created it).
function scanDir(dir, sourceLabel) {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir).filter((f) => ['.json', '.xml'].includes(path.extname(f).toLowerCase())).sort();
  const families = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    try {
      const parsed = parseTemplateFile(filePath);
      if (parsed) {
        families.push(...parsed);
        console.log(`Device templates: loaded "${entry}" from ${sourceLabel} (${parsed.map((f) => f.key).join(', ')}).`);
      }
    } catch (err) {
      console.error(`Device templates: skipping "${entry}" (${sourceLabel}) — ${err.message}`);
    }
  }
  return families;
}

function loadDeviceTemplates() {
  // Bundled defaults load FIRST — a baseline that's always there inside the Docker image, immune
  // to a stale/missing/misconfigured bind mount at TEMPLATES_DIR (an out-of-date docker-compose.yml
  // or Unraid template still pointing nowhere, a typo'd host path, ...). TEMPLATES_DIR loads SECOND
  // so a file there with the same key — including a deliberately edited copy of a built-in — wins
  // (mergeDeviceTemplates below is last-one-wins by key), while a TEMPLATES_DIR that doesn't exist
  // or resolve correctly just means "no customizations yet," not "no devices at all."
  const families = [...scanDir(BUNDLED_DEFAULTS_DIR, 'bundled defaults'), ...scanDir(TEMPLATES_DIR, 'device-templates')];
  // Stable sort (V8's Array#sort is stable) — same-order families keep the load order they were
  // already in; only a family that explicitly set a non-zero "order" moves relative to that. See
  // normalizeFamily's own comment on why this has to be a thing at all.
  return families.sort((a, b) => a.order - b.order);
}

// Merges loaded families on top of the built-in arrays, by key — a family providing "commands"
// replaces that key's entry in commandsCatalog wholesale (own topicPrefixPattern included, if
// given; otherwise keeps the built-in one's, if any, rather than losing auto-detection for an
// override that only meant to add a data point); same independently for "dataPoints" in
// dataCatalog. A brand new key is just appended to both, same either way.
function mergeDeviceTemplates(commandsCatalog, dataCatalog, families) {
  const commandsByKey = new Map(commandsCatalog.map((f) => [f.key, f]));
  const dataByKey = new Map(dataCatalog.map((f) => [f.key, f]));

  for (const family of families) {
    if (family.commands) {
      const existing = commandsByKey.get(family.key);
      commandsByKey.set(family.key, {
        key: family.key,
        label: family.label,
        topicPrefixPattern: family.topicPrefixPattern || (existing && existing.topicPrefixPattern),
        commands: family.commands,
        supportsShellyRgbw: family.supportsShellyRgbw || (existing && existing.supportsShellyRgbw) || false,
      });
    }
    if (family.dataPoints) {
      dataByKey.set(family.key, { key: family.key, label: family.label, dataPoints: family.dataPoints });
    }
  }

  return { commandsCatalog: Array.from(commandsByKey.values()), dataCatalog: Array.from(dataByKey.values()) };
}

module.exports = { TEMPLATES_DIR, loadDeviceTemplates, mergeDeviceTemplates, normalizeFamily };
