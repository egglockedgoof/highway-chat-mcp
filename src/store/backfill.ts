import { createHash } from "node:crypto";
import type { Store, StoreFields } from "./types.js";

export const MESSAGES = "highway_messages" as const;
export const DEFAULT_MAX_READS = 200;
export const DEFAULT_DELAY_MS = 400;
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_SAMPLE = 20;
export const HARD_MAX_READS = 2000;

export type FsPage = {
  documents: Array<{ name?: string; fields?: StoreFields }>;
  nextPageToken?: string;
};

export type Checkpoint = {
  collection: string;
  pageToken?: string;
  docs: number;
  reads: number;
  upserts: number;
  done: boolean;
  updatedAt: string;
};

export type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

export function docIdOf(name: string): string {
  const i = name.lastIndexOf("/");
  return i >= 0 ? decodeURIComponent(name.slice(i + 1)) : name;
}

export function capReads(n: number): number {
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_READS;
  return Math.min(Math.floor(n), HARD_MAX_READS);
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export function fieldHash(fields: StoreFields): string {
  return createHash("sha256").update(canonicalJson(fields)).digest("hex");
}

export function sampleHash(rows: Array<{ id: string; hash: string }>): string {
  const lines = [...rows].map((r) => `${r.id}:${r.hash}`).sort().join("\n");
  return createHash("sha256").update(lines).digest("hex");
}

export function compareCounts(firestore: number, postgres: number): {
  ok: boolean; firestore: number; postgres: number; delta: number;
} {
  return { ok: firestore === postgres, firestore, postgres, delta: postgres - firestore };
}

export async function loadCheckpoint(db: Queryable, collection: string, schema: string): Promise<Checkpoint | null> {
  const { rows } = await db.query(
    `SELECT collection, page_token, docs, reads, upserts, done, updated_at
       FROM ${schema}.backfill_checkpoint WHERE collection = $1`,
    [collection],
  );
  const r = rows[0];
  if (!r) return null;
  const token = typeof r.page_token === "string" && r.page_token ? r.page_token : undefined;
  const updated = r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at ?? "");
  return {
    collection: String(r.collection),
    pageToken: token,
    docs: Number(r.docs),
    reads: Number(r.reads),
    upserts: Number(r.upserts),
    done: Boolean(r.done),
    updatedAt: updated,
  };
}

export async function saveCheckpoint(db: Queryable, schema: string, cp: Checkpoint): Promise<void> {
  await db.query(
    `INSERT INTO ${schema}.backfill_checkpoint
       (collection, page_token, docs, reads, upserts, done, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (collection) DO UPDATE SET
       page_token = EXCLUDED.page_token,
       docs = EXCLUDED.docs,
       reads = EXCLUDED.reads,
       upserts = EXCLUDED.upserts,
       done = EXCLUDED.done,
       updated_at = now()`,
    [cp.collection, cp.pageToken ?? null, cp.docs, cp.reads, cp.upserts, cp.done],
  );
}

export async function runBackfill(opts: {
  apply: boolean;
  maxReads: number;
  delayMs: number;
  pageSize: number;
  schema: string;
  store: Store;
  db: Queryable;
  listPage: (pageToken: string | undefined, pageSize: number) => Promise<FsPage>;
  sleep: (ms: number) => Promise<void>;
  now?: () => string;
}): Promise<Checkpoint> {
  const now = opts.now ?? (() => new Date().toISOString());
  const saved = await loadCheckpoint(opts.db, MESSAGES, opts.schema);
  const cp: Checkpoint = saved ?? {
    collection: MESSAGES, docs: 0, reads: 0, upserts: 0, done: false, updatedAt: now(),
  };
  if (!opts.apply) return { ...cp, updatedAt: now() };
  if (cp.done) return cp;

  // maxReads is per invocation (quota). Checkpoint.reads is cumulative.
  const maxReads = capReads(opts.maxReads);
  let pageToken = cp.pageToken;
  let sessionReads = 0;
  while (sessionReads < maxReads) {
    const take = Math.min(opts.pageSize, maxReads - sessionReads);
    const page = await opts.listPage(pageToken, take);
    if (!page.documents.length) {
      cp.done = true;
      cp.pageToken = undefined;
      cp.updatedAt = now();
      await saveCheckpoint(opts.db, opts.schema, cp);
      return cp;
    }
    sessionReads += page.documents.length;
    cp.reads += page.documents.length;
    for (const doc of page.documents) {
      const id = docIdOf(doc.name ?? "");
      if (!id) continue;
      await opts.store.upsert(MESSAGES, id, doc.fields ?? {});
      cp.docs += 1;
      cp.upserts += 1;
    }
    if (!page.nextPageToken) {
      cp.done = true;
      cp.pageToken = undefined;
      cp.updatedAt = now();
      await saveCheckpoint(opts.db, opts.schema, cp);
      return cp;
    }
    pageToken = page.nextPageToken;
    cp.pageToken = pageToken;
    cp.updatedAt = now();
    await saveCheckpoint(opts.db, opts.schema, cp);
    if (sessionReads >= maxReads) return cp;
    if (opts.delayMs > 0) await opts.sleep(opts.delayMs);
  }
  return cp;
}

export type VerifyResult = {
  ok: boolean;
  counts: ReturnType<typeof compareCounts>;
  sample: { n: number; ok: boolean; firestore: string; postgres: string; mismatches: string[] };
};

export async function verifyMessages(opts: {
  sample: number;
  countFs: () => Promise<number>;
  countPg: () => Promise<number>;
  samplePg: (n: number) => Promise<Array<{ id: string; fields: StoreFields }>>;
  getFs: (id: string) => Promise<StoreFields | null>;
}): Promise<VerifyResult> {
  const counts = compareCounts(await opts.countFs(), await opts.countPg());
  const rows = await opts.samplePg(opts.sample);
  const mismatches: string[] = [];
  const pgParts: Array<{ id: string; hash: string }> = [];
  const fsParts: Array<{ id: string; hash: string }> = [];
  for (const row of rows) {
    const pgH = fieldHash(row.fields);
    pgParts.push({ id: row.id, hash: pgH });
    const fsFields = await opts.getFs(row.id);
    if (!fsFields) {
      mismatches.push(row.id);
      continue;
    }
    const fsH = fieldHash(fsFields);
    fsParts.push({ id: row.id, hash: fsH });
    if (fsH !== pgH) mismatches.push(row.id);
  }
  const firestore = sampleHash(fsParts);
  const postgres = sampleHash(pgParts);
  const sampleOk = mismatches.length === 0 && firestore === postgres;
  return { ok: counts.ok && sampleOk, counts, sample: { n: rows.length, ok: sampleOk, firestore, postgres, mismatches } };
}

export function firestoreBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.FIRESTORE_BASE ||
    "https://firestore.googleapis.com/v1/projects/highway-chat/databases/(default)/documents").replace(/\/$/, "");
}

export function botCredsFromEnv(env: NodeJS.ProcessEnv = process.env): { email: string; password: string } {
  const raw = JSON.parse(env.BOT_CREDENTIALS || "{}") as Record<string, { email?: string; password?: string }>;
  const row = raw.whisper || raw.Whisper || Object.values(raw)[0];
  if (!row?.email || !row?.password) throw new Error("BOT_CREDENTIALS missing email/password");
  return { email: row.email, password: row.password };
}

export async function firebaseIdToken(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const key = env.FIREBASE_API_KEY?.trim();
  if (!key) throw new Error("FIREBASE_API_KEY missing");
  const creds = botCredsFromEnv(env);
  const res = await fetchFn(
    `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: creds.email, password: creds.password, returnSecureToken: true }),
    },
  );
  const body = JSON.parse(await res.text()) as { idToken?: string; error?: { message?: string } };
  if (!res.ok || !body.idToken) throw new Error(`Auth ${res.status}: ${body.error?.message ?? "no idToken"}`);
  return body.idToken;
}

export function createFsClient(opts: {
  token: () => Promise<string>;
  base?: string;
  fetchFn?: typeof fetch;
}): {
  listPage: (pageToken: string | undefined, pageSize: number) => Promise<FsPage>;
  count: () => Promise<number>;
  getFields: (id: string) => Promise<StoreFields | null>;
} {
  const base = (opts.base ?? firestoreBase()).replace(/\/$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  async function call(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; json: unknown }> {
    const token = await opts.token();
    const res = await fetchFn(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
    });
    return { ok: res.ok, status: res.status, json: JSON.parse(await res.text()) };
  }
  return {
    async listPage(pageToken, size) {
      const u = new URL(`${base}/${MESSAGES}`);
      u.searchParams.set("pageSize", String(size));
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const token = await opts.token();
      const res = await fetchFn(u.href, { headers: { Authorization: `Bearer ${token}` } });
      const body = JSON.parse(await res.text()) as FsPage & { error?: { message?: string } };
      if (!res.ok) throw new Error(`list ${res.status}: ${body.error?.message ?? "failed"}`);
      return { documents: body.documents ?? [], nextPageToken: body.nextPageToken };
    },
    async count() {
      const hit = await call(":runAggregationQuery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          structuredAggregationQuery: {
            structuredQuery: { from: [{ collectionId: MESSAGES }] },
            aggregations: [{ count: {}, alias: "total" }],
          },
        }),
      });
      if (!hit.ok) throw new Error(`count HTTP ${hit.status}`);
      const n = (hit.json as Array<{ result?: { aggregateFields?: { total?: { integerValue?: string } } } }>)
        ?.[0]?.result?.aggregateFields?.total?.integerValue;
      if (n === undefined) throw new Error("count missing");
      return Number(n);
    },
    async getFields(id) {
      const hit = await call(`/${MESSAGES}/${encodeURIComponent(id)}`);
      if (hit.status === 404) return null;
      if (!hit.ok) throw new Error(`get ${id} HTTP ${hit.status}`);
      return ((hit.json as { fields?: StoreFields }).fields) ?? {};
    },
  };
}
