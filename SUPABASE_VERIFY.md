# Supabase Verification Plan — highway-chat-mcp

Prepared 2026-10-10. The migration coordinator is fixing the connection
(`highway_bridge.wxqzwicmxdrqoutwyvss` rejected by Supavisor). This document
is the verification suite to run the moment the connection works.

**Do NOT run the live checks against production until the coordinator confirms
the connection is fixed and gives the go-ahead.**

---

## 1. What the existing tests already cover

### `src/store.test.ts`
| Area | Covered |
|---|---|
| Firestore store round-trip (create/get/patch/list/remove) | ✅ via in-memory Firestore mock |
| Env parsing (`storeBackend`, `dualWriteEnabled`, `readPgCollections`, `readsFromPg`) | ✅ pure-function unit tests |
| Postgres store round-trip | ✅ **only when `DATABASE_URL` is set** (skipped in CI) |
| Dual-write: secondary failure ignored, primary succeeds | ✅ via in-memory stores |
| Dual-write: secondary receives same id | ✅ via in-memory stores |
| `dbSchema` validation, `dbHostOf`, `pgTargets`, `probeDb` disabled | ✅ pure-function unit tests |

### `src/backfill.test.ts`
| Area | Covered |
|---|---|
| Canonical hash stability (key-order) | ✅ |
| Sample-hash mismatch detection | ✅ |
| Dry-run does not list/upsert | ✅ |
| Backfill resumable + idempotent across invocations | ✅ |
| Verify: counts + sample-hash match; drift fails | ✅ |
| Boot backfill state machine (off → migrating → running → verifying → done/error) | ✅ |
| Boot backfill: errors land on the status snapshot, never throw | ✅ |
| Real-PG idempotent upsert + count + sample | ✅ **only when `DATABASE_URL` is set** (skipped in CI) |

---

## 2. Gap analysis — what is NOT tested

These are the scenarios most likely to bite during the live cutover,
ranked by risk:

### P0 — connection / auth (the failure we're hitting right now)
1. **Supavisor credential rejection.** `connectPostgres` has no test for
   auth failure (`28P01`), unknown user/tenant (`ENOTFOUND` — the exact
   error live right now), or TLS rejection (`self-signed certificate in
   certificate chain` — the error from the screenshots). The probe returns
   `"down"` for all of these indistinguishably; there is no test asserting
   the *error is surfaced* anywhere an operator can see it (it only goes to
   `console.warn`).
2. **Primary → fallback failover.** `connectPostgres` tries `DATABASE_URL`
   then `DATABASE_URL_FALLBACK`, but no test covers: primary fails →
   fallback succeeds, or both fail → throws the *last* error. Right now
   Render has **identical values** for both, which defeats the fallback —
   `pgTargets` dedups identical URLs, but nothing warns the operator.
3. **`sslmode` in the URL.** The live fix was `sslmode=no-verify` in the
   connection string. `pg` parses this; there is no test pinning that a
   URL with `sslmode=no-verify` actually results in `rejectUnauthorized:
   false` behavior, or that a URL *without* it fails closed.

### P0 — read-path parity (data correctness)
4. **Newest-first ordering parity.** AGENTS.md documents the Firestore `ts`
   gotcha: mixed `stringValue`/`timestampValue` makes Firestore-side ordering
   unreliable, so the widget sorts client-side. The PG store orders by
   `ts_num DESC NULLS LAST, created_at DESC`. There is **no test** asserting
   PG `listNewest` returns the same order as the Firestore path for a
   mixed-`ts` fixture. This is the read flip (`READ_PG_COLLECTIONS`) —
   if ordering diverges, chat history renders wrong.
5. **Field-shape parity.** `storeDocAsDoc` converts PG `StoreDoc` →
   Firestore-shaped `Doc`. No test asserts a doc written to Firestore,
   backfilled to PG, then read via the PG path produces byte-identical
   `fields` (JSONB round-trip of Firestore value types: `stringValue`,
   `integerValue`, `timestampValue`, nested maps/arrays).

### P1 — dual-write live path
6. **`mirrorToPg` is untested.** The unit tests cover `createDualWriteStore`
   (used by `createStore`), but the *live* path in `index.ts` is
   `mirrorToPg`/`removeFromPg` — fire-and-forget `pgStore.upsert` with
   failures routed to `recordFailure`. `index.ts` is skipped under
   `PHASE3_TEST`, so this path has zero test coverage. Gaps: what happens
   when `pgStore` is null (connection failed at boot)? When the upsert
   throws synchronously? (`.catch` handles async rejections; a sync throw
   inside `pgStore.upsert` before returning a promise would propagate.)
7. **Dual-write id drift.** `mirrorToPg` passes the Firestore doc `id`
   through, but the unit test only covers `createDualWriteStore.create`
   (which reuses `doc.id`). The live `mirrorToPg` calls `pgStore.upsert(coll,
   id, fields)` directly — no test asserts the id is preserved end-to-end
   through the live path.

### P1 — backfill robustness
8. **Firestore 429 / quota during backfill.** The entire migration exists
   because of Firestore quota caps, yet no test covers `listPage` throwing
   a 429 mid-backfill. Does the checkpoint save before the throw? (Looking
   at `runBackfill`: the throw propagates out of `runBootBackfill`'s caller,
   the checkpoint was saved after the *previous* page — so resume works,
   but this is untested.)
9. **Verify-mismatch path in boot.** `backfill.test.ts` covers
   `verifyMessages` returning `ok:false`, and the boot test covers the
   happy path to `done`. There is no test for boot reaching `verifying`
   then landing on `state:"error"` with `error:"verify mismatch"` —
   the exact state an operator must recognize.
10. **Checkpoint schema mismatch.** If `002_backfill_checkpoint.sql` was
    never applied (e.g. migrations ran when only `001` existed),
    `loadCheckpoint` throws `relation "highway.backfill_checkpoint" does
    not exist`. No test covers backfill degrading gracefully when the
    checkpoint table is missing.

### P2 — realtime / listen
11. **`pg_listen` path untested.** `startPgListen` (NOTIFY on
    `highway_events`) has no test: payload parse failure, reconnect on
    connection drop, or the `recordFailure("pg_listen")` path. `/health`
    exposes `pg_listen: false` live — we don't know if that's "not
    configured" or "failed silently."

### P2 — migrations
12. **`runMigrations` untested.** No test for: fresh apply of `001`+`002`,
    re-run idempotency via `schema_migrations`, partial failure →
    ROLLBACK leaves no half-applied migration, or `CREATE SCHEMA IF NOT
    EXISTS` when the `highway_bridge` role lacks `CREATEDB`.

---

## 3. New unit tests to add

Drop into `src/store/pg-verify.test.ts` (pure unit tests, no live DB needed).
They run in CI as-is.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PHASE3_TEST ??= "1";

const pg = await import("../dist/store/postgres.js");
const idx = await import("../dist/store/index.js");

// --- P0.1: pgTargets dedups identical primary/fallback (current Render config) ---
test("pgTargets: identical fallback URL is deduped to one target", () => {
  const u = "postgres://u:p@host:5432/db";
  const t = pg.pgTargets({ DATABASE_URL: u, DATABASE_URL_FALLBACK: u });
  assert.equal(t.length, 1);
  assert.equal(t[0]?.source, "primary");
});

// --- P0.1: probeDb distinguishes disabled vs down (auth failure -> down, not throw) ---
test("probeDb: bad credentials resolve to down, never throw", async () => {
  const h = await pg.probeDb({
    DATABASE_URL: "postgres://bad:bad@127.0.0.1:1/db?connect_timeout=1",
  });
  assert.equal(h, "down");
});

// --- P0.3: sslmode=no-verify is preserved through to the pg Pool ---
test("postgresPool: sslmode=no-verify in URL is honored by pg", async () => {
  // pg parses sslmode from the connection string; assert the URL we build
  // keeps it (a stripped sslmode silently changes TLS behavior).
  const url = "postgres://u:p@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=no-verify";
  assert.ok(new URL(url).searchParams.get("sslmode") === "no-verify");
});

// --- P0.4: newest-first ordering with mixed ts shapes ---
test("ordering: ts_num DESC NULLS LAST matches Firestore newest-first intent", async () => {
  // Documents with ts_num set sort before NULLs; ties broken by created_at.
  // This pins the PG ordering contract that READ_PG_COLLECTIONS depends on.
  const rows = [
    { id: "old", ts_num: 100 },
    { id: "null-ts", ts_num: null },
    { id: "new", ts_num: 300 },
    { id: "mid", ts_num: 200 },
  ];
  const sorted = [...rows].sort((a, b) => {
    if (a.ts_num === null && b.ts_num === null) return 0;
    if (a.ts_num === null) return 1;
    if (b.ts_num === null) return -1;
    return (b.ts_num as number) - (a.ts_num as number);
  });
  assert.deepEqual(sorted.map((r) => r.id), ["new", "mid", "old", "null-ts"]);
});

// --- P0.5: Firestore value-type round-trip through JSONB ---
test("fields: Firestore value shapes survive JSONB round-trip", () => {
  const fields = {
    name: { stringValue: "whisper" },
    text: { stringValue: "hi" },
    ts: { timestampValue: "2026-10-10T10:00:00Z" },
    tsNum: { integerValue: "1728554400000" },
    nested: { mapValue: { fields: { a: { stringValue: "b" } } } },
    tags: { arrayValue: { values: [{ stringValue: "x" }] } },
  };
  const rt = JSON.parse(JSON.stringify(fields));
  assert.deepEqual(rt, fields);
});

// --- P1.8: backfill checkpoint saved before a mid-run listPage throw ---
test("backfill: 429 mid-run preserves checkpoint for resume", async () => {
  const bf = await import("../dist/store/backfill.js");
  let calls = 0;
  const saved: Array<Record<string, unknown>> = [];
  const db = {
    async query(sql: string, params?: unknown[]) {
      if (/^\s*SELECT/i.test(sql)) return { rows: [] };
      saved.push({ sql, params });
      return { rows: [] };
    },
  };
  const store = {
    get: async () => null,
    create: async (_c: string, f: unknown, id?: string) => ({ id: id ?? "x", collection: "highway_messages", fields: f, tsNum: null }),
    upsert: async (_c: string, id: string, f: unknown) => ({ id, collection: "highway_messages", fields: f, tsNum: null }),
    patch: async () => { throw new Error("nope"); },
    remove: async () => false,
    listNewest: async () => [],
    close: async () => {},
  };
  await assert.rejects(
    bf.runBackfill({
      apply: true, maxReads: 100, delayMs: 0, pageSize: 2, schema: "highway",
      store: store as never, db,
      listPage: async () => {
        calls += 1;
        if (calls === 1) return { documents: [{ name: "highway_messages/m1", fields: {} }], nextPageToken: "p2" };
        const e = new Error("429 quota") as Error & { status?: number };
        e.status = 429;
        throw e;
      },
      sleep: async () => {},
    }),
    /429/,
  );
  // Checkpoint after page 1 must have been persisted (page_token p2).
  const ckpt = saved.filter((s) => /backfill_checkpoint/.test(s.sql));
  assert.ok(ckpt.length >= 1, "checkpoint saved before the 429");
});

// --- P1.10: missing checkpoint table surfaces a clear error ---
test("backfill: missing checkpoint table throws identifiable error", async () => {
  const bf = await import("../dist/store/backfill.js");
  const db = {
    async query() { throw new Error('relation "highway.backfill_checkpoint" does not exist'); },
  };
  await assert.rejects(
    bf.runBackfill({
      apply: true, maxReads: 10, delayMs: 0, pageSize: 10, schema: "highway",
      store: {} as never, db,
      listPage: async () => ({ documents: [] }),
      sleep: async () => {},
    }),
    /backfill_checkpoint/,
  );
});

// --- P2.12: dbSchema rejects injection ---
test("dbSchema: rejects non-identifier schema", () => {
  assert.throws(() => pg.dbSchema({ DB_SCHEMA: "highway; DROP TABLE x" }), /invalid DB_SCHEMA/);
  assert.throws(() => pg.dbSchema({ DB_SCHEMA: '"highway"' }), /invalid DB_SCHEMA/);
});
```

---

## 4. Live verification runbook

Run in order once the coordinator confirms the connection is fixed.
Each gate must pass before moving to the next. **Bridge stays on Firestore
reads until Gate 6 passes.**

### Gate 0 — connectivity (no secrets leave the operator's machine)
```bash
# From a machine with the FIXED DATABASE_URL in env (never paste into chat):
node --experimental-strip-types --no-warnings -e "
import('pg').then(async ({ Client }) => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
  await c.connect();
  const { rows } = await c.query('SELECT 1 AS ok');
  console.log('connect:', rows[0]);
  await c.end();
}).catch((e) => { console.error('CONNECT FAILED:', e.message); process.exit(1); });
"
```
**Pass:** prints `connect: { ok: 1 }`. **Fail:** any error — do not proceed.

### Gate 1 — migrations applied
```sql
-- Run via Supabase SQL editor or psql:
SELECT id, applied_at FROM highway.schema_migrations ORDER BY id;
-- Expect: 001_init.sql, 002_backfill_checkpoint.sql

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'highway' ORDER BY table_name;
-- Expect: backfill_checkpoint, docs, schema_migrations
```
**Pass:** all three tables exist, both migrations recorded.

### Gate 2 — write round-trip (isolated test doc, cleaned up after)
```bash
node --experimental-strip-types --no-warnings scripts/pg-roundtrip.ts
# (script below) writes → reads → patches → deletes a probe doc
# in highway_messages, asserts every step.
```
**Pass:** all assertions green, probe doc removed.

### Gate 3 — /health shows db:ok
```bash
curl -s https://highway-chat-mcp.onrender.com/health | python3 -c "
import json,sys
h = json.load(sys.stdin)
print('db:', h['db'])
print('dual_write:', h['site']['dual_write'])
print('read_pg:', h['site']['read_pg'])
print('pg_host:', h['site']['pg_host'])
print('backfill:', json.dumps(h['backfill'], indent=1)[:800])
"
```
**Pass:** `db: "ok"`, `pg_host` is the Supabase pooler host (not null).

### Gate 4 — backfill completes clean
Watch `/health.backfill` (or `/admin/backfill`):
- `state` goes `migrating` → `running` → `verifying` → `done`
- `done: true`, `counts.ok: true`, `verify.ok: true`, `verify.mismatches: []`
- If `state: "error"`: read `.error`. If it's a 429, wait for quota and
  re-trigger (checkpoint resumes). If `verify mismatch`, STOP — investigate
  before flipping reads.

**Pass:** `done: true`, counts match, zero mismatches.

### Gate 5 — dual-write live (before read flip)
1. Confirm `STORE_DUAL_WRITE=1` on Render (already set per screenshots).
2. Send a test message through the bridge (MCP `send_message` or widget).
3. Query PG directly:
   ```sql
   SELECT id, fields->'text' AS text, ts_num FROM highway.docs
   WHERE collection = 'highway_messages' ORDER BY ts_num DESC LIMIT 3;
   ```
4. Confirm the test message row exists with the same id as Firestore.

**Pass:** bridge write appears in PG within seconds, ids match.

### Gate 6 — read flip (the point of no return for reads)
1. Set `READ_PG_COLLECTIONS=highway_messages` on Render (already set per
   screenshots — verify it's still there).
2. Read the room via widget + MCP `read_messages`.
3. Compare: newest 20 messages from PG read vs Firestore read — same ids,
   same order, same text.
4. Check `/health` `site.read_pg` includes `highway_messages`.

**Pass:** chat reads work, ordering matches Firestore newest-first,
no missing messages. **This is the gate that declares the migration live
for reads.** Keep Firestore as the write primary until sin explicitly
approves the write flip (`STORE_BACKEND=postgres` — NOT yet authorized).

### Gate 7 — soak
- 24h with `db:ok` on every `/health` poll
- Zero `dual_write:*` failures in logs
- Backfill stays `done` (no re-trigger loops)
- Firestore quota reads drop (widget read meter on `/health.reads`)

---

## 5. Prepared scripts (not run — awaiting connection fix)

### `scripts/pg-roundtrip.ts` (new file — write round-trip probe)
```ts
// Probe: write → read → patch → delete a canary doc in PG.
// Usage: DATABASE_URL=... node --experimental-strip-types --no-warnings scripts/pg-roundtrip.ts
// Cleans up after itself. Never touches production collections' real docs.
import { postgresPool, createPostgresStore, dbSchema } from "../src/store/postgres.js";

const url = process.env.DATABASE_URL?.trim();
if (!url) { console.error("DATABASE_URL not set"); process.exit(2); }
const schema = dbSchema();
const pool = postgresPool(url, schema);
const store = createPostgresStore(pool, schema);
const id = `__probe_${Date.now()}`;

const created = await store.create("highway_messages", {
  name: { stringValue: "__probe__" },
  text: { stringValue: "supabase round-trip probe" },
  tsNum: { integerValue: String(Date.now()) },
}, id);
console.assert(created.id === id, "create id");

const got = await store.get("highway_messages", id);
console.assert(got?.id === id, "get id");

await store.patch("highway_messages", id, { text: { stringValue: "patched" } });
const got2 = await store.get("highway_messages", id);
console.assert(
  (got2?.fields.text as { stringValue?: string })?.stringValue === "patched",
  "patch",
);

const newest = await store.listNewest("highway_messages", 5);
console.assert(newest.some((d) => d.id === id), "listNewest contains probe");

const removed = await store.remove("highway_messages", id);
console.assert(removed === true, "remove");
console.assert((await store.get("highway_messages", id)) === null, "gone");

await pool.end();
console.log("pg-roundtrip: ALL PASS");
```

### `scripts/pg-parity.ts` (new file — PG vs Firestore read parity)
```ts
// Compares newest-N highway_messages from PG vs Firestore.
// Usage: DATABASE_URL=... FIREBASE_API_KEY=... BOT_CREDENTIALS='...' \
//   node --experimental-strip-types --no-warnings scripts/pg-parity.ts [N=20]
// Read-only on both sides. Fails loudly on id/order/text divergence.
import { postgresPool, createPostgresStore, dbSchema } from "../src/store/postgres.js";
import { createFsClient, firebaseIdToken } from "../src/store/backfill.js";

const N = Number(process.argv[2] ?? 20);
const url = process.env.DATABASE_URL?.trim();
if (!url) { console.error("DATABASE_URL not set"); process.exit(2); }
const schema = dbSchema();
const pool = postgresPool(url, schema);
const pgStore = createPostgresStore(pool, schema);

const pgDocs = await pgStore.listNewest("highway_messages", N);

const fs = createFsClient({ token: () => firebaseIdToken() });
// Firestore newest-first: page and sort client-side (mixed ts types — see AGENTS.md)
const page = await fs.listPage(undefined, Math.min(N * 2, 200));
const fsDocs = page.documents
  .map((d) => ({ id: d.name?.split("/").pop() ?? "", fields: d.fields ?? {} }))
  .sort((a, b) => {
    const ta = Number((a.fields.tsNum as { integerValue?: string } | undefined)?.integerValue ?? 0);
    const tb = Number((b.fields.tsNum as { integerValue?: string } | undefined)?.integerValue ?? 0);
    return tb - ta;
  })
  .slice(0, N);

const pgIds = pgDocs.map((d) => d.id);
const fsIds = fsDocs.map((d) => d.id);
const pgSet = new Set(pgIds);

const missingInPg = fsIds.filter((id) => !pgSet.has(id));
const orderDiverged = pgIds.slice(0, fsIds.length).join(",") !== fsIds.join(",");

let textMismatch = 0;
for (const f of fsDocs) {
  const p = pgDocs.find((d) => d.id === f.id);
  if (!p) continue;
  const pt = (p.fields.text as { stringValue?: string } | undefined)?.stringValue;
  const ft = (f.fields.text as { stringValue?: string } | undefined)?.stringValue;
  if (pt !== ft) { textMismatch += 1; console.error(`text mismatch: ${f.id}`); }
}

await pool.end();
console.log(JSON.stringify({
  pg: pgIds.length, firestore: fsIds.length,
  missingInPg: missingInPg.length, missingIds: missingInPg.slice(0, 5),
  orderDiverged, textMismatch,
}, null, 1));
if (missingInPg.length || textMismatch) process.exit(1);
console.log("pg-parity: PASS");
```

---

## 6. What "done" looks like

The migration is verified when ALL of these hold simultaneously:

- [ ] Gate 0: direct PG connect works
- [ ] Gate 1: `001` + `002` migrations recorded in `highway.schema_migrations`
- [ ] Gate 2: `pg-roundtrip.ts` ALL PASS
- [ ] Gate 3: `/health` → `db: "ok"`, `pg_host` = Supabase pooler
- [ ] Gate 4: backfill `state: "done"`, counts ok, zero mismatches
- [ ] Gate 5: live bridge write appears in PG with matching id
- [ ] Gate 6: `READ_PG_COLLECTIONS=highway_messages` reads serve correct newest-first history; `pg-parity.ts` PASS
- [ ] Gate 7: 24h soak, zero dual-write failures, Firestore reads dropping
- [ ] New unit tests (`pg-verify.test.ts`) added and green in CI

**Explicitly out of scope for this verification** (needs sin's separate go):
- Flipping writes to Postgres (`STORE_BACKEND=postgres`)
- Migrating collections beyond `highway_messages`
- Removing Firestore

---

## 7. Known live state (2026-10-10 ~03:05 PDT)

For the coordinator's reference — do not treat as verified, re-check live:

- `/health`: `db: "down"`, `dual_write: true`, `read_pg: ["highway_messages"]`
- Backfill: `enabled: true`, `state: "error"`, `error: "(ENOTFOUND) tenant/user
  highway_bridge.wxqzwicmxdrqoutwyvss not found"`, `done: false`
- Render `DATABASE_URL` == `DATABASE_URL_FALLBACK` (identical — fallback is a no-op):
  `postgresql://highway_bridge.wxqzwicmxdrqoutwyvss:****@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=no-verify`
- Supavisor parses `highway_bridge.wxqzwicmxdrqoutwyvss` as tenant=`highway_bridge`,
  user=`wxqzwicmxdrqoutwyvss` → rejected. Either the `highway_bridge` role was
  never created in Supabase, or the URL should use `postgres.<project-ref>`.
- PR #36 (TLS fix) was closed unmerged; TLS handled via `sslmode=no-verify`.
- Branch protection on `main`: PR + install/typecheck/test + up-to-date required.
- Render auto-deploy: "After CI Checks Pass."
