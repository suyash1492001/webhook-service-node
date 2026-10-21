// Stand-in for the real external API call (payment gateway, ledger, etc.).
// Kept in its own module so tests can make it fail on purpose.
async function callExternalApi(transaction) {
  // The required 30s delay is enforced by the `process_after` timestamp, so
  // no worker slot is blocked sleeping. Real network I/O would go here.
  return { ok: true, transaction_id: transaction.transaction_id };
}

module.exports = { callExternalApi };
