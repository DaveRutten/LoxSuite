// Small helpers for migrations that must work on SQLite, Postgres and MySQL/MariaDB alike.
//
// stringOnMysql: TEXT everywhere, but VARCHAR(255) on MySQL for columns that are part of an index,
// UNIQUE or PRIMARY KEY — MySQL can't index TEXT without a prefix length, and knex's text() there
// becomes a type too long for an index key (ER_TOO_LONG_KEY). Same convention as 001_baseline.js.
//
// createTableIfMissing: MySQL commits every DDL statement on its own, so a migration that failed
// halfway leaves its first tables behind; re-running it then fails on "table exists". Skipping
// tables that already exist makes such a migration safe to retry.
function stringOnMysql(t, knex, col, length = 255) {
  return knex.client.config.client === 'mysql2' ? t.string(col, length) : t.text(col);
}

async function createTableIfMissing(knex, name, build) {
  if (await knex.schema.hasTable(name)) return false;
  await knex.schema.createTable(name, build);
  return true;
}

async function addColumnsIfMissing(knex, table, columns) {
  // columns: { name: (t) => t.text('name') ... }
  for (const [name, add] of Object.entries(columns)) {
    if (await knex.schema.hasColumn(table, name)) continue;
    await knex.schema.alterTable(table, (t) => { add(t); });
  }
}

module.exports = { stringOnMysql, createTableIfMissing, addColumnsIfMissing };
