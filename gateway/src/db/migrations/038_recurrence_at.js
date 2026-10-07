// A repeating appointment moved to another day (reported: a Tuesday series with some weeks on another
// day): calendar_events.recurrence_at = the occurrence's original start (its RECURRENCE-ID), so what
// you chose for that one day stays with it when it moves. Equal to start_at for an occurrence that
// wasn't moved, NULL for a single appointment.
const { stringOnMysql, addColumnsIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await addColumnsIfMissing(knex, 'calendar_events', { recurrence_at: (t) => stringOnMysql(t, knex, 'recurrence_at', 32).nullable() });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('calendar_events', 'recurrence_at')) await knex.schema.alterTable('calendar_events', (t) => t.dropColumn('recurrence_at'));
};
