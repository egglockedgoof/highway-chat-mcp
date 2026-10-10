import { test } from "node:test";
import assert from "node:assert/strict";
import { FirestoreError } from "../dist/security.js";
import type { Store, StoreCollection, StoreDoc, StoreFields } from "../dist/store/types.js";

const { createFirestoreStore } = await import("../dist/store/firestore.js");
const { createPostgresStore, postgresPool, dbSchema, dbHostOf, pgTargets, probeDb, currentDbHealth, POOL_MAX } =
  await import("../dist/store/postgres.js");
const { createStore, createDualWriteStore, dualWriteEnabled, storeBackend, readPgCollections, readsFromPg } = await import("../dist/store/index.js");

function memFs() {
  const docs = new Map<string, { name: string; fields: StoreFields }>();
  const key = (path: string) => path.replace(/^\//, "");
  const fs = async (path: string, init: { method: string; body?: any; documentId?: string; pageSize?: number }) => {
    const k = key(path);
    if (init.method === "GET" && k.includes("/")) {
      const hit = docs.get(k);
      if (!hit) throw new FirestoreError(404, "NOT_FOUND", "missing");
      return hit;
    }
    if (init.method === "GET") {
      const prefix = k + "/";
      const documents = [...docs.values()].filter((d) => d.name.startsWith(prefix));
      return { documents };
    }
    if (init.method === "POST") {
      const id = init.documentId || "auto";
      const name = `${k}/${id}`;
      docs.set(name, { name, fields: { ...(init.body?.fields ?? {}) } });
      return docs.get(name);
    }
    if (init.method === "PATCH") {
      const cur = docs.get(k);
      if (!cur) throw new FirestoreError(404, "NOT_FOUND", "missing");
      cur.fields = { ...cur.fields, ...(init.body?.fields ?? {}) };
      return cur;
    }
    if (init.method === "DELETE") {
      if (!docs.has(k)) throw new FirestoreError(404, "NOT_FOUND", "missing");
      docs.delete(k);
      return {};
    }
    throw new Error(init.method);
  };
  return { fs };
}

const fields = (name: string, text: string, ts: number): StoreFields => ({
  name: { stringValue: name },
  text: { stringValue: text },
  tsNum: { integerValue: String(ts) },
});

const textOf = (d: { fields: StoreFields } | null) =>
  (d?.fields.text as { stringValue?: string } | undefined)?.stringValue;

async function roundTrip(store: Store, label: string) {
  const a = await store.create("highway_messages", fields("whisper", "hi", 100), "m1");
  assert.equal(a.id, "m1", label);
  assert.equal(textOf(await store.get("highway_messages", "m1")), "hi", label);
  await store.patch("highway_messages", "m1", { text: { stringValue: "yo" } });
  assert.equal(textOf(await store.get("highway_messages", "m1")), "yo", label);
  await store.create("highway_messages", fields("ember", "later", 200), "m2");
  const newest = await store.listNewest("highway_messages", 10);
  assert.equal(newest[0]?.id, "m2", label);
  assert.equal(await store.remove("highway_messages", "m1"), true, label);
  assert.equal(await store.get("highway_messages", "m1"), null, label);
  await store.close();
}

test("firestore store: create/get/patch/list/remove", async () => {
  const { fs } = memFs();
  await roundTrip(createFirestoreStore(fs), "fs");
});

test("createStore defaults to firestore; postgres without URL throws", () => {
  assert.equal(storeBackend({}), "firestore");
  assert.equal(storeBackend({ STORE_BACKEND: "postgres" }), "postgres");
  assert.equal(dualWriteEnabled({}), false);
  assert.equal(dualWriteEnabled({ STORE_DUAL_WRITE: "1" }), true);
  assert.deepEqual([...readPgCollections({})], []);
  assert.deepEqual([...readPgCollections({ READ_PG_COLLECTIONS: "highway_messages, highway_tasks" })], ["highway_messages", "highway_tasks"]);
  assert.equal(readsFromPg("highway_messages", {}), false);
  assert.equal(readsFromPg("highway_messages", { READ_PG_COLLECTIONS: "highway_messages" }), true);
  const { fs } = memFs();
  assert.ok(createStore({ firestore: fs }));
  assert.throws(() => createStore({ backend: "postgres", databaseUrl: "" }), /DATABASE_URL/);
  assert.throws(() => createStore({ firestore: fs, dualWrite: true, databaseUrl: "" }), /STORE_DUAL_WRITE/);
});

test("dbSchema, hosts, pool, probe, health", async () => {
  assert.equal(dbSchema({}), "highway");
  assert.equal(dbSchema({ DB_SCHEMA: "highway" }), "highway");
  assert.throws(() => dbSchema({ DB_SCHEMA: "highway;drop" }), /invalid DB_SCHEMA/);
  assert.equal(dbHostOf("postgres://u:p@aws-0-us-west-1.pooler.supabase.com:5432/postgres"), "aws-0-us-west-1.pooler.supabase.com");
  assert.equal(pgTargets({}).length, 0);
  assert.equal(pgTargets({ DATABASE_URL: "postgres://u:p@primary.example:5432/db" })[0]?.source, "primary");
  assert.equal(pgTargets({
    DATABASE_URL: "postgres://u:p@primary.example:5432/db",
    DATABASE_URL_FALLBACK: "postgres://u:p@fallback.example:5432/db",
  }).length, 2);
  assert.equal(POOL_MAX, 5);
  assert.equal(await probeDb({}), "disabled");
  assert.equal(currentDbHealth(), "disabled");
});

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

test("dual-write: primary succeeds; secondary failure is ignored", async () => {
  const primary = memStore();
  const boom: Store = {
    get: async () => null,
    create: async () => { throw new Error("pg down"); },
    upsert: async () => { throw new Error("pg down"); },
    patch: async () => { throw new Error("pg down"); },
    remove: async () => { throw new Error("pg down"); },
    listNewest: async () => [],
    close: async () => { throw new Error("pg down"); },
  };
  const store = createDualWriteStore(primary, boom);
  const doc = await store.create("highway_messages", { text: { stringValue: "hi" } }, "m1");
  assert.equal(doc.id, "m1");
  assert.equal((await store.get("highway_messages", "m1"))?.id, "m1");
  await store.close();
});

test("dual-write: secondary receives the same id", async () => {
  const primary = memStore();
  const secondary = memStore();
  const store = createDualWriteStore(primary, secondary);
  await store.create("highway_tasks", { text: { stringValue: "x" } }, "t1");
  assert.equal((await secondary.get("highway_tasks", "t1"))?.id, "t1");
  await store.remove("highway_tasks", "t1");
  assert.equal(await secondary.get("highway_tasks", "t1"), null);
  await store.close();
});

const url = process.env.DATABASE_URL?.trim();
const schema = dbSchema();
test("postgres store: create/get/patch/list/remove", { skip: !url }, async () => {
  const pool = postgresPool(url!, schema);
  await pool.query(`DELETE FROM ${schema}.docs WHERE collection = $1`, ["highway_messages"]);
  await roundTrip(createPostgresStore(pool, schema), "pg");
});
