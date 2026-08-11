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

module.exports = { CATALOG, DATA_CATALOG, loadCommandCatalogs };
