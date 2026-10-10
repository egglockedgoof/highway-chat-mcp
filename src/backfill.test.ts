import { test } from "node:test";
import assert from "node:assert/strict";

process.env.FIREBASE_API_KEY ??= "test-key";
process.env.MCP_SECRET ??= "test-secret";
process.env.HIGHWAY_CLIENT_KEY ??= "test-client-key";
process.env.BOT_CREDENTIALS ??= "{}";
process.env.PHASE3_TEST ??= "1";

const bf = await import("../dist/store/backfill.js");
const { createPostgresStore, postgresPool, dbSchema, countCollection, listSampleDocs } =
  await import("../dist/store/postgres.js");
import type { Store, StoreCollection, StoreDoc, StoreFields } from "../dist/store/types.js";

function memStore(): Store {
  const docs = new Map<string, StoreDoc>();
  const key = (c: string, id: string) => `${c}/${id}`;
  return {
    async get(c, id) { return docs.get(key(c, id)) ?? null; },
    async create(c, fields, id) {
      const doc = { id: id || "auto", collection: c, fields, tsNum: null };
      docs.set(key(c, doc.id), doc);
      return doc;
    },
    async upsert(c, id, fields) {
      const doc = { id, collection: c, fields, tsNum: null };
      docs.set(key(c, id), doc);
      return doc;
    },
    async patch(c, id, fields) {
      const cur = docs.get(key(c, id));
      if (!cur) throw new Error("missing");
      cur.fields = { ...cur.fields, ...fields };
      return cur;
    },
    async remove(c, id) { return docs.delete(key(c, id)); },
    async listNewest(c: StoreCollection, limit: number) {
      return [...docs.values()].filter((d) => d.collection === c).slice(0, limit);
    },
    async close() { /* mem */ },
  };
}

function ckptDb() {
  let row: Record<string, unknown> | null = null;
  return {
    async query(sql: string, params?: unknown[]) {
      if (/^\s*SELECT/i.test(sql)) return { rows: row ? [row] : [] };
      row = {
        collection: params?.[0],
        page_token: params?.[1],
        docs: params?.[2],
        reads: params?.[3],
        upserts: params?.[4],
        done: params?.[5],
        updated_at: new Date("2026-10-10T00:00:00Z"),
      };
      return { rows: [] };
    },
  };
}

test("canonical hash is key-order stable; sample hash mismatches on drift", () => {
  const a = { name: { stringValue: "x" }, tsNum: { integerValue: "1" } };
  const b = { tsNum: { integerValue: "1" }, name: { stringValue: "x" } };
  assert.equal(bf.fieldHash(a), bf.fieldHash(b));
  const h1 = bf.sampleHash([{ id: "m1", hash: bf.fieldHash(a) }]);
  const h2 = bf.sampleHash([{ id: "m1", hash: bf.fieldHash({ ...a, text: { stringValue: "no" } }) }]);
  assert.notEqual(h1, h2);
});

test("counts compare and read cap", () => {
  assert.equal(bf.compareCounts(10, 10).ok, true);
  assert.equal(bf.compareCounts(10, 9).delta, -1);
  assert.equal(bf.capReads(0), 200);
  assert.equal(bf.capReads(99999), 2000);
  assert.equal(bf.docIdOf("projects/p/documents/highway_messages/abc"), "abc");
});

test("dry run does not list or upsert", async () => {
  let listed = 0;
  const store = memStore();
  const cp = await bf.runBackfill({
    apply: false, maxReads: 50, delayMs: 0, pageSize: 10, schema: "highway",
    store, db: ckptDb(),
    listPage: async () => { listed += 1; return { documents: [{ name: "highway_messages/m1", fields: {} }] }; },
    sleep: async () => {},
  });
  assert.equal(listed, 0);
  assert.equal(cp.done, false);
  assert.equal(await store.get("highway_messages", "m1"), null);
});

test("apply is resumable and idempotent", async () => {
  const store = memStore();
  const db = ckptDb();
  const pages: bf.FsPage[] = [
    { documents: [{ name: "highway_messages/m1", fields: { text: { stringValue: "a" } } }], nextPageToken: "p2" },
    { documents: [{ name: "highway_messages/m2", fields: { text: { stringValue: "b" } } }] },
  ];
  let i = 0;
  const opts = {
    apply: true, maxReads: 1, delayMs: 0, pageSize: 1, schema: "highway",
    store, db,
    listPage: async () => pages[i++] ?? { documents: [] },
    sleep: async () => {},
    now: () => "t",
  };
  const first = await bf.runBackfill(opts);
  assert.equal(first.done, false);
  assert.equal(first.reads, 1);
  assert.equal((await store.get("highway_messages", "m1"))?.id, "m1");
  // Same per-run cap must continue from the saved pageToken (not stall on cumulative reads).
  const second = await bf.runBackfill(opts);
  assert.equal(second.done, true);
  assert.equal(second.reads, 2);
  assert.equal((await store.get("highway_messages", "m2"))?.id, "m2");
  i = 0;
  const again = await bf.runBackfill({ ...opts, maxReads: 10 });
  assert.equal(again.done, true);
  assert.equal(again.upserts, second.upserts);
});

test("verify: counts + sample-hash match; drift fails", async () => {
  const fields: StoreFields = { text: { stringValue: "hi" } };
  const pg = [{ id: "m1", fields }];
  const ok = await bf.verifyMessages({
    sample: 1,
    countFs: async () => 1,
    countPg: async () => 1,
    samplePg: async () => pg,
    getFs: async () => fields,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.sample.ok, true);
  const bad = await bf.verifyMessages({
    sample: 1,
    countFs: async () => 1,
    countPg: async () => 1,
    samplePg: async () => pg,
    getFs: async () => ({ text: { stringValue: "no" } }),
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.sample.mismatches, ["m1"]);
});

const url = process.env.DATABASE_URL?.trim();
const schema = dbSchema();
test("postgres: idempotent upsert then count + sample hash", { skip: !url }, async () => {
  const pool = postgresPool(url!, schema);
  await pool.query(`DELETE FROM ${schema}.docs WHERE collection = $1`, [bf.MESSAGES]);
  await pool.query(`DELETE FROM ${schema}.backfill_checkpoint WHERE collection = $1`, [bf.MESSAGES]);
  const store = createPostgresStore(pool, schema);
  const fields = { text: { stringValue: "pg" }, tsNum: { integerValue: "9" } };
  const db = {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params) as Promise<{ rows: Array<Record<string, unknown>> }>,
  };
  const page = { documents: [{ name: `${bf.MESSAGES}/p1`, fields }] };
  await bf.runBackfill({
    apply: true, maxReads: 10, delayMs: 0, pageSize: 10, schema, store, db,
    listPage: async () => page,
    sleep: async () => {},
  });
  await bf.runBackfill({
    apply: true, maxReads: 10, delayMs: 0, pageSize: 10, schema, store, db,
    listPage: async () => page,
    sleep: async () => {},
  });
  assert.equal(await countCollection(pool, bf.MESSAGES, schema), 1);
  const sample = await listSampleDocs(pool, bf.MESSAGES, 5, schema);
  assert.equal(sample[0]?.id, "p1");
  await pool.end();
});
