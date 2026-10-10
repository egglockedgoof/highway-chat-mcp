import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadCache, billedReads, collectionOf, isCacheable, quotaDay } from "../dist/read-cache.js";
import { FirestoreError, UserError } from "../dist/security.js";

const q = (collectionId: string, limit = 10) => ({
  method: "POST", body: { structuredQuery: { from: [{ collectionId }], limit } },
});
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ document: { name: `d${i}` } }));

function harness(opts: Partial<{ ttlMs: number; budget: number; maxEntries: number }> = {}) {
  let t = Date.parse("2026-10-10T12:00:00Z");
  let who = "header_bound:nyx";
  const calls: string[] = [];
  let respond: (path: string, init: any) => unknown = () => rows(3);
  const crossed: number[] = [];
  const rc = createReadCache(async (path, init) => { calls.push(`${init.method} ${path}`); return respond(path, init); }, {
    ttlMs: opts.ttlMs ?? 15000, budget: opts.budget ?? 0, maxEntries: opts.maxEntries ?? 50,
    identity: () => who, now: () => t, onBudgetCrossed: (_d, r) => crossed.push(r),
  });
  return {
    rc, calls, crossed,
    tick: (ms: number) => { t += ms; },
    as: (w: string) => { who = w; },
    respondWith: (f: typeof respond) => { respond = f; },
  };
}

test("identical query inside TTL is served from cache; expires after TTL", async () => {
  const h = harness();
  await h.rc.firestore(":runQuery", q("highway_messages"));
  await h.rc.firestore(":runQuery", q("highway_messages"));
  assert.equal(h.calls.length, 1);
  h.tick(15001);
  await h.rc.firestore(":runQuery", q("highway_messages"));
  assert.equal(h.calls.length, 2);
  assert.equal(h.rc.snapshot().cache.hits, 1);
});

test("concurrent identical reads share one request", async () => {
  const h = harness();
  await Promise.all([1, 2, 3].map(() => h.rc.firestore(":runQuery", q("highway_tasks"))));
  assert.equal(h.calls.length, 1);
  assert.equal(h.rc.snapshot().cache.shared, 2);
});

test("cache is partitioned by caller identity", async () => {
  const h = harness();
  await h.rc.firestore(":runQuery", q("highway_messages"));
  h.as("path_legacy:grok");
  await h.rc.firestore(":runQuery", q("highway_messages"));
  assert.equal(h.calls.length, 2);
});

test("single-doc GETs bypass the cache but are metered", async () => {
  const h = harness();
  h.respondWith(() => ({ name: "x", fields: {} }));
  await h.rc.firestore("/highway_notes/shared", { method: "GET" });
  await h.rc.firestore("/highway_notes/shared", { method: "GET" });
  assert.equal(h.calls.length, 2);
  assert.equal(h.rc.snapshot().reads, 2);
});

test("a write drops cached entries for that collection only", async () => {
  const h = harness();
  await h.rc.firestore(":runQuery", q("highway_messages"));
  await h.rc.firestore(":runQuery", q("highway_tasks"));
  h.respondWith(() => ({}));
  await h.rc.firestore("/highway_messages", { method: "POST", body: { fields: {} } });
  h.respondWith(() => rows(1));
  await h.rc.firestore(":runQuery", q("highway_messages"));
  await h.rc.firestore(":runQuery", q("highway_tasks"));
  assert.deepEqual(h.calls, ["POST :runQuery", "POST :runQuery", "POST /highway_messages", "POST :runQuery"]);
});

test("meters billed reads per caller", async () => {
  const h = harness();
  await h.rc.firestore(":runQuery", q("a"));
  h.as("header_bound:hollow");
  h.respondWith(() => []);
  await h.rc.firestore(":runQuery", q("b"));
  const s = h.rc.snapshot();
  assert.equal(s.reads, 4);
  assert.deepEqual(s.byCaller, { "header_bound:nyx": 3, "header_bound:hollow": 1 });
});

test("over budget: stale entry is served, uncached read fails with 429, alert fires once", async () => {
  const h = harness({ budget: 5 });
  await h.rc.firestore(":runQuery", q("a")); // 3
  await h.rc.firestore(":runQuery", q("b")); // 6 → crossed
  assert.deepEqual(h.crossed, [6]);
  h.tick(60000);
  assert.deepEqual(await h.rc.firestore(":runQuery", q("a")), rows(3));
  assert.equal(h.calls.length, 2);
  await assert.rejects(h.rc.firestore(":runQuery", q("c")),
    (e: unknown) => e instanceof UserError && e.status === 429 && e.code === "read-budget");
  assert.equal(h.rc.snapshot().cache.stale, 1);
  assert.deepEqual(h.crossed, [6]);
});

test("budget resets on the next Pacific quota day", async () => {
  const h = harness({ budget: 3 });
  await h.rc.firestore(":runQuery", q("a"));
  assert.equal(h.rc.snapshot().overBudget, true);
  h.tick(24 * 3600 * 1000);
  assert.equal(h.rc.snapshot().overBudget, false);
  assert.equal(h.rc.snapshot().reads, 0);
});

test("RESOURCE_EXHAUSTED falls back to the last stored result", async () => {
  const h = harness();
  await h.rc.firestore(":runQuery", q("a"));
  h.tick(20000);
  h.respondWith(() => { throw new FirestoreError(429, "RESOURCE_EXHAUSTED", "Quota exceeded."); });
  assert.deepEqual(await h.rc.firestore(":runQuery", q("a")), rows(3));
  await assert.rejects(h.rc.firestore(":runQuery", q("never-cached")), FirestoreError);
});

test("non-quota errors propagate even when a stale entry exists", async () => {
  const h = harness();
  await h.rc.firestore(":runQuery", q("a"));
  h.tick(20000);
  h.respondWith(() => { throw new FirestoreError(403, "PERMISSION_DENIED", "no"); });
  await assert.rejects(h.rc.firestore(":runQuery", q("a")), FirestoreError);
});

test("LRU bound evicts the oldest entry", async () => {
  const h = harness({ maxEntries: 2 });
  for (const c of ["a", "b", "c"]) await h.rc.firestore(":runQuery", q(c));
  await h.rc.firestore(":runQuery", q("a"));
  assert.equal(h.calls.length, 4);
  assert.equal(h.rc.snapshot().cache.entries, 2);
});

test("helpers: collection, cacheability, billing, quota day", () => {
  assert.equal(collectionOf(":runQuery", q("x").body), "x");
  assert.equal(collectionOf(":runAggregationQuery",
    { structuredAggregationQuery: { structuredQuery: { from: [{ collectionId: "y" }] } } }), "y");
  assert.equal(collectionOf("/highway_tasks/abc", undefined), "highway_tasks");
  assert.equal(isCacheable("/highway_presence", { method: "GET" }), true);
  assert.equal(isCacheable("/highway_presence/me", { method: "GET" }), false);
  assert.equal(billedReads(":runQuery", []), 1);
  assert.equal(billedReads(":runQuery", rows(7)), 7);
  assert.equal(billedReads("/c", { documents: [{}, {}] }), 2);
  assert.equal(quotaDay(Date.parse("2026-10-10T06:59:00Z")), "2026-10-09");
  assert.equal(quotaDay(Date.parse("2026-10-10T07:01:00Z")), "2026-10-10");
});
