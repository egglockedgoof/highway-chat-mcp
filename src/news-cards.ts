// Evolving feed: one card per storyId. A new development prepends a line;
// it never becomes a second card. Price cards expire 48h after the last quote.
// Plays expire when their catalyst date has passed; benefits after their deadline.
// No Firestore — this book lives in process memory next to the existing news cache.

import { resolveNote, storyId, type EditorialNotes, type MoneyNote, type StoryFacts } from "./money-notes.js";

export type CardKind = "price" | "play" | "benefit" | "story";

export interface NewsCard {
  id: string;
  title: string;
  url: string;
  source: string;
  image: string;
  publishedAt: string | null;
  unconfirmed: boolean;
  kind: CardKind;
  lines: { at: number; title: string }[];
  expiresAt: number | null;
  note: MoneyNote | null;
  facts?: StoryFacts;
}

const HOUR = 3600000;
export const PRICE_TTL_MS = 48 * HOUR;

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

export function kindOf(title: string, facts?: StoryFacts): CardKind {
  if (facts?.price !== undefined || facts?.pct !== undefined) return "price";
  const t = title.toLowerCase();
  if (/\b(deadline|expire|cutoff|apply by|benefits? end|must (?:apply|file|claim))\b/.test(t)) return "benefit";
  if (/\b(ahead of|pending|awaiting|before (?:the )?(?:fed|fomc|cpi|jobs|earnings))\b/.test(t)) return "play";
  return "story";
}

export function parseTitleDate(title: string, nowMs: number): number | null {
  const t = title.toLowerCase();
  const named = t.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (named) {
    const w = named[1];
    if (w === "today" || w === "tonight") return nowMs;
    if (w === "tomorrow") return nowMs + 24 * HOUR;
    const want = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(w);
    const cur = new Date(nowMs).getUTCDay();
    const add = (want - cur + 7) % 7 || 7;
    return nowMs + add * 24 * HOUR;
  }
  const m = t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,\s*(\d{4}))?\b/);
  if (!m) return null;
  const month = MONTHS[m[1]];
  const day = Number(m[2]);
  const year = m[3] ? Number(m[3]) : new Date(nowMs).getUTCFullYear();
  if (month === undefined || day < 1 || day > 31) return null;
  return Date.UTC(year, month, day);
}

export function expiresAt(kind: CardKind, title: string, nowMs: number): number | null {
  if (kind === "price") return nowMs + PRICE_TTL_MS;
  if (kind === "benefit" || kind === "play") return parseTitleDate(title, nowMs);
  return null;
}

export function mergeCard(prev: NewsCard | undefined, incoming: NewsCard, nowMs: number): NewsCard {
  if (!prev) return incoming;
  const lines = incoming.title !== prev.title
    ? [{ at: nowMs, title: incoming.title }, ...prev.lines].slice(0, 8)
    : prev.lines;
  const exp = incoming.kind === "price" ? nowMs + PRICE_TTL_MS : incoming.expiresAt;
  return { ...incoming, lines, expiresAt: exp, url: incoming.url || prev.url };
}

export function createCardBook(now: () => number = Date.now) {
  const cards = new Map<string, NewsCard>();
  return {
    ingest(incoming: NewsCard[]): NewsCard[] {
      const t = now();
      const out: NewsCard[] = [];
      const seen = new Set<string>();
      for (const it of incoming) {
        const next = mergeCard(cards.get(it.id), it, t);
        if (next.expiresAt !== null && t >= next.expiresAt) { cards.delete(it.id); continue; }
        cards.set(it.id, next);
        if (!seen.has(it.id)) { seen.add(it.id); out.push(next); }
      }
      for (const [id, c] of cards) {
        if (c.expiresAt !== null && t >= c.expiresAt) cards.delete(id);
      }
      if (cards.size > 64) {
        for (const id of cards.keys()) {
          if (cards.size <= 64) break;
          if (!seen.has(id)) cards.delete(id);
        }
      }
      return out;
    },
    get(id: string): NewsCard | undefined { return cards.get(id); },
    size(): number { return cards.size; },
  };
}

export type CardBook = ReturnType<typeof createCardBook>;

export function publicCard(card: NewsCard) {
  const note = card.note && card.note.storyId === card.id ? card.note : null;
  return {
    id: card.id,
    title: card.title,
    url: card.url,
    source: card.source,
    image: card.image || "",
    description: note?.body ?? "",
    publishedAt: card.publishedAt,
    unconfirmed: card.unconfirmed,
    kind: card.kind,
    lines: card.lines,
    note,
  };
}

export function presentItem(
  raw: { title: string; url: string; source: string; image?: string; publishedAt?: string | null; facts?: StoryFacts },
  editorial: EditorialNotes | null,
  nowMs: number = Date.now(),
): NewsCard {
  const id = storyId(raw.title, raw.source, nowMs);
  const unconfirmed = !raw.publishedAt && !raw.facts;
  const note = resolveNote({
    id, title: raw.title, url: raw.url, source: raw.source,
    publishedAt: raw.publishedAt ?? null, unconfirmed, facts: raw.facts,
  }, editorial);
  const kind = kindOf(raw.title, raw.facts);
  return {
    id, title: raw.title, url: raw.url, source: raw.source, image: raw.image ?? "",
    publishedAt: raw.publishedAt ?? null, unconfirmed, kind,
    lines: [], expiresAt: expiresAt(kind, raw.title, nowMs), note, facts: raw.facts,
  };
}
