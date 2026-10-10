#!/usr/bin/env node
/**
 * highway_messages: Firestore list -> Postgres upsert (idempotent), then
 * count + sample-hash verify. Does not import src/index.ts (no port bind).
 *
 * Default is a dry plan (zero Firestore reads, no Postgres). Live run is AFTER
 * the midnight PT quota reset, ON Render (only host that can reach DATABASE_URL):
 *
 *   npm run backfill:messages -- --apply --verify --max-reads 200 --delay-ms 400 --sample 20
 *
 * Repeat until checkpoint done=true. Firestore stays source of truth.
 */
function has(flag: string): boolean { return process.argv.includes(flag); }
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DEFAULT_MAX_READS = 200;
const DEFAULT_DELAY_MS = 400;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_SAMPLE = 20;
const HARD_MAX_READS = 2000;
const MESSAGES = "highway_messages";

function capReads(n: number): number {
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_READS;
  return Math.min(Math.floor(n), HARD_MAX_READS);
}

const apply = has("--apply");
let verify = has("--verify");
const maxReads = capReads(Number(arg("--max-reads", String(DEFAULT_MAX_READS))));
const delayMs = Math.min(Math.max(0, Number(arg("--delay-ms", String(DEFAULT_DELAY_MS)))), 5000);
const pageSize = Math.min(Math.max(1, Number(arg("--page-size", String(DEFAULT_PAGE_SIZE)))), 100);
const sample = Math.min(Math.max(1, Number(arg("--sample", String(DEFAULT_SAMPLE)))), 100);

const FIRESTORE_BASE = (process.env.FIRESTORE_BASE ||
  "https://firestore.googleapis.com/v1/projects/highway-chat/databases/(default)/documents").replace(/\/$/, "");
const API_KEY = process.env.FIREBASE_API_KEY?.trim() || "";

console.log(JSON.stringify({ plan: { collection: MESSAGES, apply, verify, maxReads, delayMs, pageSize, sample } }));

if (!apply && !verify) {
  console.log(JSON.stringify({ ok: true, dry: true, hint: "pass --apply and/or --verify after midnight PT on Render" }));
  process.exit(0);
}

const pgMod = await import("../dist/store/postgres.js");
const bf = await import("../dist/store/backfill.js");

function botCreds(): { email: string; password: string } {
  const raw = JSON.parse(process.env.BOT_CREDENTIALS || "{}") as Record<string, { email?: string; password?: string }>;
  const row = raw.whisper || raw.Whisper || Object.values(raw)[0];
  if (!row?.email || !row?.password) throw new Error("BOT_CREDENTIALS missing email/password");
  return { email: row.email, password: row.password };
}

async function idToken(): Promise<string> {
  if (!API_KEY) throw new Error("FIREBASE_API_KEY missing");
  const creds = botCreds();
  const res = await fetch(
    `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${API_KEY}`,
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

type FsPage = { documents: Array<{ name?: string; fields?: Record<string, unknown> }>; nextPageToken?: string };

async function fsGet(token: string, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${FIRESTORE_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
  });
  return { ok: res.ok, status: res.status, json: JSON.parse(await res.text()) };
}

async function listPage(token: string, pageToken: string | undefined, size: number): Promise<FsPage> {
  const u = new URL(`${FIRESTORE_BASE}/${MESSAGES}`);
  u.searchParams.set("pageSize", String(size));
  if (pageToken) u.searchParams.set("pageToken", pageToken);
  const res = await fetch(u.href, { headers: { Authorization: `Bearer ${token}` } });
  const body = JSON.parse(await res.text()) as FsPage & { error?: { message?: string } };
  if (!res.ok) throw new Error(`list ${res.status}: ${body.error?.message ?? "failed"}`);
  return { documents: body.documents ?? [], nextPageToken: body.nextPageToken };
}

async function firestoreCount(token: string): Promise<number> {
  const hit = await fsGet(token, ":runAggregationQuery", {
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
}

async function firestoreFields(token: string, id: string): Promise<Record<string, unknown> | null> {
  const hit = await fsGet(token, `/${MESSAGES}/${encodeURIComponent(id)}`);
  if (hit.status === 404) return null;
  if (!hit.ok) throw new Error(`get ${id} HTTP ${hit.status}`);
  return ((hit.json as { fields?: Record<string, unknown> }).fields) ?? {};
}

const schema = pgMod.dbSchema();
const pg = await pgMod.connectPostgres();
const store = pgMod.createPostgresStore(pg.pool, schema);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

try {
  const token = await idToken();
  if (apply) {
    const cp = await bf.runBackfill({
      apply: true, maxReads, delayMs, pageSize, schema, store,
      db: pg.pool,
      listPage: (pageToken, size) => listPage(token, pageToken, size),
      sleep,
    });
    console.log(JSON.stringify({ backfill: cp }));
    if (verify && !cp.done) {
      console.log(JSON.stringify({ verify: { skipped: true, reason: "checkpoint not done; re-run until done" } }));
      verify = false;
    }
  }
  if (verify) {
    const result = await bf.verifyMessages({
      sample,
      countFs: () => firestoreCount(token),
      countPg: () => pgMod.countCollection(pg.pool, MESSAGES, schema),
      samplePg: (n) => pgMod.listSampleDocs(pg.pool, MESSAGES, n, schema),
      getFs: (id) => firestoreFields(token, id),
    });
    console.log(JSON.stringify({ verify: result }));
    if (!result.ok) process.exit(1);
  }
} finally {
  await pg.pool.end();
}
