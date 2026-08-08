// Shared ground-truth schema dumper — used by schemaParity.test.js to compare the frozen legacy
// SQLite path (db/legacy-sqlite-schema.js) against the new Knex-schema-builder baseline
// (db/migrations/001_baseline.js) structurally, rather than by manually re-reading 45 migration
// functions and hoping the baseline matches (see the project's own db-backend plan for why this
// test exists and had to be written before the baseline, not after).
//
// Operates on a plain, already-open better-sqlite3 connection (synchronous .prepare().all(), same
// API legacy-sqlite-schema.js itself uses) — works identically whether that connection was built
// by running the legacy path directly, or is the raw connection underneath a Knex instance that
// just ran migrate.latest() (see db/index.js's own withRawConnection-style acquireConnection()
// pattern for why that's the right way to get at it).
function dumpSchema(conn) {
  const tables = conn
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('knex_migrations', 'knex_migrations_lock') ORDER BY name")
    .all();

  const schema = {};
  for (const { name } of tables) {
    const rawColumns = conn.prepare(`PRAGMA table_info(${name})`).all();
    // A single-column `INTEGER PRIMARY KEY` is SQLite's rowid alias — reported as notnull=0 by
    // PRAGMA table_info regardless of which of AUTOINCREMENT / a bare `PRIMARY KEY CHECK (id = 1)`
    // singleton-row pattern declared it, even though such a column can in practice never actually
    // hold NULL. Knex's own `.increments()`/`.primary()` builders instead emit an explicit `NOT
    // NULL` alongside it (verified empirically against this exact SQLite dialect), which SQLite
    // then correctly reports as notnull=1 — a real generated-SQL difference, but not a real SCHEMA
    // one, so it's normalized away here rather than fought in the baseline migration itself.
    const singleColumnIntPk = rawColumns.filter((c) => c.pk > 0).length === 1;
    const columns = rawColumns
      .map((c) => ({
        name: c.name,
        type: String(c.type).toLowerCase(),
        notnull: (c.pk === 1 && singleColumnIntPk && String(c.type).toLowerCase() === 'integer') ? 1 : c.notnull,
        dflt: normalizeDefault(c.dflt_value),
        pk: c.pk,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const fks = conn.prepare(`PRAGMA foreign_key_list(${name})`).all()
      .map((fk) => ({ from: fk.from, table: fk.table, to: fk.to, on_delete: fk.on_delete }))
      .sort((a, b) => a.from.localeCompare(b.from));

    const indexes = conn.prepare(`PRAGMA index_list(${name})`).all()
      // Auto-generated names (sqlite_autoindex_*, or whatever Knex's own builder happens to call an
      // FK/unique index) are an implementation detail, not a structural fact worth comparing — two
      // schemas with the same actual columns/uniqueness are equivalent regardless of what SQLite or
      // Knex happened to name the index that enforces it. Only origin 'c' (an explicit CREATE
      // INDEX/table.index() call) and 'u' (a UNIQUE column/constraint) are real, deliberate schema
      // decisions; 'pk' indexes are just PRIMARY KEY's own enforcement, already covered by each
      // column's own `pk` field above.
      .filter((idx) => idx.origin !== 'pk')
      .map((idx) => ({
        unique: idx.unique,
        columns: conn.prepare(`PRAGMA index_info(${idx.name})`).all().map((c) => c.name),
      }))
      .sort((a, b) => a.columns.join(',').localeCompare(b.columns.join(',')));

    schema[name] = { columns, fks, indexes };
  }
  return schema;
}

// SQLite stores a column default exactly as the literal text that followed DEFAULT in the CREATE
// TABLE statement. Hand-written SQL (legacy-sqlite-schema.js) writes a numeric default bare
// (`DEFAULT 0`) but a string one quoted (`DEFAULT 'UTC'`); Knex's own `.defaultTo(...)` builder
// instead quotes EVERY default it emits, numbers included (`default '0'`, verified empirically
// against this exact SQLite dialect) — SQLite's own type affinity coerces a quoted numeric-looking
// default back to a real number for an INTEGER-affinity column either way, so this is a real
// generated-SQL difference but not a real behavioral one. Unquoting a default that's ENTIRELY a
// plain integer/decimal literal once its surrounding quotes are stripped normalizes the two
// spellings to the same value for comparison; a genuine string default (`'UTC'`, `'{}'`,
// `'passthrough'`) never matches that shape and passes through untouched.
function normalizeDefault(value) {
  if (value === undefined || value === null) return null;
  const quotedNumberMatch = /^'(-?\d+(?:\.\d+)?)'$/.exec(value);
  return quotedNumberMatch ? quotedNumberMatch[1] : value;
}

module.exports = { dumpSchema };
