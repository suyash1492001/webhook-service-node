// Integration tests: they run against the database in DATABASE_URL (use a dev/test project).
// Delays are shortened via env so the whole suite takes ~15s.
process.env.PROCESSING_DELAY_SECONDS = "1";
process.env.POLL_INTERVAL_MS = "200";
process.env.MAX_ATTEMPTS = "3";
process.env.RETRY_BASE_SECONDS = "0";
// Own table per run: no other worker/server on the same database can touch these rows,
// and real data is never read or deleted.
process.env.TRANSACTIONS_TABLE = `transactions_test_${Date.now()}`;
const T = process.env.TRANSACTIONS_TABLE;

const request = require("supertest");
const app = require("../src/app");
const { pool, init } = require("../src/db");
const worker = require("../src/worker");
const processor = require("../src/processor");

const PREFIX = `test_${Date.now()}_`;
let n = 0;
const payload = (over = {}) => ({
  transaction_id: `${PREFIX}${++n}`,
  source_account: "acc_user_789",
  destination_account: "acc_merchant_456",
  amount: 1500,
  currency: "INR",
  ...over,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForStatus(id, status, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  let body;
  while (Date.now() < end) {
    body = (await request(app).get(`/v1/transactions/${id}`)).body;
    if (body[0] && body[0].status === status) return body;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${status}; last: ${JSON.stringify(body)}`);
}

beforeAll(async () => {
  await init();
  worker.start();
});

afterAll(async () => {
  worker.stop();
  await sleep(400);
  await pool.query(`DROP TABLE IF EXISTS ${T}`);
  await pool.end();
});

afterEach(() => jest.restoreAllMocks());

describe("health", () => {
  test("GET / returns HEALTHY with a timestamp", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("HEALTHY");
    expect(res.body.current_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("POST /v1/webhooks/transactions", () => {
  test("returns 202 and stores the transaction as PROCESSING", async () => {
    const p = payload();
    const res = await request(app).post("/v1/webhooks/transactions").send(p);
    expect(res.status).toBe(202);
    expect(res.body.transaction_id).toBe(p.transaction_id);

    const got = await request(app).get(`/v1/transactions/${p.transaction_id}`);
    expect(got.status).toBe(200);
    expect(got.body).toHaveLength(1);
    expect(got.body[0]).toMatchObject({ status: "PROCESSING", processed_at: null, amount: 1500 });
  });

  test.each([
    ["missing transaction_id", { transaction_id: undefined }],
    ["negative amount", { amount: -5 }],
    ["string amount", { amount: "1500" }],
    ["bad currency", { currency: "RUPEES" }],
    ["too many decimals", { amount: 10.123 }],
  ])("rejects invalid payload: %s -> 400", async (_name, over) => {
    const res = await request(app).post("/v1/webhooks/transactions").send(payload(over));
    expect(res.status).toBe(400);
  });

  test("rejects malformed JSON with 400", async () => {
    const res = await request(app)
      .post("/v1/webhooks/transactions")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
  });
});

describe("idempotency", () => {
  test("20 concurrent identical webhooks -> all 202, exactly one row", async () => {
    const p = payload();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => request(app).post("/v1/webhooks/transactions").send(p))
    );
    expect(results.every((r) => r.status === 202)).toBe(true);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${T} WHERE transaction_id = $1`,
      [p.transaction_id]
    );
    expect(rows[0].n).toBe(1);
  });

  test("same id with a different payload -> 409 and original is untouched", async () => {
    const p = payload();
    expect((await request(app).post("/v1/webhooks/transactions").send(p)).status).toBe(202);

    const res = await request(app)
      .post("/v1/webhooks/transactions")
      .send({ ...p, amount: 999 });
    expect(res.status).toBe(409);

    const got = await request(app).get(`/v1/transactions/${p.transaction_id}`);
    expect(got.body).toHaveLength(1);
    expect(got.body[0].amount).toBe(1500);
  });

  test("a duplicate sent after processing does not reprocess or change the record", async () => {
    const p = payload();
    await request(app).post("/v1/webhooks/transactions").send(p);
    const [first] = await waitForStatus(p.transaction_id, "PROCESSED");

    const dup = await request(app).post("/v1/webhooks/transactions").send(p);
    expect(dup.status).toBe(202);
    await sleep(1500);

    const got = await request(app).get(`/v1/transactions/${p.transaction_id}`);
    expect(got.body).toHaveLength(1);
    expect(got.body[0].processed_at).toBe(first.processed_at);
  });
});

describe("background processing", () => {
  test("transaction becomes PROCESSED after the delay, with processed_at set", async () => {
    const p = payload();
    await request(app).post("/v1/webhooks/transactions").send(p);
    const [tx] = await waitForStatus(p.transaction_id, "PROCESSED");
    expect(tx.processed_at).not.toBeNull();
    expect(new Date(tx.processed_at) - new Date(tx.created_at)).toBeGreaterThanOrEqual(900);
  });

  test("a transaction that fails once is retried and then succeeds", async () => {
    jest.spyOn(processor, "callExternalApi").mockRejectedValueOnce(new Error("gateway timeout"));
    const p = payload();
    await request(app).post("/v1/webhooks/transactions").send(p);
    const [tx] = await waitForStatus(p.transaction_id, "PROCESSED");
    expect(tx.status).toBe("PROCESSED");

    const { rows } = await pool.query(`SELECT attempts FROM ${T} WHERE transaction_id = $1`, [
      p.transaction_id,
    ]);
    expect(rows[0].attempts).toBe(2);
  });

  test("a transaction that always fails ends as FAILED after MAX_ATTEMPTS", async () => {
    jest.spyOn(processor, "callExternalApi").mockRejectedValue(new Error("gateway down"));
    const p = payload();
    await request(app).post("/v1/webhooks/transactions").send(p);
    await waitForStatus(p.transaction_id, "FAILED");

    const { rows } = await pool.query(
      `SELECT attempts, last_error FROM ${T} WHERE transaction_id = $1`,
      [p.transaction_id]
    );
    expect(rows[0].attempts).toBe(3);
    expect(rows[0].last_error).toContain("gateway down");
  });
});

describe("GET /v1/transactions/:id", () => {
  test("unknown id -> 404", async () => {
    const res = await request(app).get(`/v1/transactions/${PREFIX}does_not_exist`);
    expect(res.status).toBe(404);
  });
});
