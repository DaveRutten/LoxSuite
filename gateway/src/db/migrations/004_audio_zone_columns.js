// Backs real online status + audio output hardware for Audio zones on the Hardware page
// (loxoneHardware.js) — the Miniserver's /data/status XML this table was originally populated
// from never reports an online state for audio_server/audio_zone rows at all (confirmed in
// loxoneHardware.js's own checkDeviceOffline comment). Both fields instead come from the
// Structure File's AudioZoneV2 control type (details.speakerConfig bitmask — which physical kind
// of output this zone plays through, e.g. "Stereo Extension" vs. the Audioserver's own built-in
// "Audioserver Channel", not which specific unit — see loxoneHardware.js's describeSpeakerConfig)
// and its parent mediaServer entry (name) — a second, independent Loxone data source this table
// never needed columns for before. Both nullable/additive — every other category's rows are
// entirely unaffected.
exports.up = async function up(knex) {
  await knex.schema.alterTable('loxone_hardware_devices', (t) => {
    t.text('zone_of');
    t.text('audio_output');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('loxone_hardware_devices', (t) => {
    t.dropColumn('zone_of');
    t.dropColumn('audio_output');
  });
};
