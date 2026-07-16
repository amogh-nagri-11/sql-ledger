import { pool } from "../db.js";

// A plain script, not an endpoint — accounts are reference data, not something
// the app creates at runtime. Idempotent via ON CONFLICT so it's safe to re-run.
const accounts: Array<{ name: string; type: string }> = [
  { name: "user:alice", type: "asset" },      // customer cash balance (an asset we hold)
  { name: "user:bob", type: "asset" },
  { name: "revenue", type: "revenue" },        // fees we earn
  { name: "fees_payable", type: "liability" }, // fees we owe onward
];

async function main() {
  for (const a of accounts) {
    await pool.query(
      `INSERT INTO accounts (name, type)
       VALUES ($1, $2::account_type)
       ON CONFLICT (name) DO NOTHING`,
      [a.name, a.type],
    );
  }

  const { rows } = await pool.query(
    "SELECT id, name, type FROM accounts ORDER BY id",
  );
  console.log("Accounts:");
  for (const r of rows) console.log(`  #${r.id}  ${r.name}  (${r.type})`);
  console.log(`Seeded ${accounts.length} account(s); ${rows.length} total in DB.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
