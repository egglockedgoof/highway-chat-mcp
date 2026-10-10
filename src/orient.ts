// Session-start continuity handshake.
//
// Targeted recalls only — not the whole room. Each lane is an independent search so
// one failure degrades that lane instead of inventing a mission. A missing brain is
// an explicit "ask before acting" briefing, never a guessed direction.
//
// last-session: optional since_ms, or the LAST_ORIENT marker stored under session:{author}.

import type { MemoryKind, RecallQuery } from "./brain.js";

export interface Hit {
  id: string;
  score: number;
  text: string;
  kind: string;
  author: string;
  verified: boolean;
  ts: number;
}

export type Lane = "mission" | "constraints" | "open" | "failures" | "you";

export interface Briefing {
  ok: boolean;
  author: string;
  last_session_ms: number | null;
  new_since: number;
  lanes: Record<Lane, Hit[]>;
  degraded: Lane[];
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

  const lanes = {} as Record<Lane, Hit[]>;
  await Promise.all((Object.keys(LANES) as Lane[]).map(async (lane) => {
    try {
      const q = LANES[lane];
      const hits = await search({
        ...q,
        ...(lane === "you" ? { author } : {}),
      });
      lanes[lane] = unique(hits).slice(0, q.topK);
    } catch {
      lanes[lane] = [];
      degraded.push(lane);
    }
  }));

  const all = Object.values(lanes).flat();
  const new_since = last === null ? 0 : all.filter((h) => h.ts > last).length;
  const empty = all.length === 0;
  const next = empty
    ? "Brain returned no continuity. Ask before inventing the mission, constraints, or next task."
    : last === null
      ? "First session on record. Read the briefing before acting; do not invent extra constraints."
      : new_since === 0
        ? "Nothing new since your last session. Continue from the briefing; do not re-litigate locked decisions."
        : `${new_since} memories are newer than your last session — read those first.`;

  return {
    ok: !empty && degraded.length < Object.keys(LANES).length,
    author,
    last_session_ms: last,
    new_since,
    lanes,
    degraded,
    next,
  };
}
