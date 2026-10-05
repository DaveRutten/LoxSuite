// Languages (i18n.js): which languages this installation offers, the default for users who didn't
// choose one, translations made by users (on top of the ones shipped in src/locales/*.json), and the
// language each user chose.
//
// languages      code ('nl', 'de', ...), name, enabled, is_default. English is the base language.
// translations   per language and English source text (msg_key; key_hash = sha1 of it, for a
//                unique index MySQL accepts), the translation, who and when.
// users.language the user's own choice (NULL = the installation default).
const { stringOnMysql, createTableIfMissing, addColumnsIfMissing } = require('../migrationHelpers');

exports.up = async function up(knex) {
  await createTableIfMissing(knex, 'languages', (t) => {
    stringOnMysql(t, knex, 'code', 16).primary();
    t.text('name').notNullable();
    t.integer('enabled').notNullable().defaultTo(1);
    t.integer('is_default').notNullable().defaultTo(0);
    t.text('created_at');
  });
  await createTableIfMissing(knex, 'translations', (t) => {
    t.increments('id');
    stringOnMysql(t, knex, 'lang', 16).notNullable();
    stringOnMysql(t, knex, 'key_hash', 64).notNullable();
    t.text('msg_key').notNullable();
    t.text('text').notNullable();
    t.text('updated_by');
    t.text('updated_at');
    t.unique(['lang', 'key_hash'], { indexName: 'uq_translations_lang_key' });
  });
  await addColumnsIfMissing(knex, 'users', { language: (t) => stringOnMysql(t, knex, 'language', 16).nullable() });
  if (!(await knex('languages').first())) {
    const now = new Date().toISOString();
    await knex('languages').insert([
      { code: 'en', name: 'English', enabled: 1, is_default: 1, created_at: now },
      { code: 'nl', name: 'Nederlands', enabled: 1, is_default: 0, created_at: now },
    ]);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('translations');
  await knex.schema.dropTableIfExists('languages');
  if (await knex.schema.hasColumn('users', 'language')) await knex.schema.alterTable('users', (t) => t.dropColumn('language'));
};
