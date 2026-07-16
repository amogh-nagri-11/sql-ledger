import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";

// A deliberately tiny runner: it just applies the raw .sql files in order and
// records which ones ran. No Knex/Prisma Migrate — the point is to see exactly
// what a migration does. Each file runs inside its own transaction, so a broken
// migration leaves the schema untouched.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    (await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map(
      (r) => r.filename,
    ),
  );

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= skip   ${file}`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`+ applied ${file}`);
      ran++;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`x failed  ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(ran === 0 ? "Nothing to apply — schema up to date." : `Applied ${ran} migration(s).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
