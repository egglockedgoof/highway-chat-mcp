#!/usr/bin/env node
/**
 * Apply plain-SQL files in migrations/ against DATABASE_URL
 * then DATABASE_URL_FALLBACK. Logs host only. Never prints the URL.
 * Schema: DB_SCHEMA (default highway).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

function schemaOf(): string {
  const s = (process.env.DB_SCHEMA ?? "highway").trim() || "highway";
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(s)) {
    console.error("FATAL: invalid DB_SCHEMA");
    process.exit(1);
  }
  return s;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname || "unknown"; }
  catch { return "unknown"; }
}

function targets(): Array<{ source: string; host: string; url: string }> {
  const out: Array<{ source: string; host: string; url: string }> = [];
  const a = process.env.DATABASE_URL?.trim();
  const b = process.env.DATABASE_URL_FALLBACK?.trim();
  if (a) out.push({ source: "primary", host: hostOf(a), url: a });
  if (b && b !== a) out.push({ source: "fallback", host: hostOf(b), url: b });
  return out;
}

const schema = schemaOf();
const list = targets();
if (!list.length) {
  console.error("FATAL: DATABASE_URL is not set.");
  process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

let client: pg.Client | null = null;
let last: unknown;
for (const t of list) {
  const c = new pg.Client({ connectionString: t.url, connectionTimeoutMillis: 4000 });
  try {
    await c.connect();
    console.log(`migrate: connected host=${t.host} via=${t.source}`);
    client = c;
    break;
  } catch (e) {
    console.warn(`migrate: connect failed host=${t.host} via=${t.source}`);
    await c.end().catch((endErr: unknown) => {
      console.warn(`migrate: client end failed host=${t.host}: ${endErr instanceof Error ? endErr.message : String(endErr)}`);
    });
    last = e;
  }
}
if (!client) {
  console.error("FATAL: postgres connect failed");
  process.exit(1);
}

try {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const { rows } = await client.query(`SELECT id FROM ${schema}.schema_migrations`);
  const done = new Set(rows.map((r: { id: string }) => r.id));
  for (const file of files) {
    if (done.has(file)) { console.log(`skip ${file}`); continue; }
    const sql = readFileSync(join(dir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(`INSERT INTO ${schema}.schema_migrations (id) VALUES ($1)`, [file]);
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
void last;
