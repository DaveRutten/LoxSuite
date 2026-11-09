// Notification triggers 'energy_config' (how the heat pump module is set up and how good its data is:
// power not linked, a linked object without a value, implausible COP, data gaps, the advice having
// nothing to compare with, settings that differ from what happens — energyChecks.js) and 'system_check'
// (LoxSuite itself: down time, disk, live connections, quiet MQTT topics, the Loxone program saved,
// security — systemChecks.js).
const { setNotificationTriggerTypes, BASE_TRIGGER_TYPES } = require('../notificationTriggerCheck');

const TYPES = [...BASE_TRIGGER_TYPES, 'energy_meter_status', 'charging_plan', 'car_reminder', 'car_climate', 'energy_device'];

exports.up = async function up(knex) {
  await setNotificationTriggerTypes(knex, [...TYPES, 'energy_config', 'system_check']);
};

exports.down = async function down(knex) {
  await knex('notification_rules').whereIn('trigger_type', ['energy_config', 'system_check']).del();
  await setNotificationTriggerTypes(knex, TYPES);
};
