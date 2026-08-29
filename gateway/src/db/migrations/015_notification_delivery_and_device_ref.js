// Two small, additive columns behind features that both trace back to the same real
// troubleshooting session — a rule that fired into the Notification Center but never reached
// Telegram, and a hardware notification whose "open source" link could only land on the whole
// Hardware list, not the device that caused it.
//
// notification_rules.last_sent_at / last_error / last_error_at — a per-rule delivery breadcrumb so
//   the admin page can show "last sent 3m ago" or surface a red "last send failed: <reason>"
//   instead of that only ever living in the System log. Written by notifications.js's fireRule on
//   every dispatch (success stamps last_sent_at and clears the error; a channel failure records
//   last_error/last_error_at). All nullable text timestamps (same ISO-string convention as
//   users.last_login_at / disabled_at) — null means "never sent / no error yet".
//
// notification_events.source_ref — the stable device_key of the device a hardware event is about
//   (battery_weak / device_firmware_changed / device_offline), alongside the existing source_id
//   (which for those events is the *Miniserver* id, not the device). Lets notificationSourceLink
//   build /hardware?miniserver_id=<source_id>&device=<source_ref> so clicking the notification
//   scrolls to and highlights that one row. Null for every other event type (and for hardware
//   events recorded before this migration) — the link just falls back to the old behaviour then.
exports.up = async function up(knex) {
  await knex.schema.alterTable('notification_rules', (t) => {
    t.text('last_sent_at');
    t.text('last_error');
    t.text('last_error_at');
  });
  await knex.schema.alterTable('notification_events', (t) => {
    t.text('source_ref');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('notification_rules', (t) => {
    t.dropColumn('last_sent_at');
    t.dropColumn('last_error');
    t.dropColumn('last_error_at');
  });
  await knex.schema.alterTable('notification_events', (t) => {
    t.dropColumn('source_ref');
  });
};
