// Indexes for the queries that read by time alone (no leading role/kind/source), which until now scanned
// the whole table: the house/solar hours and the consumers' hours since a moment (energy pages, learning),
// the forecast log by target hour (filling in what really happened, the plans written down), and
// clearing old rows from energy_samples and log_entries. Skipped when an index already exists.
const INDEXES = [
  ['energy_hourly', ['hour'], 'idx_energy_hourly_hour'],
  ['load_hourly', ['hour'], 'idx_load_hourly_hour'],
  ['forecast_log', ['target'], 'idx_forecast_log_target'],
  ['energy_samples', ['ts'], 'idx_energy_samples_ts'],
  ['log_entries', ['recorded_at'], 'idx_log_entries_recorded_at'],
];

async function exists(knex, table, name) {
  const client = knex.client.config.client;
  if (/sqlite/.test(client)) return !!(await knex.raw('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?', ['index', name]))[0];
  if (/pg|postgres/.test(client)) return (await knex.raw('SELECT 1 FROM pg_indexes WHERE indexname = ?', [name])).rows.length > 0;
  const [rows] = await knex.raw('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [table, name]);
  return rows.length > 0;
}

exports.up = async function up(knex) {
  for (const [table, cols, name] of INDEXES) {
    if (!(await knex.schema.hasTable(table)) || (await exists(knex, table, name))) continue;
    await knex.schema.alterTable(table, (t) => { t.index(cols, name); });
  }
};

exports.down = async function down(knex) {
  for (const [table, cols, name] of INDEXES) {
    if (!(await knex.schema.hasTable(table)) || !(await exists(knex, table, name))) continue;
    await knex.schema.alterTable(table, (t) => { t.dropIndex(cols, name); });
  }
};
