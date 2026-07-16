import type { PoolClient } from "pg";
import { pool, withTransaction } from "./db.js";
import type { Leg, PostTransactionInput } from "./schemas.js";

export type Direction = "debit" | "credit";

/** A domain error that maps to a specific HTTP status at the route boundary. */
export class LedgerError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export interface TransactionResult {
  id: number;
  idempotencyKey: string;
  description: string | null;
  createdAt: string;
  legs: Array<{ account: string; accountId: number; direction: Direction; amount: number }>;
  /** true when this was an idempotent replay of a prior post, not a new write. */
  replayed: boolean;
}

/** Signed sum with the debit/credit convention: debit +, credit -. */
function signedTotal(legs: Leg[]): number {
  return legs.reduce((sum, l) => sum + (l.direction === "debit" ? l.amount : -l.amount), 0);
}

async function findByKey(
  runner: Pick<PoolClient, "query">,
  key: string,
): Promise<TransactionResult | null> {
  const { rows } = await runner.query<{ id: number }>(
    "SELECT id FROM transactions WHERE idempotency_key = $1",
    [key],
  );
  if (rows.length === 0) return null;
  return loadTransaction(runner, rows[0].id, true);
}

async function loadTransaction(
  runner: Pick<PoolClient, "query">,
  id: number,
  replayed: boolean,
): Promise<TransactionResult> {
  const tx = await runner.query<{
    id: number;
    idempotency_key: string;
    description: string | null;
    created_at: Date;
  }>("SELECT id, idempotency_key, description, created_at FROM transactions WHERE id = $1", [id]);

  const entries = await runner.query<{
    account_id: number;
    name: string;
    amount: number;
    direction: Direction;
  }>(
    `SELECT le.account_id, a.name, le.amount, le.direction
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
      WHERE le.transaction_id = $1
      ORDER BY le.id`,
    [id],
  );

  const t = tx.rows[0];
  return {
    id: t.id,
    idempotencyKey: t.idempotency_key,
    description: t.description,
    createdAt: t.created_at.toISOString(),
    legs: entries.rows.map((e) => ({
      account: e.name,
      accountId: e.account_id,
      direction: e.direction,
      amount: e.amount,
    })),
    replayed,
  };
}

/**
 * Post a balanced double-entry transaction.
 *
 * Two guarantees this function exists to provide:
 *  1. The balance check runs in app code BEFORE any DB round trip — fail fast.
 *  2. Everything from the idempotency check through the inserts happens inside
 *     ONE database transaction. Any failure rolls the whole thing back, so a
 *     half-written transaction can never exist.
 */
export async function postTransaction(input: PostTransactionInput): Promise<TransactionResult> {
  const net = signedTotal(input.legs);
  if (net !== 0) {
    throw new LedgerError(
      `Transaction does not balance: debits - credits = ${net}`,
      "unbalanced",
      422,
    );
  }

  try {
    return await withTransaction(async (client) => {
      // Idempotent replay: same key returns the original, is not a new write.
      const existing = await findByKey(client, input.idempotencyKey);
      if (existing) return existing;

      // Resolve account names to ids; reject any unknown account.
      const names = [...new Set(input.legs.map((l) => l.account))];
      const accs = await client.query<{ id: number; name: string }>(
        "SELECT id, name FROM accounts WHERE name = ANY($1)",
        [names],
      );
      const idByName = new Map(accs.rows.map((r) => [r.name, r.id]));
      for (const n of names) {
        if (!idByName.has(n)) {
          throw new LedgerError(`Unknown account: ${n}`, "unknown_account", 422);
        }
      }

      const tx = await client.query<{ id: number }>(
        "INSERT INTO transactions (idempotency_key, description) VALUES ($1, $2) RETURNING id",
        [input.idempotencyKey, input.description ?? null],
      );
      const txId = tx.rows[0].id;

      for (const l of input.legs) {
        await client.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, amount, direction)
           VALUES ($1, $2, $3, $4::entry_direction)`,
          [txId, idByName.get(l.account), l.amount, l.direction],
        );
      }

      return loadTransaction(client, txId, false);
    });
  } catch (err) {
    // Concurrency race: two requests with the SAME key both passed the SELECT,
    // then one lost the INSERT to the UNIQUE constraint (23505). That's not an
    // error — it's a successful idempotent replay. Re-fetch the winner's row.
    if (isUniqueViolation(err)) {
      const existing = await findByKey(pool, input.idempotencyKey);
      if (existing) return existing;
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export interface AccountSummary {
  id: number;
  name: string;
  type: string;
}

/** The chart of accounts, for populating UI selectors. */
export async function listAccounts(): Promise<AccountSummary[]> {
  const { rows } = await pool.query<AccountSummary>(
    "SELECT id, name, type FROM accounts ORDER BY name",
  );
  return rows;
}

export interface BalanceResult {
  account: string;
  accountType: string;
  balance: number;
  asOf: string;
}

/**
 * Current (or point-in-time) balance for one account, DERIVED by summing its
 * entries — there is no stored balance to read.
 *
 * The normal-balance rule lives in the CASE below: for asset/expense accounts a
 * debit increases the balance; for liability/revenue/equity a credit does. The
 * `asOf` cutoff is the ONLY difference between "balance now" and "balance last
 * Tuesday" — that falls out of storing immutable entries for free.
 */
export async function getBalance(accountName: string, asOf?: Date): Promise<BalanceResult> {
  const acc = await pool.query<{ id: number; type: string }>(
    "SELECT id, type FROM accounts WHERE name = $1",
    [accountName],
  );
  if (acc.rows.length === 0) {
    throw new LedgerError(`Unknown account: ${accountName}`, "unknown_account", 404);
  }
  const asOfTs = asOf ?? new Date();

  // ::bigint keeps the SUM as INT8 so node-postgres returns a JS number, not a
  // NUMERIC string. Safe: money is integers and well within Number range here.
  const { rows } = await pool.query<{ balance: number }>(
    `SELECT COALESCE(SUM(
        CASE
          WHEN a.type IN ('asset', 'expense')
            THEN CASE WHEN le.direction = 'debit'  THEN le.amount ELSE -le.amount END
          ELSE CASE WHEN le.direction = 'credit' THEN le.amount ELSE -le.amount END
        END
      ), 0)::bigint AS balance
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
      WHERE le.account_id = $1
        AND le.created_at <= $2`,
    [acc.rows[0].id, asOfTs],
  );

  return {
    account: accountName,
    accountType: acc.rows[0].type,
    balance: rows[0].balance,
    asOf: asOfTs.toISOString(),
  };
}

export interface StatementEntry {
  entryId: number;
  transactionId: number;
  direction: Direction;
  amount: number;
  /** Signed effect of this entry on THIS account's balance (+increase/-decrease). */
  effect: number;
  /** Balance immediately after this entry was applied. */
  runningBalance: number;
  description: string | null;
  createdAt: string;
}

export interface StatementResult {
  account: string;
  accountType: string;
  balance: number;
  entries: StatementEntry[];
}

/**
 * Entry history for one account, newest first, each row carrying a running
 * balance. The running balance is an accumulator computed as we iterate the
 * entries oldest→newest — NOT a stored column — then the list is reversed for
 * display.
 */
export async function getStatement(
  accountName: string,
  opts: { asOf?: Date; limit?: number } = {},
): Promise<StatementResult> {
  const acc = await pool.query<{ id: number; type: string }>(
    "SELECT id, type FROM accounts WHERE name = $1",
    [accountName],
  );
  if (acc.rows.length === 0) {
    throw new LedgerError(`Unknown account: ${accountName}`, "unknown_account", 404);
  }
  const type = acc.rows[0].type;
  const asOfTs = opts.asOf ?? new Date();
  const limit = opts.limit ?? 100;

  const { rows } = await pool.query<{
    id: number;
    transaction_id: number;
    amount: number;
    direction: Direction;
    created_at: Date;
    description: string | null;
  }>(
    `SELECT le.id, le.transaction_id, le.amount, le.direction, le.created_at, t.description
       FROM ledger_entries le
       JOIN transactions t ON t.id = le.transaction_id
      WHERE le.account_id = $1
        AND le.created_at <= $2
      ORDER BY le.created_at ASC, le.id ASC`,
    [acc.rows[0].id, asOfTs],
  );

  const increasesOn: Direction = type === "asset" || type === "expense" ? "debit" : "credit";

  let running = 0;
  const chronological: StatementEntry[] = rows.map((r) => {
    const effect = r.direction === increasesOn ? r.amount : -r.amount;
    running += effect;
    return {
      entryId: r.id,
      transactionId: r.transaction_id,
      direction: r.direction,
      amount: r.amount,
      effect,
      runningBalance: running,
      description: r.description,
      createdAt: r.created_at.toISOString(),
    };
  });

  // Newest first for display; `running` is now the current balance.
  const entries = chronological.reverse().slice(0, limit);
  return { account: accountName, accountType: type, balance: running, entries };
}

export interface TrialBalanceResult {
  balanced: boolean;
  net: number;
  totalDebits: number;
  totalCredits: number;
  asOf: string;
}

/**
 * The whole-ledger invariant: across every entry, debits minus credits must be
 * zero. If `net` is ever nonzero, the books are broken.
 */
export async function trialBalance(asOf?: Date): Promise<TrialBalanceResult> {
  const asOfTs = asOf ?? new Date();
  const { rows } = await pool.query<{ debits: number; credits: number; net: number }>(
    `SELECT
        COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount ELSE 0 END), 0)::bigint AS debits,
        COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END), 0)::bigint AS credits,
        COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount ELSE -amount END), 0)::bigint AS net
       FROM ledger_entries
      WHERE created_at <= $1`,
    [asOfTs],
  );
  const r = rows[0];
  return {
    balanced: r.net === 0,
    net: r.net,
    totalDebits: r.debits,
    totalCredits: r.credits,
    asOf: asOfTs.toISOString(),
  };
}
