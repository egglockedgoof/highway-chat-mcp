// Session-start continuity handshake.
//
// Knows what it knows, and says so when it doesn't. Targeted recalls — not the
// whole room. One dead lane degrades; a down brain returns a cached snapshot
// marked stale, or a bounded failure. Never fabricates a mission.
//
// Firestore is an optional extra for open work. If it fails, that fact is
// recorded and no tasks are invented. LAST_ORIENT is stamped only after a
// fresh, successful assemble — recovery must not duplicate that write.

import type { MemoryKind, RecallQuery } from "./brain.js";

export interface Hit {
  id: string;
  score: number;
  text: string;
  kind: string;
  author: string;
  verified: boolean;
  ts: number;
  tags: string[];
}

export type Lane = "mission" | "constraints" | "open" | "failures" | "you";
export type Freshness = "live" | "cached" | "unavailable";

export interface Conflict {
  topic: string;
  ids: string[];
  texts: string[];
}

export interface Briefing {
  ok: boolean;
  author: string;
  freshness: Freshness;
  stale: boolean;
  age_ms: number | null;
  last_session_ms: number | null;
  new_since: number;
  lanes: Record<Lane, Hit[]>;
  superseded: Hit[];
  conflicts: Conflict[];
  degraded: Lane[];
  failed: string[];
  stamped: boolean;
  next: string;
}

export const sessionMarkerId = (author: string): string =>
  `session:${author.trim().toLowerCase()}`;

export const sessionMarkerText = (ms: number): string => `LAST_ORIENT ${ms}`;

export function parseLastOrient(text: string | undefined): number | null {
  const m = /^LAST_ORIENT (\d+)$/.exec((text ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const isSuperseded = (h: Hit): boolean =>
  h.tags.includes("superseded") || /^SUPERSEDED:/i.test(h.text.trim());

export const topicOf = (h: Hit): string | null => {
  const t = h.tags.find((x) => x.startsWith("topic:"));
  return t ? t.slice(6) || null : null;
};

export function partitionMission(hits: Hit[]): { active: Hit[]; superseded: Hit[]; conflicts: Conflict[] } {
  const superseded = hits.filter(isSuperseded);
  const active = hits.filter((h) => !isSuperseded(h));
  const byTopic = new Map<string, Hit[]>();
  for (const h of active) {
    const t = topicOf(h);
    if (!t) continue;
    const g = byTopic.get(t) ?? [];
    g.push(h);
    byTopic.set(t, g);
  }
  const conflicts: Conflict[] = [];
  for (const [topic, group] of byTopic) {
    if (group.length < 2) continue;
    conflicts.push({ topic, ids: group.map((h) => h.id), texts: group.map((h) => h.text) });
  }
  return { active, superseded, conflicts };
}

export const LANES: Record<Lane, Omit<RecallQuery, "author">> = {
  mission: { query: "current Highway mission direction next evolution locked decisions", kind: "decision" as MemoryKind, topK: 5, verifiedOnly: true },
  constraints: { query: "constraints do not pay Blaze do not turn off legacy path security", kind: "lesson" as MemoryKind, topK: 5 },
  open: { query: "unresolved work measurement meter quota next task", kind: "idea" as MemoryKind, topK: 4 },
  failures: { query: "what failed what we reverted do not repeat", kind: "lesson" as MemoryKind, topK: 4 },
  you: { query: "your role responsibilities next task", topK: 4 },
};

export type Search = (q: RecallQuery) => Promise<Hit[]>;
export type Get = (id: string) => Promise<Hit | null>;

const unique = (hits: Hit[]): Hit[] => {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const h of hits.sort((a, b) => b.score - a.score)) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(h);
  }
  return out;
};

const emptyLanes = (): Record<Lane, Hit[]> =>
  ({ mission: [], constraints: [], open: [], failures: [], you: [] });

const failClosed = (author: string, failed: string[], next: string): Briefing => ({
  ok: false, author, freshness: "unavailable", stale: false, age_ms: null,
  last_session_ms: null, new_since: 0, lanes: emptyLanes(),
  superseded: [], conflicts: [], degraded: ["mission", "constraints", "open", "failures", "you"],
  failed, stamped: false, next,
});

export async function assemble(
  search: Search,
  o: { author: string; sinceMs?: number; get?: Get },
): Promise<Briefing> {
  const author = o.author.trim() || "unknown";
  const degraded: Lane[] = [];
  let last: number | null = o.sinceMs ?? null;

  if (last === null && o.get) {
    try { last = parseLastOrient((await o.get(sessionMarkerId(author)))?.text); }
    catch { /* marker miss is not a degraded lane */ }
  }

  const lanes = emptyLanes();
  await Promise.all((Object.keys(LANES) as Lane[]).map(async (lane) => {
    try {
      const q = LANES[lane];
      const hits = await search({
        ...q,
        ...(lane === "you" ? { author } : {}),
      });
      lanes[lane] = unique(hits.map((h) => ({ ...h, tags: h.tags ?? [] }))).slice(0, q.topK);
    } catch {
      lanes[lane] = [];
      degraded.push(lane);
    }
  }));

  const { active, superseded, conflicts } = partitionMission(lanes.mission);
  lanes.mission = active;

  const all = Object.values(lanes).flat();
  const new_since = last === null ? 0 : all.filter((h) => h.ts > last).length;
  const empty = all.length === 0 && superseded.length === 0;
  const next = empty
    ? "Brain returned no continuity. Ask before inventing the mission, constraints, or next task."
    : conflicts.length
      ? `Conflicts on ${conflicts.map((c) => c.topic).join(", ")} — do not pick a winner. Ask.`
      : last === null
        ? "First session on record. Read the briefing before acting; do not invent extra constraints."
        : new_since === 0
          ? "Nothing new since your last session. Continue from the briefing; do not re-litigate locked decisions."
          : `${new_since} memories are newer than your last session — read those first.`;

  return {
    ok: !empty && degraded.length < Object.keys(LANES).length,
    author,
    freshness: "live",
    stale: false,
    age_ms: 0,
    last_session_ms: last,
    new_since,
    lanes,
    superseded,
    conflicts,
    degraded,
    failed: [],
    stamped: false,
    next,
  };
}

export function markStale(b: Briefing, ageMs: number): Briefing {
  return {
    ...b,
    freshness: "cached",
    stale: true,
    age_ms: ageMs,
    stamped: false,
    next: `Cached briefing, potentially stale (${Math.round(ageMs / 1000)}s old). ${b.next}`,
  };
}

export function createOrientCache(ttlMs = 10 * 60 * 1000, now: () => number = Date.now) {
  const store = new Map<string, { at: number; briefing: Briefing }>();
  const key = (author: string) => author.trim().toLowerCase();
  return {
    put(author: string, briefing: Briefing) {
      if (!briefing.ok || briefing.stale) return;
      store.set(key(author), { at: now(), briefing: { ...briefing, stamped: false } });
    },
    take(author: string): { briefing: Briefing; ageMs: number } | null {
      const e = store.get(key(author));
      if (!e) return null;
      const ageMs = now() - e.at;
      if (ageMs > ttlMs) { store.delete(key(author)); return null; }
      return { briefing: e.briefing, ageMs };
    },
  };
}

export type OrientCache = ReturnType<typeof createOrientCache>;

export async function runOrient(
  deps: {
    search: Search;
    get?: Get;
    openFromStore?: () => Promise<Hit[]>;
    cache: OrientCache;
    stamp?: (author: string) => Promise<void>;
  },
  o: { author: string; sinceMs?: number },
): Promise<Briefing> {
  const author = o.author.trim() || "unknown";
  let live: Briefing | null = null;
  try {
    live = await assemble(deps.search, { author, sinceMs: o.sinceMs, get: deps.get });
  } catch {
    live = null;
  }

  if (!live || (live.degraded.length === Object.keys(LANES).length && !live.lanes.mission.length)) {
    const cached = deps.cache.take(author);
    if (cached) return markStale(cached.briefing, cached.ageMs);
    return live
      ? { ...live, freshness: "unavailable", failed: [...live.failed, "brain"], stamped: false,
          next: "Brain unavailable and no cached briefing. Ask before inventing the mission, constraints, or next task." }
      : failClosed(author, ["brain"],
        "Brain unavailable and no cached briefing. Ask before inventing the mission, constraints, or next task.");
  }
  if (!live.ok) return { ...live, stamped: false };

  if (deps.openFromStore) {
    try {
      const extra = await deps.openFromStore();
      live.lanes.open = unique([...live.lanes.open, ...extra]).slice(0, 8);
    } catch (e) {
      live.failed = [...live.failed, "firestore"];
      live.next = `${live.next} Open-work store failed (${e instanceof Error ? e.message : "error"}); no tasks were invented.`;
    }
  }

  deps.cache.put(author, live);
  let stamped = false;
  if (deps.stamp && live.ok && !live.stale) {
    try { await deps.stamp(author); stamped = true; }
    catch { live.failed = [...live.failed, "stamp"]; }
  }
  return { ...live, stamped };
}
