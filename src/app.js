const express = require("express");
const config = require("./config");
const T = config.tableName;
const { pool } = require("./db");

const app = express();
app.use(express.json());

const iso = (d) => (d ? new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z") : null);
const isId = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 128;
const cents = (n) => Math.round(Number(n) * 100);

function validate(b) {
  const errors = [];
  for (const f of ["transaction_id", "source_account", "destination_account"]) {
    if (!isId(b[f])) errors.push(`${f} must be a non-empty string (max 128 chars)`);
  }
  if (typeof b.amount !== "number" || !Number.isFinite(b.amount) || b.amount <= 0 || b.amount >= 1e13) {
    errors.push("amount must be a positive number");
  } else if (Math.abs(b.amount * 100 - Math.round(b.amount * 100)) > 1e-6) {
    errors.push("amount must have at most 2 decimal places");
  }
  if (typeof b.currency !== "string" || !/^[A-Za-z]{3}$/.test(b.currency)) {
    errors.push("currency must be a 3-letter code");
  }
  return errors;
}

function samePayload(existing, b) {
  return (
    existing.source_account === b.source_account &&
    existing.destination_account === b.destination_account &&
    existing.currency === b.currency.toUpperCase() &&
    cents(existing.amount) === cents(b.amount)
  );
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "HEALTHY", current_time: iso(new Date()) });
});

// Webhook: persist, then ack. Duplicates are a no-op thanks to the primary key.
app.post("/v1/webhooks/transactions", async (req, res) => {
  const b = req.body || {};
  const errors = validate(b);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const { rowCount } = await pool.query(
      `INSERT INTO ${T}
         (transaction_id, source_account, destination_account, amount, currency, process_after)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::double precision))
       ON CONFLICT (transaction_id) DO NOTHING`,
      [
        b.transaction_id,
        b.source_account,
        b.destination_account,
        b.amount,
        b.currency.toUpperCase(),
        config.processingDelaySeconds,
      ]
    );

    if (rowCount === 0) {
      console.log(`duplicate webhook: ${b.transaction_id}`);
      if (config.rejectConflictingDuplicates) {
        const { rows } = await pool.query(
          `SELECT source_account, destination_account, amount, currency
             FROM ${T} WHERE transaction_id = $1`,
          [b.transaction_id]
        );
        if (rows[0] && !samePayload(rows[0], b)) {
          console.warn(`conflicting duplicate for ${b.transaction_id}: payload differs from the original`);
          return res.status(409).json({
            error: "transaction_id already exists with a different payload",
            transaction_id: b.transaction_id,
          });
        }
      }
    }
    return res.status(202).json({ status: "accepted", transaction_id: b.transaction_id });
  } catch (err) {
    console.error("webhook insert failed", err);
    // 5xx makes the payment processor retry, so the transaction is not lost.
    return res.status(503).json({ error: "temporarily unavailable, please retry" });
  }
});

// Query status (for testing)
app.get("/v1/transactions/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT transaction_id, source_account, destination_account, amount, currency,
              status, created_at, processed_at
         FROM ${T} WHERE transaction_id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ detail: "Transaction not found" });
    res.json(
      rows.map((r) => ({
        transaction_id: r.transaction_id,
        source_account: r.source_account,
        destination_account: r.destination_account,
        amount: parseFloat(r.amount),
        currency: r.currency,
        status: r.status,
        created_at: iso(r.created_at),
        processed_at: iso(r.processed_at),
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// Malformed JSON etc.
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON" });
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

module.exports = app;
