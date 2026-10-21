const { Pool } = require("pg");
const config = require("./config");

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.poolSize,
  idleTimeoutMillis: 0, // keep connections open; reconnecting to a remote DB is slow
  ssl: config.useSsl ? { rejectUnauthorized: false } : false,
});

// Idle clients can emit errors (e.g. DB restarts); without a handler the process would crash.
pool.on("error", (err) => console.error("idle pg client error", err.message));

const T = config.tableName;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${T} (
    transaction_id      TEXT PRIMARY KEY,
    source_account      TEXT NOT NULL,
    destination_account TEXT NOT NULL,
    amount              NUMERIC(18, 2) NOT NULL,
    currency            TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'PROCESSING',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    process_after       TIMESTAMPTZ NOT NULL,
    processed_at        TIMESTAMPTZ,
    locked_at           TIMESTAMPTZ
);
-- Added later: safe to run on an existing table
ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_${T}_due
    ON ${T} (process_after) WHERE status = 'PROCESSING';
`;

async function init() {
  await pool.query(SCHEMA);
  // Warm the pool so the first webhooks don't pay connection setup cost.
  const warm = Math.min(config.poolSize, 10);
  await Promise.all(Array.from({ length: warm }, () => pool.query("SELECT 1")));
}

module.exports = { pool, init };
