import pg from "pg";
import {
  type Store, type StoreCollection, type StoreDoc, type StoreFields,
  newId, tsNumOf,
} from "./types.js";

export const POOL_MAX = 5;
const DEFAULT_SCHEMA = "highway";

export type DbHealth = "ok" | "down" | "disabled";
export type PgSource = "primary" | "fallback";

export function dbSchema(env: NodeJS.ProcessEnv = process.env): string {
  const s = (env.DB_SCHEMA ?? DEFAULT_SCHEMA).trim() || DEFAULT_SCHEMA;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(s)) throw new Error("invalid DB_SCHEMA");
  return s;
}

/** Hostname only — never user, password, or full URL. */
export function dbHostOf(url: string): string {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

export function pgTargets(env: NodeJS.ProcessEnv = process.env): Array<{ source: PgSource; host: string; url: string }> {
  const out: Array<{ source: PgSource; host: string; url: string }> = [];
  const primary = env.DATABASE_URL?.trim();
  const fallback = env.DATABASE_URL_FALLBACK?.trim();
  if (primary) out.push({ source: "primary", host: dbHostOf(primary), url: primary });
  if (fallback && fallback !== primary) {
    out.push({ source: "fallback", host: dbHostOf(fallback), url: fallback });
  }
  return out;
}

export function postgresPool(url: string, schema = DEFAULT_SCHEMA): pg.Pool {
  const s = dbSchema({ DB_SCHEMA: schema });
  return new pg.Pool({
    connectionString: url,
    max: POOL_MAX,
    connectionTimeoutMillis: 4000,
    options: `-c search_path=${s}`,
  });
}

export type PgConnect = { pool: pg.Pool; host: string; source: PgSource };

/** Try DATABASE_URL then DATABASE_URL_FALLBACK. Logs host only. */
export async function connectPostgres(env: NodeJS.ProcessEnv = process.env): Promise<PgConnect> {
  const schema = dbSchema(env);
  const targets = pgTargets(env);
  if (!targets.length) throw new Error("DATABASE_URL is not set");
  let last: unknown;
  for (const t of targets) {
    const pool = postgresPool(t.url, schema);
    try {
      await pool.query("SELECT 1");
      console.log(`postgres: connected host=${t.host} via=${t.source}`);
      return { pool, host: t.host, source: t.source };
    } catch (e) {
      console.warn(`postgres: connect failed host=${t.host} via=${t.source}`);
      await pool.end().catch((endErr: unknown) => {
        console.warn(`postgres: pool end failed host=${t.host}: ${endErr instanceof Error ? endErr.message : String(endErr)}`);
      });
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("postgres connect failed");
}

export async function probeDb(env: NodeJS.ProcessEnv = process.env): Promise<DbHealth> {
  if (!env.DATABASE_URL?.trim() && !env.DATABASE_URL_FALLBACK?.trim()) return "disabled";
  try {
    const c = await connectPostgres(env);
    await c.pool.end();
    return "ok";
  } catch {
    return "down";
  }
}

/** Last probe result. Health reads this; it never awaits Postgres. */
let lastHealth: DbHealth = "disabled";
let probeTimer: ReturnType<typeof setInterval> | null = null;

export function currentDbHealth(): DbHealth {
  return lastHealth;
}

/** Background probe so GET /health stays HTTP 200 even if Postgres is down. */
export function startDbProbe(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PHASE3_TEST) return;
  const tick = () => {
    probeDb(env)
      .then((h) => { lastHealth = h; })
      .catch((e: unknown) => {
        lastHealth = "down";
        console.warn(`postgres: probe failed: ${e instanceof Error ? e.message : String(e)}`);
      });
  };
  tick();
  if (!probeTimer) {
    probeTimer = setInterval(tick, 60_000);
    probeTimer.unref();
  }
}

export function stopDbProbe(): void {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

function row(collection: StoreCollection, r: { id: string; fields: StoreFields; ts_num: string | number | null }): StoreDoc {
  const fields = r.fields ?? {};
  const tsNum = r.ts_num !== null && r.ts_num !== undefined ? Number(r.ts_num) : tsNumOf(fields);
  return { id: r.id, collection, fields, tsNum: Number.isFinite(tsNum as number) ? (tsNum as number) : null };
}

/** Plain `pg` + DATABASE_URL. Tables live in schema `highway`. No Supabase SDK. */
export function createPostgresStore(pool: pg.Pool, schema = DEFAULT_SCHEMA): Store {
  const docs = `${dbSchema({ DB_SCHEMA: schema })}.docs`;
  return {
    async get(collection, id) {
      const { rows } = await pool.query(
        `SELECT id, fields, ts_num FROM ${docs} WHERE collection = $1 AND id = $2`,
        [collection, id],
      );
      return rows[0] ? row(collection, rows[0]) : null;
    },
    async create(collection, fields, id) {
      const docId = id || newId();
      const ts = tsNumOf(fields) ?? Date.now();
      const { rows } = await pool.query(
        `INSERT INTO ${docs} (collection, id, fields, ts_num)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id, fields, ts_num`,
        [collection, docId, JSON.stringify(fields), ts],
      );
      return row(collection, rows[0]);
    },
    async upsert(collection, id, fields) {
      const ts = tsNumOf(fields) ?? Date.now();
      const { rows } = await pool.query(
        `INSERT INTO ${docs} (collection, id, fields, ts_num)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (collection, id) DO UPDATE
           SET fields = EXCLUDED.fields, ts_num = EXCLUDED.ts_num, updated_at = now()
         RETURNING id, fields, ts_num`,
        [collection, id, JSON.stringify(fields), ts],
      );
      return row(collection, rows[0]);
    },
    async patch(collection, id, fields) {
      const { rows } = await pool.query(
        `UPDATE ${docs}
            SET fields = fields || $3::jsonb,
                ts_num = COALESCE($4, ts_num),
                updated_at = now()
          WHERE collection = $1 AND id = $2
          RETURNING id, fields, ts_num`,
        [collection, id, JSON.stringify(fields), tsNumOf(fields)],
      );
      if (!rows[0]) throw new Error(`store patch: ${collection}/${id} not found`);
      return row(collection, rows[0]);
    },
    async remove(collection, id) {
      const { rowCount } = await pool.query(
        `DELETE FROM ${docs} WHERE collection = $1 AND id = $2`,
        [collection, id],
      );
      return (rowCount ?? 0) > 0;
    },
    async listNewest(collection, limit) {
      const cap = Math.max(1, Math.min(limit, 200));
      const { rows } = await pool.query(
        `SELECT id, fields, ts_num FROM ${docs}
          WHERE collection = $1
          ORDER BY ts_num DESC NULLS LAST, created_at DESC
          LIMIT $2`,
        [collection, cap],
      );
      return rows.map((r) => row(collection, r));
    },
    async close() { await pool.end(); },
  };
}
