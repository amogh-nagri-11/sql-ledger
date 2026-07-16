import pg from "pg";
import { config } from "./config.js";

// pg parses NUMERIC/BIGINT as strings by default to avoid precision loss.
// We store money as BIGINT (smallest currency unit) and want plain JS numbers
// where we know the magnitude is safe, so teach node-postgres to return them
// as numbers for our own aggregate columns. Individual row amounts are read
// through explicit casts in each query instead of this global setting.
pg.types.setTypeParser(pg.types.builtins.INT8, (val) =>
  val === null ? null : Number(val),
);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

/** Run a query with the shared pool. */
export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) {
  return pool.query<T>(text, params as any[]);
}

/**
 * Run `fn` inside a single database transaction. Commits on success, rolls
 * back on any thrown error. This is the boundary that guarantees a half-written
 * ledger transaction can never exist.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
