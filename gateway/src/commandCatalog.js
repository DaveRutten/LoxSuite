// Reference catalog for "Common commands"/"Common data" — topic templates for well-known MQTT
// device families, used by the interactive command builder (routes/mappings.js,
// mappings-commands.ejs). Every built-in device (Shelly Gen1/Gen2/Gen3, SDR HeatMeister, ...) is
// itself just a .json file under device-templates/ — this module has no hardcoded device list of
// its own any more, it only loads and merges whatever's in that folder (see deviceTemplates.js for
// the file format, {device}/{channel} placeholder substitution, and how an invalid file is skipped
// rather than taking the whole catalog down with it). Your own custom devices live in that same
// folder, right alongside the built-in ones, loaded exactly the same way.
const { loadDeviceTemplates, mergeDeviceTemplates } = require('./deviceTemplates');

const { commandsCatalog: CATALOG, dataCatalog: DATA_CATALOG } = mergeDeviceTemplates([], [], loadDeviceTemplates());

module.exports = { CATALOG, DATA_CATALOG };
