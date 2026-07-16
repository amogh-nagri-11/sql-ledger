import express from "express";
import { config } from "./config.js";
import { pool } from "./db.js";

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
