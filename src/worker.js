const { pool } = require("./db");
const config = require("./config");
const T = config.tableName;
const processor = require("./processor");

// Claim due rows atomically. SKIP LOCKED => several instances never grab the same row.
// attempts is incremented on claim, so a worker that crashes still "uses up" an attempt.
const CLAIM_SQL = `
UPDATE ${T}
   SET locked_at = now(), attempts = attempts + 1
 WHERE transaction_id IN (
        SELECT transaction_id
          FROM ${T}
         WHERE status = 'PROCESSING'
           AND attempts < $3::int
           AND process_after <= now()
           AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => $2::double precision))
         ORDER BY process_after
         LIMIT $1::int
         FOR UPDATE SKIP LOCKED
 )
RETURNING transaction_id, source_account, destination_account, amount, currency, attempts`;

// A worker that died during its LAST attempt leaves the row PROCESSING forever; close those out.
const REAP_SQL = `
UPDATE ${T}
   SET status = 'FAILED', locked_at = NULL,
       last_error = COALESCE(last_error, 'worker lease expired on final attempt')
 WHERE status = 'PROCESSING'
   AND attempts >= $1::int
   AND locked_at IS NOT NULL
   AND locked_at < now() - make_interval(secs => $2::double precision)`;

async function processTransaction(tx) {
  try {
    await processor.callExternalApi(tx);
    await pool.query(
      `UPDATE ${T}
          SET status = 'PROCESSED', processed_at = now(), locked_at = NULL, last_error = NULL
        WHERE transaction_id = $1 AND status = 'PROCESSING'`,
      [tx.transaction_id]
    );
    console.log(`processed ${tx.transaction_id}`);
  } catch (err) {
    const giveUp = tx.attempts >= config.maxAttempts;
    const backoff = config.retryBaseSeconds * 2 ** (tx.attempts - 1);
    console.error(
      `attempt ${tx.attempts}/${config.maxAttempts} failed for ${tx.transaction_id}: ${err.message}` +
        (giveUp ? " -> marking FAILED" : ` -> retry in ${backoff}s`)
    );
    await pool
      .query(
        `UPDATE ${T}
            SET status = CASE WHEN $2::boolean THEN 'FAILED' ELSE status END,
                last_error = $3,
                locked_at = NULL,
                process_after = now() + make_interval(secs => $4::double precision)
          WHERE transaction_id = $1 AND status = 'PROCESSING'`,
        [tx.transaction_id, giveUp, String(err.message).slice(0, 500), backoff]
      )
      .catch((e) => console.error("could not record failure", e.message));
  }
}

let stopped = false;
let timer = null;

async function tick() {
  if (stopped) return;
  let more = false;
  try {
    await pool.query(REAP_SQL, [config.maxAttempts, config.lockTimeoutSeconds]);
    const { rows } = await pool.query(CLAIM_SQL, [
      config.batchSize,
      config.lockTimeoutSeconds,
      config.maxAttempts,
    ]);
    if (rows.length) {
      await Promise.all(rows.map(processTransaction));
      more = true;
    }
  } catch (err) {
    if (!stopped) console.error("worker loop error", err.message);
  }
  if (!stopped) timer = setTimeout(tick, more ? 0 : config.pollIntervalMs);
}

function start() {
  stopped = false;
  console.log("worker started");
  tick();
}

function stop() {
  stopped = true;
  clearTimeout(timer);
}

module.exports = { start, stop };
