/** Storage seam. Live Highway stays on Firestore until a flagged dual-write/read flip. */

export const STORE_COLLECTIONS = [
  "highway_messages",
  "highway_code",
  "highway_dm",
  "highway_tasks",
  "highway_notes",
  "highway_activity",
  "highway_presence",
  "dispatch_locks",
  "approval_requests",
  "system_config",
] as const;

export type StoreCollection = (typeof STORE_COLLECTIONS)[number];

export type StoreFields = Record<string, unknown>;

export type StoreDoc = {
  id: string;
  collection: StoreCollection;
  fields: StoreFields;
  tsNum: number | null;
};

export interface Store {
  get(collection: StoreCollection, id: string): Promise<StoreDoc | null>;
  create(collection: StoreCollection, fields: StoreFields, id?: string): Promise<StoreDoc>;
  upsert(collection: StoreCollection, id: string, fields: StoreFields): Promise<StoreDoc>;
  patch(collection: StoreCollection, id: string, fields: StoreFields): Promise<StoreDoc>;
  remove(collection: StoreCollection, id: string): Promise<boolean>;
  listNewest(collection: StoreCollection, limit: number): Promise<StoreDoc[]>;
  close(): Promise<void>;
}

export function isStoreCollection(v: string): v is StoreCollection {
  return (STORE_COLLECTIONS as readonly string[]).includes(v);
}

/** tsNum from Firestore-shaped fields, or null. */
export function tsNumOf(fields: StoreFields): number | null {
  const n = fields.tsNum as { integerValue?: string } | undefined;
  if (n?.integerValue !== undefined) {
    const v = Number(n.integerValue);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
