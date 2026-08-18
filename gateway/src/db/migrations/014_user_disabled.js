// Lets an admin turn a user's access off without deleting their account (dashboards, favorites,
// notification rules, audit trail...) the way /admin/users/:id/delete does. Nullable text
// timestamp (same convention as last_login_at) rather than a boolean so "when" is preserved for
// free — null means active. Enforced both at login (routes/auth.js) and on every subsequent
// request (middleware/loadUserContext.js), the same "never cached in the session" pattern already
// used for role/permission changes, so disabling someone takes effect on their very next request
// instead of waiting for them to log back in.
exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.text('disabled_at');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('disabled_at');
  });
};
