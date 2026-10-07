// How you drive to an appointment, and routes past several appointments (agenda.js):
//
// event_overrides.trip_mode    NULL = from the calendar text (#brengen / #halen), else 'stay' (the car
//                              stays there: there at the start, back at the end), 'both' (drop off and
//                              pick up: there and back at the start, and again at the end), 'drop'
//                              (only at the start) or 'pick' (only at the end).
// event_overrides.chain_start  after dropping off at the start: 1 = drive on to the next appointment
//                              with the car instead of going home (NULL/0 = home).
// event_overrides.chain_end    after the appointment (or after picking up at the end): 1 = drive on.
//                              All three also on the series row (start_at '*'), like needs_car.
// calendar_events.trip_tag     the mode the calendar text asks for ('both' | 'drop' | 'pick'), at sync.
const { stringOnMysql, addColumnsIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await addColumnsIfMissing(knex, 'event_overrides', {
    trip_mode: (t) => stringOnMysql(t, knex, 'trip_mode', 8).nullable(),
    chain_start: (t) => t.integer('chain_start').nullable(),
    chain_end: (t) => t.integer('chain_end').nullable(),
  });
  await addColumnsIfMissing(knex, 'calendar_events', { trip_tag: (t) => stringOnMysql(t, knex, 'trip_tag', 8).nullable() });
};

exports.down = async function down(knex) {
  for (const [tbl, col] of [['event_overrides', 'trip_mode'], ['event_overrides', 'chain_start'], ['event_overrides', 'chain_end'], ['calendar_events', 'trip_tag']]) {
    if (await knex.schema.hasColumn(tbl, col)) await knex.schema.alterTable(tbl, (t) => t.dropColumn(col));
  }
};
