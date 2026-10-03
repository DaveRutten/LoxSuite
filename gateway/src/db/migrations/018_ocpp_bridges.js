// OCPP bridge (Wallbox -> OCPP 1.6 backend). Exists because Loxone's own OCPP Server Connector only
// works when the Wallbox block and the Charging Point live on the SAME (current-generation)
// Miniserver — a Wallbox wired to a Gen 1 client in a Client/Gateway setup can't be linked to a
// Charging Point on the Gen 2 gateway (the API connector doesn't travel through a memory flag), so
// the Charging Point reports "Wallbox Offline / Selfcheck Failed" forever and no session is ever
// sent. LoxSuite already receives that Wallbox's live states (connected/active/actual/total) over
// the Gen 2's websocket, so ocppBridge.js reads those and acts as an OCPP 1.6 charge point itself.
//
// ocpp_bridges — one row per bridged Wallbox. `password` is the backend's OCPP Basic-auth secret,
//   encrypted at rest via secretCrypto (same convention as miniservers.password). `mode` is 'dry'
//   (log what would be sent, connect to nothing) or 'live'. `state_json` persists the running
//   transaction and the not-yet-sent transaction message queue so a restart loses nothing.
// ocpp_bridge_sessions — one row per charging session the bridge saw, for the UI and for
//   reconciliation (transaction id as assigned by the backend, meter start/stop in Wh) and as the
//   preferred source for the quarterly export (ocppExport.js) — real MID readings, dry or live.
// `serial` / `ean` are optional and only used as identification (BootNotification serial, the
//   export's title row).
exports.up = async function up(knex) {
  await knex.schema.createTable('ocpp_bridges', (t) => {
    t.increments('id');
    t.text('name').notNullable();
    t.integer('miniserver_id').unsigned().notNullable().references('id').inTable('miniservers').onDelete('CASCADE');
    t.text('control_uuid').notNullable();
    t.integer('enabled').notNullable().defaultTo(0);
    t.text('mode').notNullable().defaultTo('dry');
    t.text('server_url').notNullable();
    t.text('charge_point_id').notNullable();
    t.text('password');
    t.text('id_tag').notNullable();
    t.text('serial');
    t.text('ean');
    t.integer('meter_interval_s').notNullable().defaultTo(60);
    t.integer('stop_delay_s').notNullable().defaultTo(90);
    t.text('state_json');
    t.text('created_at').notNullable();
    t.text('updated_at');
    t.check('?? IN (?, ?)', ['mode', 'dry', 'live'], 'chk_ocpp_bridges_mode');
  });
  await knex.schema.createTable('ocpp_bridge_sessions', (t) => {
    t.increments('id');
    t.integer('bridge_id').unsigned().notNullable().references('id').inTable('ocpp_bridges').onDelete('CASCADE');
    t.integer('local_id').notNullable();
    t.integer('transaction_id');
    t.text('mode').notNullable();
    t.text('started_at').notNullable();
    t.text('stopped_at');
    t.integer('meter_start_wh').notNullable();
    t.integer('meter_stop_wh');
    t.float('energy_loxone_kwh');
    t.text('stop_reason');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ocpp_bridge_sessions');
  await knex.schema.dropTableIfExists('ocpp_bridges');
};
