// Central, validated configuration. Fails fast with a readable message
// instead of a confusing connection error later.
require("dotenv").config();

function int(name, def, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  }
  return n;
}

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url || !url.trim()) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and put your Supabase connection string in it."
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "DATABASE_URL is not a valid URL. If your password contains special characters (@ # / :), URL-encode them (e.g. @ -> %40)."
    );
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error("DATABASE_URL must start with postgresql://");
  }
  return url;
}

function tableName() {
  const name = process.env.TRANSACTIONS_TABLE || "transactions";
  // interpolated into SQL, so only allow plain identifiers
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`TRANSACTIONS_TABLE must match [a-z_][a-z0-9_]* (got "${name}")`);
  }
  return name;
}

const url = databaseUrl();
const isLocal = /@(localhost|127\.0\.0\.1)/.test(url);

module.exports = {
  databaseUrl: url,
  tableName: tableName(), // overridden by tests so they never touch real data
  port: int("PORT", 8000, { min: 1 }),
  useSsl: process.env.DATABASE_SSL ? process.env.DATABASE_SSL === "true" : !isLocal,
  poolSize: int("DB_POOL_SIZE", 20, { min: 1 }),

  processingDelaySeconds: int("PROCESSING_DELAY_SECONDS", 30),
  pollIntervalMs: int("POLL_INTERVAL_MS", 1000, { min: 10 }),
  batchSize: int("BATCH_SIZE", 50, { min: 1 }),
  lockTimeoutSeconds: int("LOCK_TIMEOUT_SECONDS", 120, { min: 1 }),

  // Retry policy: attempt N failing schedules the next try after base * 2^(N-1) seconds.
  maxAttempts: int("MAX_ATTEMPTS", 5, { min: 1 }),
  retryBaseSeconds: int("RETRY_BASE_SECONDS", 5),

  // Same transaction_id + different payload => 409 (set to "false" to silently ignore instead).
  rejectConflictingDuplicates: process.env.REJECT_CONFLICTING_DUPLICATES !== "false",
};
