import {
  DEFAULT_DELAY_MS, DEFAULT_MAX_READS, DEFAULT_PAGE_SIZE, DEFAULT_SAMPLE, MESSAGES,
  capReads, compareCounts, createFsClient, firebaseIdToken, firestoreBase, runBackfill, verifyMessages,
  type Checkpoint, type FsPage, type Queryable, type VerifyResult,
} from "./backfill.js";
import { runMigrations } from "./migrate.js";
import {
  connectPostgres, countCollection, createPostgresStore, dbSchema, listSampleDocs,
} from "./postgres.js";
import type { Store, StoreFields } from "./types.js";

export type BackfillPublic = {
  enabled: boolean;
  state: "off" | "migrating" | "running" | "verifying" | "done" | "error";
  done: boolean;
  checkpoint: { docs: number; reads: number; upserts: number; done: boolean; updatedAt: string } | null;
  counts: ReturnType<typeof compareCounts> | null;
  verify: VerifyResult["sample"] | null;
  error: string | null;
};

const idle = (): BackfillPublic => ({
  enabled: false, state: "off", done: false,
  checkpoint: null, counts: null, verify: null, error: null,
});

let status: BackfillPublic = idle();

export function backfillEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BACKFILL_MESSAGES === "1";
}

export function backfillStatus(): BackfillPublic {
  return {
    ...status,
    checkpoint: status.checkpoint ? { ...status.checkpoint } : null,
    counts: status.counts ? { ...status.counts } : null,
    verify: status.verify ? { ...status.verify, mismatches: [...status.verify.mismatches] } : null,
  };
}

export function resetBackfillStatus(): void {
  status = idle();
}

function publicCp(cp: Checkpoint): NonNullable<BackfillPublic["checkpoint"]> {
  return { docs: cp.docs, reads: cp.reads, upserts: cp.upserts, done: cp.done, updatedAt: cp.updatedAt };
}

export type BootBackfillDeps = {
  env?: NodeJS.ProcessEnv;
  applyMigrations?: () => Promise<void>;
  connect?: () => Promise<{ pool: Queryable & { end: () => Promise<void> } }>;
  createStore?: (pool: Queryable, schema: string) => Store;
  listPage?: (pageToken: string | undefined, pageSize: number) => Promise<FsPage>;
  countFs?: () => Promise<number>;
  getFs?: (id: string) => Promise<StoreFields | null>;
  countPg?: (pool: Queryable, collection: string, schema: string) => Promise<number>;
  samplePg?: (pool: Queryable, collection: string, n: number, schema: string) => Promise<Array<{ id: string; fields: StoreFields }>>;
  sleep?: (ms: number) => Promise<void>;
  maxReads?: number;
  delayMs?: number;
  pageSize?: number;
  sample?: number;
};

async function runBootBackfill(deps: BootBackfillDeps): Promise<void> {
  const env = deps.env ?? process.env;
  const schema = dbSchema(env);
  const maxReads = capReads(deps.maxReads ?? DEFAULT_MAX_READS);
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const sampleN = deps.sample ?? DEFAULT_SAMPLE;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  status = { ...status, state: "migrating", error: null };
  if (deps.applyMigrations) await deps.applyMigrations();
  else await runMigrations(env);

  const conn = deps.connect ? await deps.connect() : await connectPostgres(env);
  const pool = conn.pool;
  try {
    const store = deps.createStore
      ? deps.createStore(pool, schema)
      : createPostgresStore(pool as Parameters<typeof createPostgresStore>[0], schema);
    const fs = deps.listPage
      ? { listPage: deps.listPage, count: deps.countFs!, getFields: deps.getFs! }
      : createFsClient({ token: () => firebaseIdToken(env), base: firestoreBase(env) });
    const countPg = deps.countPg
      ?? ((p, c, s) => countCollection(p as Parameters<typeof countCollection>[0], c, s));
    const samplePg = deps.samplePg
      ?? ((p, c, n, s) => listSampleDocs(p as Parameters<typeof listSampleDocs>[0], c, n, s));

    status = { ...status, state: "running" };
    const opts = {
      apply: true, maxReads, delayMs, pageSize, schema, store, db: pool,
      listPage: fs.listPage, sleep,
    };
    let cp = await runBackfill(opts);
    status = { ...status, checkpoint: publicCp(cp) };
    console.log(JSON.stringify({ backfill: "progress", ...publicCp(cp) }));
    while (!cp.done) {
      if (delayMs > 0) await sleep(delayMs);
      cp = await runBackfill(opts);
      status = { ...status, checkpoint: publicCp(cp) };
      console.log(JSON.stringify({ backfill: "progress", ...publicCp(cp) }));
    }

    status = { ...status, state: "verifying", checkpoint: publicCp(cp) };
    const result = await verifyMessages({
      sample: sampleN,
      countFs: fs.count,
      countPg: () => countPg(pool, MESSAGES, schema),
      samplePg: (n) => samplePg(pool, MESSAGES, n, schema),
      getFs: fs.getFields,
    });
    status = {
      ...status,
      state: result.ok ? "done" : "error",
      done: result.ok,
      counts: result.counts,
      verify: result.sample,
      error: result.ok ? null : "verify mismatch",
      checkpoint: publicCp(cp),
    };
    console.log(JSON.stringify({
      backfill: "verify", done: status.done, counts: status.counts, verify: status.verify,
    }));
  } finally {
    await pool.end();
  }
}

/**
 * Fire-and-forget after listen(). Never throws to the caller. Failures land on
 * the snapshot (GET /admin/backfill, /health.backfill). Unref'd so it cannot
 * keep the process alive past SIGTERM.
 */
export function startMessagesBackfill(deps: BootBackfillDeps = {}): void {
  const env = deps.env ?? process.env;
  if (!backfillEnabled(env)) {
    status = idle();
    return;
  }
  status = { ...idle(), enabled: true, state: "migrating" };
  const t = setTimeout(() => {
    void runBootBackfill(deps).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      status = { ...status, state: "error", error: msg, done: false };
      console.warn(`backfill: failed: ${msg}`);
    });
  }, 0);
  t.unref();
}
