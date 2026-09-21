// Geo-blocking (Administration > Security): block, or allow only, visitors by country — looked up
// from their IP against a local MaxMind GeoLite2-Country database (see geoBlock.js). Extends
// gateway_settings directly rather than a new table, same convention as 016_heartbeat_settings.js
// for a small, single-owner group of related fields.
//
// geo_block_mode — 'off' (default), 'blocklist', or 'allowlist'. Not CHECK-constrained (kept as a
//   plain column, validated in the route handler instead) — see migrateLoxoneToMqttTransport-era
//   history in this same schema for why a CHECK enum here would just mean another full-table
//   rebuild the next time a mode is added, across three different backends' own ALTER syntax.
// geo_block_countries — JSON array of ISO 3166-1 alpha-2 codes (e.g. ["NL","BE"]), interpreted
//   according to geo_block_mode.
// geo_block_maxmind_account_id / geo_block_maxmind_license_key — MaxMind account credentials
//   needed to download GeoLite2 (free, but requires a free account); the license key is encrypted
//   at rest the same way Miniserver passwords/the MQTT broker password/the SSO client secret are
//   (see secretCrypto.js).
// geo_block_db_updated_at / geo_block_db_status / geo_block_db_error — last database refresh
//   outcome, shown on Administration > Security so "is this actually working" isn't a guess.
exports.up = async function up(knex) {
  await knex.schema.alterTable('gateway_settings', (t) => {
    t.text('geo_block_mode').notNullable().defaultTo('off');
    t.text('geo_block_countries').notNullable().defaultTo('[]');
    t.text('geo_block_maxmind_account_id');
    t.text('geo_block_maxmind_license_key');
    t.text('geo_block_db_updated_at');
    t.text('geo_block_db_status');
    t.text('geo_block_db_error');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('gateway_settings', (t) => {
    t.dropColumn('geo_block_mode');
    t.dropColumn('geo_block_countries');
    t.dropColumn('geo_block_maxmind_account_id');
    t.dropColumn('geo_block_maxmind_license_key');
    t.dropColumn('geo_block_db_updated_at');
    t.dropColumn('geo_block_db_status');
    t.dropColumn('geo_block_db_error');
  });
};
