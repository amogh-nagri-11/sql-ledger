import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db.js";
import { getBalance, postTransaction, trialBalance } from "../src/ledger.js";

// Unique per run so repeated runs never collide, and so cleanup is precise.
const suffix = Date.now();
const SRC = `test:src-${suffix}`;
const DST = `test:dst-${suffix}`;

beforeAll(async () => {
  await pool.query(
    "INSERT INTO accounts (name, type) VALUES ($1, 'asset'), ($2, 'asset')",
    [SRC, DST],
  );
});

afterAll(async () => {
  // Tidy up: entries first (FK RESTRICT), then transactions, then accounts.
  await pool.query(
    "DELETE FROM ledger_entries WHERE account_id IN (SELECT id FROM accounts WHERE name IN ($1, $2))",
    [SRC, DST],
  );
  await pool.query("DELETE FROM transactions WHERE idempotency_key LIKE $1", [`%-${suffix}-%`]);
  await pool.query("DELETE FROM transactions WHERE idempotency_key LIKE $1", [`idem-${suffix}%`]);
  await pool.query("DELETE FROM accounts WHERE name IN ($1, $2)", [SRC, DST]);
  await pool.end();
});

describe("concurrency (real Postgres)", () => {
  it("100 concurrent transfers keep the ledger balanced", async () => {
    const N = 100;

    // Fire all N at once. Each is its own DB transaction competing for the same
    // pool + rows; nothing is serialized in app code.
    const calls = Array.from({ length: N }, (_, i) =>
      postTransaction({
        idempotencyKey: `xfer-${suffix}-${i}`,
        description: `concurrent transfer ${i}`,
        legs: [
          { account: DST, direction: "debit", amount: 1 },
          { account: SRC, direction: "credit", amount: 1 },
        ],
      }),
    );
    const results = await Promise.all(calls);

    // Every call succeeded and wrote a brand-new transaction (no false replays).
    expect(results).toHaveLength(N);
    expect(results.every((r) => !r.replayed)).toBe(true);
    expect(new Set(results.map((r) => r.id)).size).toBe(N);

    // The invariant: the whole ledger still nets to zero.
    const tb = await trialBalance();
    expect(tb.net).toBe(0);
    expect(tb.balanced).toBe(true);

    // And the money moved exactly N, no lost or double updates.
    expect((await getBalance(SRC)).balance).toBe(-N);
    expect((await getBalance(DST)).balance).toBe(N);
  });

  it("concurrent posts with the SAME idempotency key create exactly one transaction", async () => {
    const key = `idem-${suffix}`;
    const N = 25;

    const calls = Array.from({ length: N }, () =>
      postTransaction({
        idempotencyKey: key,
        description: "duplicate-fire",
        legs: [
          { account: DST, direction: "debit", amount: 7 },
          { account: SRC, direction: "credit", amount: 7 },
        ],
      }),
    );
    const results = await Promise.all(calls);

    // All N racers resolve to the very same transaction id.
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    // Exactly one racer was the real writer; the rest are idempotent replays.
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);

    // The DB agrees: one transaction row, two entries — not N.
    const txCount = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM transactions WHERE idempotency_key = $1",
      [key],
    );
    expect(txCount.rows[0].c).toBe(1);

    const entryCount = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
         FROM ledger_entries le
         JOIN transactions t ON t.id = le.transaction_id
        WHERE t.idempotency_key = $1`,
      [key],
    );
    expect(entryCount.rows[0].c).toBe(2);
  });
});
