import { pool } from "../db.js";
import { trialBalance } from "../ledger.js";

// A cron-style guardrail: periodically assert the whole-ledger invariant and
// shout if it's ever violated. Run it as a sidecar process or a real cron job.
//   npm run healthcheck            # loops every HEALTHCHECK_INTERVAL_MS (default 60s)
//   npm run healthcheck -- --once  # single check then exit (good for cron)
const intervalMs = Number(process.env.HEALTHCHECK_INTERVAL_MS ?? 60000);

async function runOnce(): Promise<boolean> {
  const tb = await trialBalance();
  const ts = new Date().toISOString();
  if (tb.balanced) {
    console.log(
      `[${ts}] OK     ledger balanced (debits=${tb.totalDebits} credits=${tb.totalCredits})`,
    );
  } else {
    console.error(
      `[${ts}] ALERT  ledger OFF by ${tb.net} (debits=${tb.totalDebits} credits=${tb.totalCredits})`,
    );
  }
  return tb.balanced;
}

async function main() {
  const once = process.argv.includes("--once");
  const ok = await runOnce();

  if (once) {
    await pool.end();
    process.exit(ok ? 0 : 1); // nonzero exit lets cron/monitoring detect a bad run
  }

  console.log(`health-check running every ${intervalMs}ms; Ctrl-C to stop.`);
  setInterval(() => {
    runOnce().catch((err) => console.error("health-check query failed:", err));
  }, intervalMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
