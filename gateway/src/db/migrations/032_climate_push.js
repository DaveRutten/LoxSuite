// Climate at departure + choosing where notifications go.
//
// event_overrides.climate_c / trips.climate_c   cabin temperature (°C) the car should have when you
//                                               leave for this appointment/trip; NULL = no climate.
// climate_runs   one row per departure LoxSuite handled (sent, only logged, failed, skipped), so a
//                departure is never sent twice and the agenda can show what happened.
// users.push_on                         this user's subscribed notifications also go to their
//                                       devices as push (the app), next to their own channel.
// notification_rule_subscribers.via     per subscribed rule: 'both' (NULL), 'channel' or 'push'.
// Notification trigger 'car_climate' (started / failed).
//
// Before, "Send my personal notifications as push" replaced the user's channel URL with
// loxsuite-push://user/<id>; those users get push_on = 1 and an empty channel instead.
const { stringOnMysql, createTableIfMissing, addColumnsIfMissing } = require('../migrationHelpers');
const { setNotificationTriggerTypes, BASE_TRIGGER_TYPES } = require('../notificationTriggerCheck');

const TYPES = [...BASE_TRIGGER_TYPES, 'energy_meter_status', 'charging_plan', 'car_reminder'];

exports.up = async function up(knex) {
  await addColumnsIfMissing(knex, 'event_overrides', { climate_c: (t) => t.float('climate_c').nullable() });
  await addColumnsIfMissing(knex, 'trips', { climate_c: (t) => t.float('climate_c').nullable() });
  await createTableIfMissing(knex, 'climate_runs', (t) => {
    t.increments('id');
    stringOnMysql(t, knex, 'item_key', 255).notNullable().unique();
    t.integer('vehicle_id');
    t.text('title');
    t.text('depart_at').notNullable();
    t.float('target_c');
    t.text('status').notNullable(); // sent | logged | failed | skipped | retry | off (switched off for this time)
    t.text('message');
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('next_at');
    t.text('created_at').notNullable();
    t.text('updated_at');
  });
  await addColumnsIfMissing(knex, 'users', { push_on: (t) => t.integer('push_on').notNullable().defaultTo(0) });
  await addColumnsIfMissing(knex, 'notification_rule_subscribers', { via: (t) => stringOnMysql(t, knex, 'via', 16).nullable() });
  const pushUsers = await knex('users').select('id', 'notify_url').where('notify_url', 'like', 'loxsuite-push://%');
  for (const u of pushUsers) await knex('users').where({ id: u.id }).update({ push_on: 1, notify_url: null });
  await setNotificationTriggerTypes(knex, [...TYPES, 'car_climate']);
};

exports.down = async function down(knex) {
  await knex('notification_rules').where({ trigger_type: 'car_climate' }).del();
  await setNotificationTriggerTypes(knex, TYPES);
  await knex.schema.dropTableIfExists('climate_runs');
  for (const [tbl, col] of [['event_overrides', 'climate_c'], ['trips', 'climate_c'], ['users', 'push_on'], ['notification_rule_subscribers', 'via']]) {
    if (await knex.schema.hasColumn(tbl, col)) await knex.schema.alterTable(tbl, (t) => t.dropColumn(col));
  }
};
