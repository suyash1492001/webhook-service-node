// Usage:
//   node scripts/test-duplicates.js                       (tests http://localhost:8000)
//   node scripts/test-duplicates.js https://your-app.onrender.com
// Needs Node 18+ (built-in fetch). No extra packages.

const BASE = (process.argv[2] || "http://localhost:8000").replace(/\/$/, "");
const COPIES = 20; // how many identical webhooks to fire at the same time
const id = `txn_dup_${Date.now()}`;
const body = {
  transaction_id: id,
  source_account: "acc_user_789",
  destination_account: "acc_merchant_456",
  amount: 1500,
  currency: "INR",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed = true;
};

async function send() {
  const start = Date.now();
  const res = await fetch(`${BASE}/v1/webhooks/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, ms: Date.now() - start };
}

async function lookup() {
  const res = await fetch(`${BASE}/v1/transactions/${id}`);
  return { status: res.status, data: res.ok ? await res.json() : null };
}

(async () => {
  console.log(`Target: ${BASE}\nTransaction id: ${id}\n`);

  // 1. Fire the same webhook many times, all at once (worst case for race conditions)
  console.log(`Sending ${COPIES} identical webhooks concurrently...`);
  const results = await Promise.all(Array.from({ length: COPIES }, send));
  const slowest = Math.max(...results.map((r) => r.ms));
  check(results.every((r) => r.status === 202), `all ${COPIES} responses were 202`);
  check(slowest < 500, `slowest response ${slowest} ms (< 500 ms)`);

  // 2. Only one record should exist
  let { status, data } = await lookup();
  check(status === 200 && data.length === 1, `exactly 1 record stored (found ${data ? data.length : 0})`);
  check(data && data[0].status === "PROCESSING", "status is PROCESSING right after the webhooks");

  // 3. Wait for background processing (poll up to 50s)
  console.log("\nWaiting for background processing (~30s)...");
  for (let i = 0; i < 25; i++) {
    await sleep(2000);
    ({ data } = await lookup());
    if (data && data[0].status === "PROCESSED") break;
  }
  check(data.length === 1, "still exactly 1 record after processing");
  check(data[0].status === "PROCESSED", "status is PROCESSED");

  if (data[0].processed_at) {
    const secs = (new Date(data[0].processed_at) - new Date(data[0].created_at)) / 1000;
    check(secs >= 29 && secs <= 40, `processed ${secs}s after creation (~30s expected)`);
  } else {
    check(false, "processed_at is set");
  }

  // 4. Optional: count rows straight from the database
  if (process.env.DATABASE_URL || require("fs").existsSync(".env")) {
    try {
      require("dotenv").config();
      const { pool } = require("../src/db");
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM transactions WHERE transaction_id = $1",
        [id]
      );
      check(rows[0].n === 1, `database row count for this id = ${rows[0].n}`);
      await pool.end();
    } catch (e) {
      console.log("SKIP  direct DB check:", e.message);
    }
  }

  console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: ALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
})();
