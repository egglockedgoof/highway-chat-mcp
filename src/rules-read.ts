// Bridge Firestore READ surface vs firestore.rules.
// Pure. Zero live reads. CI fails if a collection the bridge GETs has no `allow read`.

export const BRIDGE_READ_COLLECTIONS = [
  "highway_messages",
  "highway_code",
  "highway_dm",
  "highway_presence",
  "highway_activity",
  "highway_tasks",
  "highway_notes",
  "evolution_logs",
  "jarvis_memory",
  "system_config",
  "dispatch_locks",
  "approval_requests",
] as const;

export type BridgeReadCollection = (typeof BRIDGE_READ_COLLECTIONS)[number];

const COLLECTION_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** True when `match /{collection}/{id}` has `allow read` / `allow get` / `allow read, write`. */
export function matchAllowsRead(rules: string, collection: string): boolean {
  if (!rules.trim()) return false;
  if (!COLLECTION_RE.test(collection)) return false;
  const re = new RegExp(`match\\s+\\/${collection}\\/\\{[^}]+\\}`);
  const m = re.exec(rules);
  if (!m) return false;
  const slice = rules.slice(m.index, m.index + 2000);
  const next = slice.search(/\n\s*match\s+\//);
  const body = next === -1 ? slice : slice.slice(0, next);
  return /\ballow\s+(read\b|get\b|read\s*,\s*write\b)/.test(body);
}

/** Bridge read collections whose match block would deny a GET (missing or no allow read). */
export function deniedBridgeReads(rules: string): string[] {
  if (typeof rules !== "string" || !rules.trim()) return [...BRIDGE_READ_COLLECTIONS];
  return BRIDGE_READ_COLLECTIONS.filter((c) => !matchAllowsRead(rules, c));
}
