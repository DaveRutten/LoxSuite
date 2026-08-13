// routes/logs.js's queryLogs() filters `WHERE source = ?` and orders `ORDER BY id DESC LIMIT ?` —
// verified as a real, measured slow query (3+ seconds) on a live install: log_entries had grown to
// ~120K rows dominated by one high-volume source ('system', from repeated Loxone poll failures),
// while the tab actually being viewed (e.g. 'loxone_commands') was a tiny fraction of that (111
// rows). The existing idx_log_entries_source_time index is on (source, recorded_at) — no help for
// an `ORDER BY id` query — so the planner fell back to scanning backward by rowid/id, checking
// `source` on every row, which for a rare source in a system-dominated table means walking nearly
// the entire table before LIMIT is satisfied. This index matches the query's actual shape
// (source, id) exactly, so the filter AND the ordering are both satisfied straight from the index.
exports.up = async function up(knex) {
  await knex.schema.alterTable('log_entries', (t) => {
    t.index(['source', 'id'], 'idx_log_entries_source_id_order');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('log_entries', (t) => {
    t.dropIndex(['source', 'id'], 'idx_log_entries_source_id_order');
  });
};
