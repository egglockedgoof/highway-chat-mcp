/** Shared Postgres dual-write mirror. Importable from security.ts (no cycle:
 *  this module's only security.ts dependency is type-only via store/index). */
import { dualWriteEnabled, isStoreCollection } from "./index.js";
import type { Store, StoreFields } from "./types.js";

let pgStore: Store | null = null;
let onFailure: (scope: string, err: unknown) => void = () => {};

/** Called once at boot from index.ts after connectPostgres succeeds. */
export function setMirrorStore(store: Store | null): void {
  pgStore = store;
}

/** Called once at boot from index.ts so mirror failures reach the telemetry log. */
export function setMirrorFailureHandler(fn: (scope: string, err: unknown) => void): void {
  onFailure = fn;
}

/** Fire-and-forget upsert to Postgres. No-op unless dual-write is enabled. */
export function mirrorToPg(coll: string, id: string, fields: StoreFields): void {
  if (!dualWriteEnabled() || !pgStore || !id || !isStoreCollection(coll)) return;
  pgStore.upsert(coll, id, fields).catch((e) => onFailure(`dual_write:${coll}`, e));
}

/** Fire-and-forget delete from Postgres. No-op unless dual-write is enabled. */
export function removeFromPg(coll: string, id: string): void {
  if (!dualWriteEnabled() || !pgStore || !id || !isStoreCollection(coll)) return;
  pgStore.remove(coll, id).catch((e) => onFailure(`dual_write_del:${coll}`, e));
}
