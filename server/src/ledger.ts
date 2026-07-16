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
