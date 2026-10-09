// Route options (v0.54): geo_cache.route_flags = what the looked-up road route uses ('ferry', 'toll',
// 'motorway', comma separated; NULL = none of them), so the agenda can offer "without the ferry" /
// "without toll roads" only where it matters. A route looked up while avoiding some of them is cached
// under its own key (…|x:ferry,toll).
const { addColumnsIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await addColumnsIfMissing(knex, 'geo_cache', { route_flags: (t) => t.string('route_flags', 64).nullable() });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('geo_cache', 'route_flags')) await knex.schema.alterTable('geo_cache', (t) => t.dropColumn('route_flags'));
};
