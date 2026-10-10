import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbSchema, pgTargets } from "./postgres.js";

export type MigrateDb = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

/** migrations/ next to the repo root (dist/store -> ../../migrations). */
export function migrationsDir(from = import.meta.url): string {
  return join(dirname(fileURLToPath(from)), "..", "..", "migrations");
}

/** Apply numbered SQL files. `db` must be one connection (BEGIN-safe). */
export async function applySqlMigrations(db: MigrateDb, schema: string, dir: string): Promise<string[]> {
  const s = dbSchema({ DB_SCHEMA: schema });
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${s}.schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const { rows } = await db.query(`SELECT id FROM ${s}.schema_migrations`);
  const done = new Set(rows.map((r) => String(r.id)));
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    await db.query("BEGIN");
    try {
      await db.query(sql);
      await db.query(`INSERT INTO ${s}.schema_migrations (id) VALUES ($1)`, [file]);
      await db.query("COMMIT");
      applied.push(file);
      console.log(`migrate: apply ${file}`);
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
  }
  return applied;
}

/** Connect via DATABASE_URL then FALLBACK, apply, disconnect. Host only in logs. */
export async function runMigrations(env: NodeJS.ProcessEnv = process.env, dir = migrationsDir()): Promise<string[]> {
  const schema = dbSchema(env);
  const targets = pgTargets(env);
  if (!targets.length) throw new Error("DATABASE_URL is not set");
  const { Client } = await import("pg") as {
    Client: new (opts: { connectionString: string; connectionTimeoutMillis?: number }) => MigrateDb & {
      connect: () => Promise<void>;
      end: () => Promise<void>;
    };
  };
  let last: unknown;
  for (const t of targets) {
    const c = new Client({ connectionString: t.url, connectionTimeoutMillis: 4000 });
    try {
      await c.connect();
      console.log(`migrate: connected host=${t.host} via=${t.source}`);
      try {
        return await applySqlMigrations(c, schema, dir);
      } finally {
        await c.end();
      }
    } catch (e) {
      console.warn(`migrate: failed host=${t.host} via=${t.source}`);
      await c.end().catch(() => {});
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("migrate failed");
}
