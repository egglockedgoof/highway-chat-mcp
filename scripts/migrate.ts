#!/usr/bin/env node
/**
 * Apply plain-SQL files in migrations/ against DATABASE_URL.
 *   DATABASE_URL=postgres://... npm run migrate
 * Idempotent via schema_migrations. No secrets in git.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("FATAL: DATABASE_URL is not set.");
  process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const { rows } = await client.query("SELECT id FROM schema_migrations");
  const done = new Set(rows.map((r: { id: string }) => r.id));
  for (const file of files) {
    if (done.has(file)) { console.log(`skip ${file}`); continue; }
    const sql = readFileSync(join(dir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`apply ${file}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }
} finally {
  await client.end();
}
