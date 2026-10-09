// v0.54.1: a route without a ferry / toll roads / motorways is now asked from Valhalla — the public OSRM
// servers refuse "exclude", so v0.54.0 cached the plain route for those (same distance). Forget them;
// they are looked up again (in the background, or when the agenda asks).
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('geo_cache')) await knex('geo_cache').where('query', 'like', '%|x:%').del();
};
exports.down = async function down() {};
