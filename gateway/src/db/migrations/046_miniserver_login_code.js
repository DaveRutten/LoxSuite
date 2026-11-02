// The Loxone login code (Multi-Factor Authentication, Loxone Config 17.3): a user with it on gets no token from the
// password alone, the Miniserver mails a 6-digit code first. Logging in again with the password on every reconnect
// would mail a new code each time, so once the code was given the live connection keeps the token it got
// (encrypted, like the password) and logs in with that; refreshjwt keeps it valid, no code needed.
//   live_token             encrypted JSON { token, hashAlg }, only for a Miniserver that asked for the code
//   live_token_valid_until ISO time the token stops working (refreshed before then)
//   live_needs_code        1 once this Miniserver asked for the code: without a token, LoxSuite then waits for
//                          "Send login code" instead of logging in (and mailing) by itself
const { addColumnsIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await addColumnsIfMissing(knex, 'miniservers', {
    live_token: (t) => t.text('live_token'),
    live_token_valid_until: (t) => t.text('live_token_valid_until'),
    live_needs_code: (t) => t.integer('live_needs_code').notNullable().defaultTo(0),
  });
};

exports.down = async function down(knex) {
  for (const col of ['live_token', 'live_token_valid_until', 'live_needs_code']) {
    if (await knex.schema.hasColumn('miniservers', col)) await knex.schema.alterTable('miniservers', (t) => t.dropColumn(col));
  }
};
