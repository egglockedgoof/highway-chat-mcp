// Read cache + read meter in front of the firestore() choke point.
//
// Firestore bills one read per document returned (minimum one per request) and the Spark
// project shares 50k/day across the widget and every bridge caller. Agents poll the same
// queries in loops, so identical reads inside a short window are served from memory, and
// concurrent identical reads share one request.
//
// Cached: :runQuery, :runAggregationQuery, collection list GETs. Never cached: single-doc
// GETs — mutateDoc/writeIdempotent read updateTime for preconditions and must see fresh data.
// Entries are partitioned by caller identity so a cache hit never crosses the gate's
// per-caller resolution. A write through this wrapper drops every entry for that collection;
// writes from other clients (the widget) are bounded by the TTL.
//
// Budget: once the bridge has metered `budget` reads in the current quota day (Pacific,
// matching Firestore's reset), and also whenever Firestore answers RESOURCE_EXHAUSTED,
// cached reads fall back to the last stored result regardless of age. With no stored result
// the request fails with 429 read-budget instead of spending more quota.

import { FirestoreError, UserError, isWriteRequest } from './security.js';
import type { FirestoreFn, FirestoreInit } from './security.js';

export interface ReadCacheOpts {
  ttlMs: number;
  budget: number; // 0 = unmetered (no budget enforcement)
  maxEntries: number;
  identity: () => string;
  now?: () => number;
  onBudgetCrossed?: (day: string, reads: number, budget: number) => void;
}

export interface ReadMeterSnapshot {
  day: string;
  reads: number;
  budget: number;
  overBudget: boolean;
  cache: { hits: number; misses: number; stale: number; shared: number; entries: number };
  byCaller: Record<string, number>;
}

interface Entry { at: number; value: unknown; collection: string }

const QUERY_PATHS = new Set([':runQuery', ':runAggregationQuery']);

const pacificDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function quotaDay(ms: number): string { return pacificDay.format(ms); }

export function collectionOf(path: string, body: unknown): string | null {
  if (QUERY_PATHS.has(path)) {
    const b = body as any;
    const q = b?.structuredQuery ?? b?.structuredAggregationQuery?.structuredQuery;
    return q?.from?.[0]?.collectionId ?? null;
  }
  const m = /^\/([^/]+)(?:\/|$)/.exec(path);
  return m ? m[1] : null;
}

export function isCacheable(path: string, init: FirestoreInit): boolean {
  if (QUERY_PATHS.has(path)) return init.method === 'POST';
  return init.method === 'GET' && /^\/[^/]+$/.test(path);
}

// Billed reads for a response: one per document, minimum one per request.
export function billedReads(path: string, value: unknown): number {
  if (path === ':runQuery') {
    const rows = Array.isArray(value) ? value.filter((r: any) => r?.document).length : 0;
    return Math.max(1, rows);
  }
  if (path === ':runAggregationQuery') return 1;
  const docs = (value as any)?.documents;
  return Math.max(1, Array.isArray(docs) ? docs.length : 1);
}

const isQuotaError = (e: unknown): boolean =>
  e instanceof FirestoreError && (e.status === 429 || e.code === 'RESOURCE_EXHAUSTED');

export function createReadCache(inner: FirestoreFn, o: ReadCacheOpts) {
  const now = o.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<unknown>>();
  const stats = { hits: 0, misses: 0, stale: 0, shared: 0 };
  let day = quotaDay(now());
  let reads = 0;
  let alerted = false;
  let byCaller = new Map<string, number>();

  const rollDay = () => {
    const d = quotaDay(now());
    if (d !== day) { day = d; reads = 0; alerted = false; byCaller = new Map(); }
  };
  const meter = (caller: string, n: number) => {
    rollDay();
    reads += n;
    byCaller.set(caller, (byCaller.get(caller) ?? 0) + n);
    if (o.budget > 0 && !alerted && reads >= o.budget) {
      alerted = true;
      o.onBudgetCrossed?.(day, reads, o.budget);
    }
  };
  const overBudget = () => { rollDay(); return o.budget > 0 && reads >= o.budget; };
  const store = (key: string, value: unknown, collection: string) => {
    entries.delete(key);
    entries.set(key, { at: now(), value, collection });
    while (entries.size > o.maxEntries) entries.delete(entries.keys().next().value!);
  };
  const invalidate = (collection: string | null) => {
    if (!collection) { entries.clear(); return; }
    for (const [k, e] of entries) if (e.collection === collection) entries.delete(k);
  };

  const firestore: FirestoreFn = async (path, init) => {
    const caller = o.identity();
    if (isWriteRequest(init.method, path)) {
      try { return await inner(path, init); }
      finally { invalidate(collectionOf(path, init.body)); }
    }
    if (!isCacheable(path, init)) {
      const value = await inner(path, init);
      meter(caller, billedReads(path, value));
      return value;
    }

    const collection = collectionOf(path, init.body) ?? '';
    const key = JSON.stringify([caller, init.method, path, init.pageSize ?? null, init.body ?? null]);
    const hit = entries.get(key);
    if (hit && now() - hit.at < o.ttlMs) { stats.hits++; return hit.value; }
    if (hit && overBudget()) { stats.stale++; return hit.value; }
    if (overBudget())
      throw new UserError('read-budget', 429, `bridge read budget spent for ${day} (${reads}/${o.budget}); retry after the quota day resets`);

    const pending = inflight.get(key);
    if (pending) { stats.shared++; return pending; }
    stats.misses++;
    const p = (async () => {
      try {
        const value = await inner(path, init);
        meter(caller, billedReads(path, value));
        store(key, value, collection);
        return value;
      } catch (e) {
        if (hit && isQuotaError(e)) { stats.stale++; return hit.value; }
        throw e;
      }
    })();
    inflight.set(key, p);
    try { return await p; }
    finally { inflight.delete(key); }
  };

  const snapshot = (): ReadMeterSnapshot => {
    rollDay();
    return {
      day, reads, budget: o.budget, overBudget: overBudget(),
      cache: { ...stats, entries: entries.size },
      byCaller: Object.fromEntries(byCaller),
    };
  };

  return { firestore, snapshot, invalidate };
}
