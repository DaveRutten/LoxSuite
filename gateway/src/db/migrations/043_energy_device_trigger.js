// Notification trigger 'energy_device': the heat pump and solar panels of the energy manager
// (legionella overdue, tank expected too cold, a fault code, defrosting that doesn't end, the solar
// limit on for hours, LoxSuite's heartbeat to Loxone failing).
const { setNotificationTriggerTypes, BASE_TRIGGER_TYPES } = require('../notificationTriggerCheck');

const TYPES = [...BASE_TRIGGER_TYPES, 'energy_meter_status', 'charging_plan', 'car_reminder', 'car_climate'];

exports.up = async function up(knex) {
  await setNotificationTriggerTypes(knex, [...TYPES, 'energy_device']);
};

exports.down = async function down(knex) {
  await knex('notification_rules').where({ trigger_type: 'energy_device' }).del();
  await setNotificationTriggerTypes(knex, TYPES);
};
