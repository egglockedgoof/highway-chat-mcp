import type { FirestoreFn } from "../security.js";
import { createFirestoreStore } from "./firestore.js";
import { createPostgresStore, postgresPool } from "./postgres.js";
import type { Store } from "./types.js";

export {
  STORE_COLLECTIONS, isStoreCollection, tsNumOf, type Store, type StoreCollection,
  type StoreDoc, type StoreFields,
} from "./types.js";
export { createFirestoreStore } from "./firestore.js";
export { createPostgresStore, postgresPool } from "./postgres.js";

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

/**
 * Build a store. Live Highway must keep STORE_BACKEND=firestore (or unset)
 * until dual-write is proven. Postgres without DATABASE_URL throws.
 */
export function createStore(opts: {
  backend?: StoreBackend;
  databaseUrl?: string;
  firestore?: FirestoreFn;
}): Store {
  const backend = opts.backend ?? storeBackend();
  if (backend === "postgres") {
    const url = opts.databaseUrl ?? process.env.DATABASE_URL ?? "";
    if (!url.trim()) throw new Error("STORE_BACKEND=postgres requires DATABASE_URL");
    return createPostgresStore(postgresPool(url));
  }
  if (!opts.firestore) throw new Error("firestore store requires a FirestoreFn");
  return createFirestoreStore(opts.firestore);
}
