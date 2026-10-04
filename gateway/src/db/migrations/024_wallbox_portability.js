// Portability fixes for the Wallbox tables (migration 023) on MySQL/MariaDB and Postgres:
//   - wallbox_settings.key -> setting_key: KEY is a reserved word in MySQL, so plain SQL like
//     "WHERE key = ?" failed there.
//   - push_subscriptions.endpoint_hash (SHA-256 of the endpoint, unique): push endpoints are often
//     longer than MySQL can index, so uniqueness goes through the hash on every backend.
const crypto = require('crypto');

exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('wallbox_settings', 'key')) {
    await knex.schema.alterTable('wallbox_settings', (t) => { t.renameColumn('key', 'setting_key'); });
  }
  if (!(await knex.schema.hasColumn('push_subscriptions', 'endpoint_hash'))) {
    await knex.schema.alterTable('push_subscriptions', (t) => { t.string('endpoint_hash', 64); });
    const rows = await knex('push_subscriptions').select('id', 'endpoint');
    for (const r of rows) {
      await knex('push_subscriptions').where({ id: r.id }).update({ endpoint_hash: crypto.createHash('sha256').update(r.endpoint).digest('hex') });
    }
    await knex.schema.alterTable('push_subscriptions', (t) => { t.unique(['endpoint_hash'], { indexName: 'uq_push_subscriptions_endpoint_hash' }); });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('wallbox_settings', 'setting_key')) {
    await knex.schema.alterTable('wallbox_settings', (t) => { t.renameColumn('setting_key', 'key'); });
  }
};
