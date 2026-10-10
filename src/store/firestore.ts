import { FirestoreError, type FirestoreFn } from "../security.js";
import {
  type Store, type StoreCollection, type StoreDoc, type StoreFields,
  newId, tsNumOf,
} from "./types.js";

function docIdOf(name: string): string {
  const i = name.lastIndexOf("/");
  return i >= 0 ? decodeURIComponent(name.slice(i + 1)) : name;
}

function fromFs(collection: StoreCollection, raw: { name?: string; fields?: StoreFields }): StoreDoc {
  const fields = raw.fields ?? {};
  return { id: docIdOf(raw.name ?? ""), collection, fields, tsNum: tsNumOf(fields) };
}

const is404 = (e: unknown) => e instanceof FirestoreError && e.status === 404;

/** Firestore REST adapter. Same document JSON the bridge already writes. */
export function createFirestoreStore(fs: FirestoreFn): Store {
  return {
    async get(collection, id) {
      try {
        const raw = await fs(`/${collection}/${encodeURIComponent(id)}`, { method: "GET" });
        return fromFs(collection, raw);
      } catch (e) {
        if (is404(e)) return null;
        throw e;
      }
    },
    async create(collection, fields, id) {
      const documentId = id || newId();
      const raw = await fs(`/${collection}`, {
        method: "POST", body: { fields }, documentId,
      });
      return fromFs(collection, raw?.name ? raw : { name: `${collection}/${documentId}`, fields });
    },
    async upsert(collection, id, fields) {
      await fs(`/${collection}/${encodeURIComponent(id)}`, {
        method: "PATCH", body: { fields },
      });
      return { id, collection, fields, tsNum: tsNumOf(fields) };
    },
    async patch(collection, id, fields) {
      await fs(`/${collection}/${encodeURIComponent(id)}`, {
        method: "PATCH", body: { fields }, updateMask: Object.keys(fields),
      });
      const cur = await this.get(collection, id);
      return cur ?? { id, collection, fields, tsNum: tsNumOf(fields) };
    },
    async remove(collection, id) {
      try {
        await fs(`/${collection}/${encodeURIComponent(id)}`, { method: "DELETE" });
        return true;
      } catch (e) {
        if (is404(e)) return false;
        throw e;
      }
    },
    async listNewest(collection, limit) {
      const cap = Math.max(1, Math.min(limit, 200));
      const data = await fs(`/${collection}`, { method: "GET", pageSize: cap });
      const docs = ((data?.documents ?? []) as Array<{ name?: string; fields?: StoreFields }>)
        .map((d) => fromFs(collection, d));
      docs.sort((a, b) => (b.tsNum ?? 0) - (a.tsNum ?? 0));
      return docs.slice(0, cap);
    },
    async close() { /* REST: nothing to close */ },
  };
}
