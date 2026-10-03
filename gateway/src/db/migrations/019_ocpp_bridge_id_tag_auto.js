// OCPP bridge: take the ID tag from Loxone when a session is authorized there (migration 018 only
// had one fixed tag per bridge).
//
// ocpp_bridges.id_tag_mode — 'fixed' (always send id_tag, the 0.20.0 behaviour and the default) or
//   'auto': use the tag of an NFC Code Touch read around plug-in (nfc_control_uuid), else the tag
//   mapped to the Loxone user the Wallbox reports for the session (user_tag_map, "User = TAG" per
//   line), else fall back to id_tag. StartTransaction then waits up to auth_wait_s after plug-in
//   for that authorization (its timestamp/meterStart stay those of the plug-in).
// ocpp_bridge_sessions.id_tag / id_tag_source — which tag was sent and where it came from
//   ('fixed' | 'nfc' | 'user' | 'fallback'), shown in the session list.
exports.up = async function up(knex) {
  await knex.schema.alterTable('ocpp_bridges', (t) => {
    t.text('id_tag_mode').notNullable().defaultTo('fixed');
    t.text('nfc_control_uuid');
    t.text('user_tag_map');
    t.integer('auth_wait_s').notNullable().defaultTo(60);
  });
  await knex.schema.alterTable('ocpp_bridge_sessions', (t) => {
    t.text('id_tag');
    t.text('id_tag_source');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('ocpp_bridges', (t) => {
    t.dropColumn('id_tag_mode');
    t.dropColumn('nfc_control_uuid');
    t.dropColumn('user_tag_map');
    t.dropColumn('auth_wait_s');
  });
  await knex.schema.alterTable('ocpp_bridge_sessions', (t) => {
    t.dropColumn('id_tag');
    t.dropColumn('id_tag_source');
  });
};
