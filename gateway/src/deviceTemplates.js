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

// Scans TEMPLATES_DIR once (see commandCatalog.js — this only ever runs at module load, i.e. at
// gateway startup; a file dropped in or edited afterward needs a restart to be picked up, same as
// every other piece of static config this app reads once at boot). A malformed or invalid file is
// logged and skipped — one bad file must never take the whole Common Commands catalog down with
// it, built-in devices included.
function loadDeviceTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];

  const entries = fs.readdirSync(TEMPLATES_DIR).filter((f) => ['.json', '.xml'].includes(path.extname(f).toLowerCase())).sort();
  const families = [];
  for (const entry of entries) {
    const filePath = path.join(TEMPLATES_DIR, entry);
    try {
      const parsed = parseTemplateFile(filePath);
      if (parsed) {
        families.push(...parsed);
        console.log(`Device templates: loaded "${entry}" (${parsed.map((f) => f.key).join(', ')}).`);
      }
    } catch (err) {
      console.error(`Device templates: skipping "${entry}" — ${err.message}`);
    }
  }
  // Stable sort (V8's Array#sort is stable) — same-order families keep the alphabetical-by-file
  // order they were already loaded in; only a family that explicitly set a non-zero "order" moves
  // relative to that. See normalizeFamily's own comment on why this has to be a thing at all.
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
      });
    }
    if (family.dataPoints) {
      dataByKey.set(family.key, { key: family.key, label: family.label, dataPoints: family.dataPoints });
    }
  }

  return { commandsCatalog: Array.from(commandsByKey.values()), dataCatalog: Array.from(dataByKey.values()) };
}

module.exports = { TEMPLATES_DIR, loadDeviceTemplates, mergeDeviceTemplates, normalizeFamily };
