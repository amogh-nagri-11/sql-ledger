import express from "express";
import { config } from "./config.js";
import { pool } from "./db.js";
import { LedgerError, postTransaction } from "./ledger.js";
import { postTransactionSchema } from "./schemas.js";

const app = express();
app.use(express.json());

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
    if (err instanceof LedgerError) {
      return res.status(err.statusCode).json({ error: err.code, message: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "internal" });
  }
});

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
