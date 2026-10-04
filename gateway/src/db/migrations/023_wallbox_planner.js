// Smart charging and everything around it (planner.js, prices.js, solarForecast.js, learning.js,
// agenda.js, webPush.js — Wallbox menu):
//
// wallbox_settings   key/value (JSON text) for the Wallbox features: site location, price source
//                    and tariff, solar array, planner settings and runtime state, fuel price, agenda
//                    options, web-push keys (secrets inside are encrypted by the code that writes them).
// energy_prices      price per interval (start_at/end_at UTC): market price and the all-in price the
//                    planner uses; one row per interval start.
// solar_forecast     per UTC hour: latest raw forecast (kWh from irradiance x array), the first
//                    day-ahead forecast seen for that hour (for judging the forecast afterwards) and
//                    the corrected forecast after the learned per-hour factor.
// calendars          ICS calendars (URL encrypted), optionally tied to a vehicle.
// calendar_events    synced events of those calendars (expanded occurrences), with car detection.
// event_overrides    the user's choice per event occurrence: car needed yes/no, own kWh/km/"full".
// trips              trips planned in LoxSuite itself (one-off or weekly).
// geo_cache          address -> coordinates and driving distance/time from home.
// push_subscriptions browsers/phones that receive LoxSuite web-push notifications.
// charging_sessions  every Wallbox session (plug-in/unplug/kWh) kept beyond the Wallbox's own log of
//                    ~100, the raw material for learning departures and consumption per trip.
// vehicles           + identification (NFC tags, Loxone users) and whether its sessions go to OCPP.
// ocpp_bridge_sessions + vehicle_id: which car a session belonged to.
exports.up = async function up(knex) {
  await knex.schema.createTable('wallbox_settings', (t) => {
    t.text('key').primary();
    t.text('value');
    t.text('updated_at');
  });
  await knex.schema.createTable('energy_prices', (t) => {
    t.increments('id');
    t.text('start_at').notNullable().unique();
    t.text('end_at').notNullable();
    t.float('market_eur_kwh');
    t.float('allin_eur_kwh');
    t.text('source').notNullable();
    t.text('fetched_at');
  });
  await knex.schema.createTable('solar_forecast', (t) => {
    t.increments('id');
    t.text('hour').notNullable().unique();
    t.float('raw_kwh');
    t.float('dayahead_raw_kwh');
    t.float('corrected_kwh');
    t.text('made_at');
  });
  await knex.schema.createTable('calendars', (t) => {
    t.increments('id');
    t.text('name').notNullable();
    t.text('url').notNullable();
    t.text('color');
    t.integer('vehicle_id').unsigned().references('id').inTable('vehicles').onDelete('SET NULL');
    t.integer('enabled').notNullable().defaultTo(1);
    t.text('last_sync_at');
    t.text('last_error');
    t.text('created_at').notNullable();
  });
  await knex.schema.createTable('calendar_events', (t) => {
    t.increments('id');
    t.integer('calendar_id').unsigned().notNullable().references('id').inTable('calendars').onDelete('CASCADE');
    t.text('uid').notNullable();
    t.text('start_at').notNullable();
    t.text('end_at');
    t.integer('all_day').notNullable().defaultTo(0);
    t.text('title');
    t.text('location');
    t.integer('car_tag').notNullable().defaultTo(0);
    t.text('car_hint');
    t.unique(['calendar_id', 'uid', 'start_at'], { indexName: 'uq_calendar_events_occurrence' });
    t.index(['start_at'], 'idx_calendar_events_start');
  });
  await knex.schema.createTable('event_overrides', (t) => {
    t.increments('id');
    t.integer('calendar_id').unsigned().notNullable().references('id').inTable('calendars').onDelete('CASCADE');
    t.text('uid').notNullable();
    t.text('start_at').notNullable();
    t.integer('needs_car');
    t.integer('vehicle_id');
    t.text('own_value');
    t.unique(['calendar_id', 'uid', 'start_at'], { indexName: 'uq_event_overrides_occurrence' });
  });
  await knex.schema.createTable('trips', (t) => {
    t.increments('id');
    t.integer('vehicle_id').unsigned().references('id').inTable('vehicles').onDelete('CASCADE');
    t.text('title').notNullable();
    t.text('depart_at').notNullable();
    t.text('return_at');
    t.text('location');
    t.text('own_value');
    t.integer('weekly').notNullable().defaultTo(0);
    t.text('created_at').notNullable();
  });
  await knex.schema.createTable('geo_cache', (t) => {
    t.increments('id');
    t.text('query').notNullable().unique();
    t.float('lat');
    t.float('lon');
    t.float('distance_km');
    t.float('duration_min');
    t.text('error');
    t.text('fetched_at');
  });
  await knex.schema.createTable('push_subscriptions', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().references('id').inTable('users').onDelete('CASCADE');
    t.text('endpoint').notNullable().unique();
    t.text('keys_json').notNullable();
    t.text('user_agent');
    t.text('created_at').notNullable();
    t.text('last_error');
  });
  await knex.schema.createTable('charging_sessions', (t) => {
    t.increments('id');
    t.text('connect_at').notNullable().unique();
    t.text('disconnect_at');
    t.float('kwh');
    t.integer('vehicle_id');
    t.text('id_tag');
    t.text('loxone_user');
    t.text('source').notNullable().defaultTo('loxone');
  });
  await knex.schema.alterTable('vehicles', (t) => {
    t.text('id_tags');
    t.text('loxone_users');
    t.integer('ocpp_report').notNullable().defaultTo(1);
  });
  await knex.schema.alterTable('ocpp_bridge_sessions', (t) => {
    t.integer('vehicle_id');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('ocpp_bridge_sessions', (t) => { t.dropColumn('vehicle_id'); });
  await knex.schema.alterTable('vehicles', (t) => { t.dropColumn('id_tags'); t.dropColumn('loxone_users'); t.dropColumn('ocpp_report'); });
  for (const tbl of ['charging_sessions', 'push_subscriptions', 'geo_cache', 'trips', 'event_overrides', 'calendar_events', 'calendars', 'solar_forecast', 'energy_prices', 'wallbox_settings']) {
    await knex.schema.dropTableIfExists(tbl);
  }
};
