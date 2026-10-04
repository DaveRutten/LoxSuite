// Vehicles (see vehicles.js): the cars charged at home, with what the planner needs to know about
// each one, plus an optional live data source for the car's own state (state of charge, range,
// plugged in, location...). The source is deliberately generic rather than one integration per car
// brand: 'mqtt' reads topics that something else already publishes on the LoxSuite broker (evcc,
// Home Assistant, Homey via its MQTT app, TeslaMate, an OBD dongle...), 'http' polls any JSON URL,
// 'homey' reads a device from a Homey Pro's local Web API and 'homeassistant' reads entities from
// Home Assistant's REST API (both already have integrations for most car brands; Node-RED and
// similar tools just publish to the broker and use 'mqtt'). Every source is normalised to the same
// fields, so nothing downstream cares where a value came from.
//
// vehicles
//   type            'bev' (full electric) | 'phev' (plug-in hybrid: an empty battery isn't a problem,
//                   it just drives on fuel — reserve defaults to 0 and fuel use matters)
//   battery_kwh     usable capacity; charge_limit_pct = the car's own charge limit (100 = none)
//   reserve_pct     never plan below this; kwh_per_km / fuel_l_per_100km optional (learned later)
//   source_type     'none' | 'mqtt' | 'http' | 'homey' | 'homeassistant'
//   source_config   JSON: field mapping, URL, device id, poll interval
//   secret          HTTP headers / Homey API key / Home Assistant long-lived token, encrypted at
//                   rest via secretCrypto (same as miniservers.password)
//   home_*          how "is the car at home" is decided: within home_radius_m of home_lat/home_lon,
//                   or a location field equal to home_value (e.g. "home")
//   last_reading    last normalised reading (JSON) so the page has something right after a restart
// vehicle_readings  history of the normalised reading (on change, at most every few minutes), the
//                   raw material for learning consumption and departure patterns later.
exports.up = async function up(knex) {
  await knex.schema.createTable('vehicles', (t) => {
    t.increments('id');
    t.text('name').notNullable();
    t.text('type').notNullable().defaultTo('bev');
    t.float('battery_kwh');
    t.integer('charge_limit_pct').notNullable().defaultTo(100);
    t.integer('reserve_pct').notNullable().defaultTo(15);
    t.float('kwh_per_km');
    t.float('fuel_l_per_100km');
    t.integer('enabled').notNullable().defaultTo(1);
    t.text('source_type').notNullable().defaultTo('none');
    t.text('source_config');
    t.text('secret');
    t.float('home_lat');
    t.float('home_lon');
    t.integer('home_radius_m').notNullable().defaultTo(150);
    t.text('home_value');
    t.text('last_reading');
    t.text('last_reading_at');
    t.text('created_at').notNullable();
    t.text('updated_at');
    t.check('?? IN (?, ?)', ['type', 'bev', 'phev'], 'chk_vehicles_type');
    t.check('?? IN (?, ?, ?, ?, ?)', ['source_type', 'none', 'mqtt', 'http', 'homey', 'homeassistant'], 'chk_vehicles_source_type');
  });
  await knex.schema.createTable('vehicle_readings', (t) => {
    t.increments('id');
    t.integer('vehicle_id').unsigned().notNullable().references('id').inTable('vehicles').onDelete('CASCADE');
    t.text('ts').notNullable();
    t.float('soc');
    t.float('range_km');
    t.integer('plugged');
    t.integer('charging');
    t.integer('home');
    t.float('odometer_km');
    t.index(['vehicle_id', 'ts'], 'idx_vehicle_readings_vehicle_ts');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('vehicle_readings');
  await knex.schema.dropTableIfExists('vehicles');
};
