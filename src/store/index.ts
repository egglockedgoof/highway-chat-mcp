import type { FirestoreFn } from "../security.js";
import { createFirestoreStore } from "./firestore.js";
import { createPostgresStore, dbSchema, postgresPool } from "./postgres.js";
import type { Store, StoreCollection, StoreFields } from "./types.js";

export {
  STORE_COLLECTIONS, isStoreCollection, tsNumOf, type Store, type StoreCollection,
  type StoreDoc, type StoreFields,
} from "./types.js";
export { createFirestoreStore } from "./firestore.js";
export {
  createPostgresStore, postgresPool, connectPostgres, probeDb, currentDbHealth,
  startDbProbe, stopDbProbe, dbHostOf, pgTargets, dbSchema, POOL_MAX,
} from "./postgres.js";
export type { DbHealth, PgSource } from "./postgres.js";

export type StoreBackend = "firestore" | "postgres";

/** Default firestore. postgres only when STORE_BACKEND=postgres and DATABASE_URL is set. */
export function storeBackend(env: NodeJS.ProcessEnv = process.env): StoreBackend {
  const v = (env.STORE_BACKEND ?? "firestore").trim().toLowerCase();
  return v === "postgres" ? "postgres" : "firestore";
}

/** Dual-write is off unless STORE_DUAL_WRITE=1. Never implied by DATABASE_URL alone. */
export function dualWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STORE_DUAL_WRITE === "1";
}

/** Comma-separated collections that read from Postgres. Empty = no read flip. */
export function readPgCollections(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.READ_PG_COLLECTIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

export function readsFromPg(collection: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readPgCollections(env).has(collection);
}

function databaseUrlOf(opts: { databaseUrl?: string }, env: NodeJS.ProcessEnv = process.env): string {
  return (opts.databaseUrl ?? env.DATABASE_URL ?? env.DATABASE_URL_FALLBACK ?? "").trim();
}

/**
 * Primary writes must succeed. Secondary failures are logged and ignored.
 * Reads stay on primary until a flagged read flip.
 */
export function createDualWriteStore(primary: Store, secondary: Store): Store {
  const shadow = async (op: string, fn: () => Promise<unknown>) => {
    try { await fn(); }
    catch (e) {
      console.warn(`dual-write ${op} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    get: (c, id) => primary.get(c, id),
    listNewest: (c, n) => primary.listNewest(c, n),
    async create(c: StoreCollection, fields: StoreFields, id?: string) {
      const doc = await primary.create(c, fields, id);
      await shadow("create", () => secondary.create(c, fields, doc.id));
      return doc;
    },
    async upsert(c, id, fields) {
      const doc = await primary.upsert(c, id, fields);
      await shadow("upsert", () => secondary.upsert(c, id, fields));
      return doc;
    },
    async patch(c, id, fields) {
      const doc = await primary.patch(c, id, fields);
      await shadow("patch", () => secondary.patch(c, id, fields));
      return doc;
    },
    async remove(c, id) {
      const ok = await primary.remove(c, id);
      await shadow("remove", () => secondary.remove(c, id));
      return ok;
    },
    async close() {
      await shadow("close", () => secondary.close());
      await primary.close();
    },
  };
}

/**
 * Build a store. Live Highway must keep STORE_BACKEND=firestore (or unset)
 * until dual-write is proven. Postgres without DATABASE_URL throws.
 * Dual-write wrap is available here. MCP/site read flip is READ_PG_COLLECTIONS (default empty).
 */
export function createStore(opts: {
  backend?: StoreBackend;
  databaseUrl?: string;
  firestore?: FirestoreFn;
  dualWrite?: boolean;
}): Store {
  const backend = opts.backend ?? storeBackend();
  const schema = dbSchema();
  const url = databaseUrlOf(opts);
  let primary: Store;
  if (backend === "postgres") {
    if (!url) throw new Error("STORE_BACKEND=postgres requires DATABASE_URL");
    primary = createPostgresStore(postgresPool(url, schema), schema);
  } else {
    if (!opts.firestore) throw new Error("firestore store requires a FirestoreFn");
    primary = createFirestoreStore(opts.firestore);
  }
  const dual = opts.dualWrite ?? dualWriteEnabled();
  if (!dual || backend === "postgres") return primary;
  if (!url) throw new Error("STORE_DUAL_WRITE=1 requires DATABASE_URL");
  return createDualWriteStore(primary, createPostgresStore(postgresPool(url, schema), schema));
}
