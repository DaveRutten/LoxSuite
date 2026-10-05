// Calendars over CalDAV (iCloud, Nextcloud, Fastmail, ...) next to plain ICS links: for calendars that
// have no private ICS address — iCloud only offers a public one. LoxSuite signs in with an
// app-specific password (stored encrypted) and reads the events itself.
//
// calendars.kind      'ics' (default, url = the ICS address) or 'caldav' (url = the calendar collection)
// calendars.username  CalDAV sign-in name (Apple ID e-mail for iCloud)
// calendars.secret    the (app-specific) password, encrypted with secretCrypto
const { addColumnsIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await addColumnsIfMissing(knex, 'calendars', {
    kind: (t) => t.text('kind'),
    username: (t) => t.text('username'),
    secret: (t) => t.text('secret'),
  });
};

exports.down = async function down(knex) {
  for (const col of ['kind', 'username', 'secret']) {
    if (await knex.schema.hasColumn('calendars', col)) await knex.schema.alterTable('calendars', (t) => t.dropColumn(col));
  }
};
