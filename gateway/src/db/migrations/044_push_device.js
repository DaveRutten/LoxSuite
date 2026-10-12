// push_subscriptions.device_id: an id the browser keeps for itself (localStorage). When a phone
// subscribes again with a new endpoint (an app update, push switched off and on), the old row of the
// same device is removed — before, both stayed and every notification arrived twice.
const { stringOnMysql, addColumnsIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await addColumnsIfMissing(knex, 'push_subscriptions', { device_id: (t) => stringOnMysql(t, knex, 'device_id', 64) });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('push_subscriptions', 'device_id')) await knex.schema.alterTable('push_subscriptions', (t) => t.dropColumn('device_id'));
};
