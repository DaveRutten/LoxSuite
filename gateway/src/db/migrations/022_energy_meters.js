// Energy meters (see energyMeters.js): which Loxone control is the grid meter, the PV meter, the
// Wallbox and (optionally) a home battery, read live over the existing Loxone websocket, sampled
// every minute and rolled up per hour — the measured basis for the house profile, the PV forecast
// correction and the charging planner.
//
// energy_meters   one row per role ('grid' | 'pv' | 'wallbox' | 'battery'). `invert` flips the sign of
//                 a bidirectional meter whose positive direction is export / discharge.
// energy_samples  per-minute snapshot per role: power (kW, + = import/production/charge) and the
//                 meter totals (kWh) — kept 14 days, used for live charts and gap filling.
// energy_hourly   kWh per role per hour (UTC hour start), from total-counter differences, or
//                 imported from the Miniserver's own statistics (source 'loxone'). Role 'house' is
//                 derived: grid import - grid export + pv - wallbox - battery charge + discharge.
//
// Also allows the notification triggers of the Wallbox features (meters, planner, reminders).
const { setNotificationTriggerTypes, BASE_TRIGGER_TYPES } = require('../notificationTriggerCheck');

exports.up = async function up(knex) {
  await knex.schema.createTable('energy_meters', (t) => {
    t.increments('id');
    t.text('role').notNullable().unique();
    t.integer('miniserver_id').unsigned().references('id').inTable('miniservers').onDelete('CASCADE');
    t.text('control_uuid');
    t.integer('invert').notNullable().defaultTo(0);
    t.integer('enabled').notNullable().defaultTo(1);
    t.text('updated_at');
  });
  await knex.schema.createTable('energy_samples', (t) => {
    t.increments('id');
    t.text('ts').notNullable();
    t.text('role').notNullable();
    t.float('power_kw');
    t.float('import_kwh');
    t.float('export_kwh');
    t.index(['role', 'ts'], 'idx_energy_samples_role_ts');
  });
  await knex.schema.createTable('energy_hourly', (t) => {
    t.increments('id');
    t.text('hour').notNullable();
    t.text('role').notNullable();
    t.float('import_kwh');
    t.float('export_kwh');
    t.text('source').notNullable().defaultTo('live');
    t.unique(['role', 'hour'], { indexName: 'uq_energy_hourly_role_hour' });
  });
  await setNotificationTriggerTypes(knex, [...BASE_TRIGGER_TYPES, 'energy_meter_status', 'charging_plan', 'car_reminder']);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('energy_hourly');
  await knex.schema.dropTableIfExists('energy_samples');
  await knex.schema.dropTableIfExists('energy_meters');
};
