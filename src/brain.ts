// Shared brain: one semantic memory every agent writes to and recalls from.
//
// Backed by a Pinecone index with integrated embedding (llama-text-embed-v2): records are
// sent as text and Pinecone embeds them on write and on search, so the bridge carries no
// embedding code or model key. Memory reads never touch Firestore's daily read quota.
//
// Authorship: callers on a bound token are recorded as themselves with verified=true.
// Callers on the legacy path name themselves, recorded verified=false, so recall can
// prefer memories whose author is proven.

import { createHash } from "node:crypto";

export const MEMORY_KINDS = [
  "fact", "decision", "lesson", "preference", "correction", "idea", "milestone", "pattern", "episode",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Memory {
  id: string;
  text: string;
  kind: MemoryKind;
  author: string;
  verified: boolean;
  ts: number;
  source: string;
  tags: string[];
}

export interface RecallQuery {
  query: string;
  topK: number;
  kind?: MemoryKind;
  author?: string;
  verifiedOnly?: boolean;
}

export interface BrainDeps {
  apiKey: () => string | undefined;
  indexName: string;
  namespace: string;
  request: (url: string, init: { method: string; headers: Record<string, string>; body?: string })
    => Promise<{ status: number; body: string }>;
  now?: () => number;
}

const API_VERSION = "2025-04";
// Pinecone caps integrated-embedding upserts at 96 records per request.
export const UPSERT_BATCH = 96;

export class BrainError extends Error {
  constructor(message: string, readonly status = 502) { super(message); this.name = "BrainError"; }
}

export function memoryId(author: string, kind: string, text: string): string {
  const h = createHash("sha256").update(`${author.toLowerCase()}\n${kind}\n${text.trim()}`).digest("hex");
  return `${kind}:${h.slice(0, 32)}`;
}

export function cleanTags(tags: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const t of tags ?? []) {
    const v = t.trim().toLowerCase().slice(0, 40);
    if (v) out.add(v);
    if (out.size >= 8) break;
  }
  return [...out];
}

export function buildFilter(q: RecallQuery): Record<string, unknown> | undefined {
  const f: Record<string, unknown> = {};
  if (q.kind) f.kind = { $eq: q.kind };
  if (q.author) f.author = { $eq: q.author };
  if (q.verifiedOnly) f.verified = { $eq: true };
  return Object.keys(f).length ? f : undefined;
}

export const EPISODE_MIN_CHARS = 20;
export const EPISODE_MAX_CHARS = 2000;

// Room messages become episode memories. Ids derive from the message doc id, so
// re-dreaming the same window overwrites instead of duplicating.
export function episodesFrom(
  msgs: readonly { id: string; name: string; text: string; ts: number | null }[],
  channel: string,
  sinceMs: number,
): Omit<Memory, "tags">[] {
  const out: Omit<Memory, "tags">[] = [];
  for (const m of msgs) {
    const text = m.text.trim();
    if (!m.name || text.length < EPISODE_MIN_CHARS || (m.ts ?? 0) < sinceMs) continue;
    out.push({
      id: `episode:${channel}:${m.id}`,
      text: `${m.name}: ${text}`.slice(0, EPISODE_MAX_CHARS),
      kind: "episode", author: m.name, verified: false, ts: m.ts!, source: channel,
    });
  }
  return out;
}

const FIELDS = ["text", "kind", "author", "verified", "ts", "source", "tags"];

export function createBrain(deps: BrainDeps) {
  const now = deps.now ?? Date.now;
  let host: string | null = null;

  const headers = (contentType: string): Record<string, string> => {
    const key = deps.apiKey();
    if (!key) throw new BrainError("PINECONE_API_KEY not configured", 503);
    return { "Api-Key": key, "X-Pinecone-API-Version": API_VERSION, "Content-Type": contentType };
  };
  const call = async (url: string, method: string, contentType: string, body?: string) => {
    const r = await deps.request(url, { method, headers: headers(contentType), body });
    if (r.status >= 400) {
      let msg = r.body.slice(0, 200);
      try { const j = JSON.parse(r.body); msg = j?.error?.message ?? j?.message ?? msg; } catch { /* raw text */ }
      throw new BrainError(`pinecone ${method} ${r.status}: ${msg}`, r.status === 429 ? 429 : 502);
    }
    return r.body ? JSON.parse(r.body) : {};
  };
  const indexHost = async (): Promise<string> => {
    if (host) return host;
    const d = await call(`https://api.pinecone.io/indexes/${encodeURIComponent(deps.indexName)}`, "GET", "application/json");
    if (!d?.host) throw new BrainError(`pinecone index "${deps.indexName}" has no host`);
    host = String(d.host);
    return host;
  };
  const ns = () => encodeURIComponent(deps.namespace);

  async function upsert(memories: readonly Memory[]): Promise<number> {
    if (!memories.length) return 0;
    const h = await indexHost();
    for (let i = 0; i < memories.length; i += UPSERT_BATCH) {
      const ndjson = memories.slice(i, i + UPSERT_BATCH)
        .map(({ id, ...rest }) => JSON.stringify({ _id: id, ...rest })).join("\n");
      await call(`https://${h}/records/namespaces/${ns()}/upsert`, "POST", "application/x-ndjson", ndjson);
    }
    return memories.length;
  }

  function memory(m: Omit<Memory, "id" | "ts" | "tags"> & { id?: string; ts?: number; tags?: readonly string[] }): Memory {
    const text = m.text.trim();
    return {
      id: m.id ?? memoryId(m.author, m.kind, text),
      text, kind: m.kind, author: m.author, verified: m.verified,
      ts: m.ts ?? now(), source: m.source, tags: cleanTags(m.tags),
    };
  }

  async function recall(q: RecallQuery) {
    const h = await indexHost();
    const filter = buildFilter(q);
    const data = await call(`https://${h}/records/namespaces/${ns()}/search`, "POST", "application/json",
      JSON.stringify({ query: { inputs: { text: q.query }, top_k: q.topK, ...(filter ? { filter } : {}) }, fields: FIELDS }));
    const hits: any[] = data?.result?.hits ?? [];
    return hits.map((hit) => {
      const f = hit.fields ?? {};
      return {
        id: String(hit._id), score: Number(hit._score ?? 0), text: String(f.text ?? ""),
        kind: String(f.kind ?? ""), author: String(f.author ?? ""), verified: f.verified === true,
        ts: Number(f.ts ?? 0), source: String(f.source ?? ""), tags: Array.isArray(f.tags) ? f.tags.map(String) : [],
      };
    });
  }

  async function get(id: string) {
    const h = await indexHost();
    const data = await call(
      `https://${h}/vectors/fetch?ids=${encodeURIComponent(id)}&namespace=${ns()}`,
      "GET", "application/json");
    const v = data?.vectors?.[id];
    if (!v) return null;
    const f = v.metadata ?? {};
    return {
      id: String(v.id ?? id), score: 1, text: String(f.text ?? ""),
      kind: String(f.kind ?? ""), author: String(f.author ?? ""), verified: f.verified === true,
      ts: Number(f.ts ?? 0), source: String(f.source ?? ""), tags: Array.isArray(f.tags) ? f.tags.map(String) : [],
    };
  }

  return { upsert, recall, get, memory };
}

export type Brain = ReturnType<typeof createBrain>;
