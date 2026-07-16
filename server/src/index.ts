import express from "express";
import { config } from "./config.js";
import { pool } from "./db.js";
import {
  getBalance,
  getStatement,
  LedgerError,
  listAccounts,
  postTransaction,
  reconcileAccount,
  trialBalance,
} from "./ledger.js";
import { postTransactionSchema } from "./schemas.js";

const app = express();
app.use(express.json());

// Permissive CORS so the Vite dev server (a different origin) can call the API.
// Dev convenience only — a real deployment would scope the allowed origin.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Chart of accounts (for the dashboard's selectors).
app.get("/accounts", async (_req, res) => {
  try {
    res.json(await listAccounts());
  } catch (err) {
    sendError(res, err);
  }
});

// Health check: proves the API is up AND can reach Postgres.
app.get("/health", async (_req, res) => {
  try {
    const result = await pool.query("SELECT 1 AS ok");
    res.json({ status: "ok", db: result.rows[0].ok === 1 ? "ok" : "unexpected" });
  } catch (err) {
    res.status(503).json({ status: "ok", db: "unreachable", error: String(err) });
  }
});

// Post a balanced double-entry transaction.
app.post("/transactions", async (req, res) => {
  const parsed = postTransactionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "validation", details: parsed.error.flatten() });
  }

  try {
    const result = await postTransaction(parsed.data);
    // 200 for an idempotent replay, 201 when a new transaction was written.
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// Current or point-in-time balance for one account. ?asOf=<ISO timestamp>.
app.get("/accounts/:name/balance", async (req, res) => {
  const asOf = parseAsOf(req.query.asOf);
  if (asOf === "invalid") {
    return res.status(400).json({ error: "validation", message: "asOf must be an ISO timestamp" });
  }
  try {
    res.json(await getBalance(req.params.name, asOf));
  } catch (err) {
    sendError(res, err);
  }
});

// Whole-ledger trial balance. ?asOf=<ISO timestamp> for point-in-time.
app.get("/ledger/trial-balance", async (req, res) => {
  const asOf = parseAsOf(req.query.asOf);
  if (asOf === "invalid") {
    return res.status(400).json({ error: "validation", message: "asOf must be an ISO timestamp" });
  }
  try {
    res.json(await trialBalance(asOf));
  } catch (err) {
    sendError(res, err);
  }
});

// Account statement: entry history, newest first, with a running balance.
app.get("/accounts/:name/statement", async (req, res) => {
  const asOf = parseAsOf(req.query.asOf);
  if (asOf === "invalid") {
    return res.status(400).json({ error: "validation", message: "asOf must be an ISO timestamp" });
  }
  const limit = parseLimit(req.query.limit);
  try {
    res.json(await getStatement(req.params.name, { asOf: asOf ?? undefined, limit }));
  } catch (err) {
    sendError(res, err);
  }
});

// Reconcile an account's ledger balance against an external figure.
// ?expected=<integer cents> (may be negative).
app.get("/accounts/:name/reconcile", async (req, res) => {
  const raw = req.query.expected;
  const expected = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  if (Number.isNaN(expected)) {
    return res
      .status(400)
      .json({ error: "validation", message: "expected must be an integer (cents)" });
  }
  try {
    res.json(await reconcileAccount(req.params.name, expected));
  } catch (err) {
    sendError(res, err);
  }
});

/** Parse ?limit=, clamped to [1, 1000], defaulting to 100. */
function parseLimit(raw: unknown): number {
  if (typeof raw !== "string") return 100;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return 100;
  return Math.min(1000, Math.max(1, n));
}

/** Map a query param to a Date, `undefined` (absent), or "invalid". */
function parseAsOf(raw: unknown): Date | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return "invalid";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

function sendError(res: express.Response, err: unknown): void {
  if (err instanceof LedgerError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "internal" });
}

const server = app.listen(config.port, () => {
  console.log(`ledger API listening on http://localhost:${config.port}`);
});

// Graceful shutdown so `docker compose down` / Ctrl-C closes the pool cleanly.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  });
}

export { app };
