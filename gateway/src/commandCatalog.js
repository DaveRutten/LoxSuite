// Reference catalog for "Common commands"/"Common data" — topic templates for well-known MQTT
// device families, used by the interactive command builder (routes/mappings.js,
// mappings-commands.ejs). Every built-in device (Shelly Gen1/Gen2/Gen3, SDR HeatMeister, ...) is
// itself just a .json file under device-templates/ — this module has no hardcoded device list of
// its own any more, it only loads and merges whatever's in that folder (see deviceTemplates.js for
// the file format, {device}/{channel} placeholder substitution, and how an invalid file is skipped
// rather than taking the whole catalog down with it). Your own custom devices live in that same
// folder, right alongside the built-in ones, loaded exactly the same way.
const { loadDeviceTemplates, mergeDeviceTemplates } = require('./deviceTemplates');
const db = require('./db');

const { commandsCatalog: CATALOG, dataCatalog: DATA_CATALOG } = mergeDeviceTemplates([], [], loadDeviceTemplates());

// Re-scans device-templates/ (bundled + synced + user, see deviceTemplates.js) and refreshes
// CATALOG/DATA_CATALOG without a restart — for the admin "Reload from disk"/"Fetch latest
// built-ins from GitHub" actions (routes/admin.js). Mutates the two arrays IN PLACE rather than
// reassigning this module's CATALOG/DATA_CATALOG bindings: deviceDiscovery.js (and anywhere else)
// does `const { CATALOG } = require('./commandCatalog')`, which copies the array reference once at
// require-time — reassigning here would leave those bindings pointing at the old, stale array.
function reloadDeviceTemplates() {
  const merged = mergeDeviceTemplates([], [], loadDeviceTemplates());
  CATALOG.length = 0;
  CATALOG.push(...merged.commandsCatalog);
  DATA_CATALOG.length = 0;
  DATA_CATALOG.push(...merged.dataCatalog);
  // deviceCount: distinct devices total, by key — CATALOG and DATA_CATALOG aren't disjoint (most
  // devices define both commands and data points, under the same key), so adding their lengths
  // would double-count almost everything rather than describe "how many devices got loaded".
  const deviceCount = new Set([...CATALOG, ...DATA_CATALOG].map((f) => f.key)).size;
  return { deviceCount, familyCount: CATALOG.length, dataFamilyCount: DATA_CATALOG.length };
}

// User edits to "Common commands"/"Common data" (see this file's own header comment) replace the
// built-in catalog wholesale once saved (routes/mappings.js's own /commands/catalog) — not merged
// field-by-field — so anywhere that needs "the catalog as it actually stands right now" (the Edit
// UI seeding itself, Client Activity's own "Schedule command" command picker) reads through here
// rather than the hardcoded CATALOG/DATA_CATALOG above directly, which would miss an override.
async function loadCommandCatalogs() {
  const row = await db.prepare('SELECT commands_json, data_json FROM command_catalog_overrides WHERE id = 1').get();
  let catalog = CATALOG;
  let dataCatalog = DATA_CATALOG;
  let isCustomized = false;
  if (row) {
    if (row.commands_json) {
      try { catalog = JSON.parse(row.commands_json); isCustomized = true; } catch (err) { /* corrupt — fall back to built-in */ }
    }
    if (row.data_json) {
      try { dataCatalog = JSON.parse(row.data_json); isCustomized = true; } catch (err) { /* corrupt — fall back to built-in */ }
    }
  }
  return { catalog, dataCatalog, isCustomized };
}

// A customized catalog (see loadCommandCatalogs above) replaces the built-in one wholesale once
// saved — by design, so a hand-edited command isn't clobbered by a future app update. The flip
// side: a brand new built-in family, or a new command/data point added to an existing built-in
// family (like Shelly's Reboot command), never reaches an install that customized ANYTHING here,
// even after updating — there's nothing that ever looks at CATALOG/DATA_CATALOG again once an
// override exists. This adds only what's actually missing (by family key, then by command/data
// point key within an existing family) on top of the customized catalog, so an existing edit —
// including a built-in command the user deliberately removed — is never touched or reintroduced.
function mergeMissingBuiltins(catalog, dataCatalog) {
  const commandsByKey = new Map(catalog.map((f) => [f.key, f]));
  let added = 0;

  CATALOG.forEach((builtinFamily) => {
    const existing = commandsByKey.get(builtinFamily.key);
    if (!existing) {
      commandsByKey.set(builtinFamily.key, JSON.parse(JSON.stringify(builtinFamily)));
      added += builtinFamily.commands.length;
      return;
    }
    const existingKeys = new Set((existing.commands || []).map((c) => c.key));
    builtinFamily.commands.forEach((c) => {
      if (!existingKeys.has(c.key)) {
        existing.commands = existing.commands || [];
        existing.commands.push(JSON.parse(JSON.stringify(c)));
        added += 1;
      }
    });
  });

  const dataByKey = new Map(dataCatalog.map((f) => [f.key, f]));
  DATA_CATALOG.forEach((builtinFamily) => {
    const existing = dataByKey.get(builtinFamily.key);
    if (!existing) {
      dataByKey.set(builtinFamily.key, JSON.parse(JSON.stringify(builtinFamily)));
      added += builtinFamily.dataPoints.length;
      return;
    }
    const existingKeys = new Set((existing.dataPoints || []).map((d) => d.key));
    builtinFamily.dataPoints.forEach((d) => {
      if (!existingKeys.has(d.key)) {
        existing.dataPoints = existing.dataPoints || [];
        existing.dataPoints.push(JSON.parse(JSON.stringify(d)));
        added += 1;
      }
    });
  });

  return { catalog: Array.from(commandsByKey.values()), dataCatalog: Array.from(dataByKey.values()), added };
}

module.exports = { CATALOG, DATA_CATALOG, loadCommandCatalogs, mergeMissingBuiltins, reloadDeviceTemplates };
