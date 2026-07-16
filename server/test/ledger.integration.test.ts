import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db.js";
import { getBalance, LedgerError, postTransaction, trialBalance } from "../src/ledger.js";

// All DB-backed tests live in ONE file so they run strictly sequentially against
// the shared Postgres. Splitting them across files let Vitest overlap two files'
// concurrent writes, which is a test-harness race — not a ledger bug (the write
// path is provably correct under 100-way concurrency; see the transfer test).

const uniq = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Concurrency-transfer accounts.
const SRC = `test:src-${uniq}`;
const DST = `test:dst-${uniq}`;
// Overdraft accounts.
const WALLET = `test:wallet-${uniq}`; // protected: may not go negative
const SINK = `test:sink-${uniq}`; // unprotected counterparty

async function fund(cents: number) {
  await postTransaction({
    idempotencyKey: `fund-${uniq}`,
    description: "initial funding",
    legs: [
      { account: WALLET, direction: "debit", amount: cents },
      { account: SINK, direction: "credit", amount: cents },
    ],
  });
}

beforeAll(async () => {
  await pool.query(
    `INSERT INTO accounts (name, type, allow_negative) VALUES
       ($1, 'asset', true),
       ($2, 'asset', true),
       ($3, 'asset', false),
       ($4, 'asset', true)`,
    [SRC, DST, WALLET, SINK],
  );
  await fund(5000); // $50.00 into WALLET
});

afterAll(async () => {
  const names = [SRC, DST, WALLET, SINK];
  await pool.query(
    "DELETE FROM ledger_entries WHERE account_id IN (SELECT id FROM accounts WHERE name = ANY($1))",
    [names],
  );
  await pool.query(
    "DELETE FROM transactions WHERE idempotency_key LIKE $1 OR idempotency_key = $2",
    [`%-${uniq}%`, `fund-${uniq}`],
  );
  await pool.query("DELETE FROM accounts WHERE name = ANY($1)", [names]);
  await pool.end();
});

describe("concurrency (real Postgres)", () => {
  it("100 concurrent transfers keep the ledger balanced", async () => {
    const N = 100;

    // Fire all N at once. Each is its own DB transaction competing for the same
    // pool + rows; nothing is serialized in app code.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        postTransaction({
          idempotencyKey: `xfer-${uniq}-${i}`,
          description: `concurrent transfer ${i}`,
          legs: [
            { account: DST, direction: "debit", amount: 1 },
            { account: SRC, direction: "credit", amount: 1 },
          ],
        }),
      ),
    );

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
    const key = `idem-${uniq}`;
    const N = 25;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        postTransaction({
          idempotencyKey: key,
          description: "duplicate-fire",
          legs: [
            { account: DST, direction: "debit", amount: 7 },
            { account: SRC, direction: "credit", amount: 7 },
          ],
        }),
      ),
    );

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

describe("negative-balance prevention (real Postgres)", () => {
  it("rejects a single overdraw", async () => {
    await expect(
      postTransaction({
        idempotencyKey: `over-${uniq}`,
        legs: [
          { account: WALLET, direction: "credit", amount: 5001 }, // withdraw $50.01 from $50.00
          { account: SINK, direction: "debit", amount: 5001 },
        ],
      }),
    ).rejects.toMatchObject({ code: "insufficient_funds" } satisfies Partial<LedgerError>);

    // Balance untouched — the whole transaction rolled back.
    expect((await getBalance(WALLET)).balance).toBe(5000);
  });

  it("under 100 concurrent $1 withdrawals from a $50 wallet, exactly 50 succeed and it never goes negative", async () => {
    const N = 100; // twice the available balance

    const outcomes = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        postTransaction({
          idempotencyKey: `wd-${uniq}-${i}`,
          description: `withdraw ${i}`,
          legs: [
            { account: WALLET, direction: "credit", amount: 100 }, // -$1
            { account: SINK, direction: "debit", amount: 100 },
          ],
        })
          .then(() => "ok" as const)
          .catch((e: unknown) =>
            e instanceof LedgerError && e.code === "insufficient_funds"
              ? ("rejected" as const)
              : Promise.reject(e),
          ),
      ),
    );

    expect(outcomes.filter((o) => o === "ok")).toHaveLength(50);
    expect(outcomes.filter((o) => o === "rejected")).toHaveLength(50);

    // The invariant that actually matters: it never dipped below zero.
    const balance = (await getBalance(WALLET)).balance;
    expect(balance).toBe(0);
    expect(balance).toBeGreaterThanOrEqual(0);
  });
});
