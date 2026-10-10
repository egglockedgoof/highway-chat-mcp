import { test } from "node:test";
import assert from "node:assert/strict";
import { FirestoreError } from "../dist/security.js";
import type { Store, StoreFields } from "../dist/store/types.js";

const { createFirestoreStore } = await import("../dist/store/firestore.js");
const { createPostgresStore, postgresPool } = await import("../dist/store/postgres.js");
const { createStore, dualWriteEnabled, storeBackend } = await import("../dist/store/index.js");

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
  const { fs } = memFs();
  assert.ok(createStore({ firestore: fs }));
  assert.throws(() => createStore({ backend: "postgres", databaseUrl: "" }), /DATABASE_URL/);
});

const url = process.env.DATABASE_URL?.trim();
test("postgres store: create/get/patch/list/remove", { skip: !url }, async () => {
  const pool = postgresPool(url!);
  await pool.query("DELETE FROM docs WHERE collection = $1", ["highway_messages"]);
  await roundTrip(createPostgresStore(pool), "pg");
});
