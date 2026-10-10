// Shared in-process buffer of the last N messages per channel.
// One incremental tsNum query refreshes the room for every bot; repeats cost zero
// Firestore reads until the TTL expires. Writes ingest locally so the author
// sees their own post without a round trip.

export interface CachedMessage {
  id: string;
  name: string;
  text: string;
  ts: number;
  attachments?: unknown[];
  audio?: string;
  audioType?: string;
  audioBytes?: number;
}

export const CHANNEL_CACHE_MAX = 100;
export const CHANNEL_CACHE_TTL_MS = 15_000;

export function mentionsName(text: string, who: string): boolean {
  const parts = who.trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!parts.length || !parts[0]) return false;
  const body = parts.join("[\\s_-]+");
  return new RegExp(`(?:^|[^\\w])@${body}\\b`, "i").test(text);
}

export function selectMessages(
  buf: readonly CachedMessage[],
  o: { limit: number; since_ts?: number; mention?: string },
): CachedMessage[] {
  let out = buf as CachedMessage[];
  if (o.since_ts !== undefined) out = out.filter((m) => m.ts > o.since_ts!);
  if (o.mention) out = out.filter((m) => mentionsName(m.text, o.mention!));
  return out.slice(0, o.limit);
}

export function mergeMessages(prev: readonly CachedMessage[], incoming: readonly CachedMessage[], max: number): CachedMessage[] {
  const map = new Map<string, CachedMessage>();
  for (const m of prev) map.set(m.id, m);
  for (const m of incoming) if (m.id) map.set(m.id, m);
  return [...map.values()].sort((a, b) => b.ts - a.ts).slice(0, max);
}

export interface ChannelCacheOpts {
  max?: number;
  ttlMs?: number;
  load: (channel: string, sinceTs: number | null, limit: number) => Promise<CachedMessage[]>;
  now?: () => number;
  /** Incremental arrivals only (not the first fill). Covers widget writes on the next refresh. */
  onNew?: (channel: string, incoming: CachedMessage[]) => void;
}

export function createChannelCache(o: ChannelCacheOpts) {
  const max = o.max ?? CHANNEL_CACHE_MAX;
  const ttlMs = o.ttlMs ?? CHANNEL_CACHE_TTL_MS;
  const now = o.now ?? Date.now;
  const rooms = new Map<string, { at: number; items: CachedMessage[] }>();
  const inflight = new Map<string, Promise<CachedMessage[]>>();

  const newestTs = (items: CachedMessage[]): number | null => {
    let n = 0;
    for (const m of items) if (m.ts > n) n = m.ts;
    return n || null;
  };

  async function refresh(channel: string): Promise<CachedMessage[]> {
    const pending = inflight.get(channel);
    if (pending) return pending;
    const p = (async () => {
      const cur = rooms.get(channel);
      const since = cur?.items.length ? newestTs(cur.items) : null;
      const incoming = await o.load(channel, since, cur?.items.length ? 32 : max);
      const items = mergeMessages(cur?.items ?? [], incoming, max);
      rooms.set(channel, { at: now(), items });
      if (since != null && incoming.length) o.onNew?.(channel, incoming);
      return items;
    })().finally(() => { inflight.delete(channel); });
    inflight.set(channel, p);
    return p;
  }

  return {
    async read(channel: string, q: { limit: number; since_ts?: number; mention?: string }): Promise<CachedMessage[]> {
      const cur = rooms.get(channel);
      const items = !cur || now() - cur.at >= ttlMs ? await refresh(channel) : cur.items;
      return selectMessages(items, q);
    },
    ingest(channel: string, msg: CachedMessage): void {
      const cur = rooms.get(channel);
      rooms.set(channel, { at: cur?.at ?? now(), items: mergeMessages(cur?.items ?? [], [msg], max) });
      o.onNew?.(channel, [msg]);
    },
    peek(channel: string): CachedMessage[] {
      return rooms.get(channel)?.items ?? [];
    },
    size(channel: string): number {
      return rooms.get(channel)?.items.length ?? 0;
    },
  };
}

export type ChannelCache = ReturnType<typeof createChannelCache>;
