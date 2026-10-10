// Money notes are bound to a story by stable id, never by list position.
// An auto note is emitted only when THIS item carries a money fact (price, %,
// dollar amount, rate, or deadline). Generic "watch your wallet" copy is a miss.
// Unsourced odds and day-counts are not facts. Editorial notes from Overheard
// or last30days replace auto notes when their storyId matches.

export interface StoryFacts {
  price?: number;
  pct?: number;
  asOf?: string;
}

export interface Story {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  unconfirmed: boolean;
  facts?: StoryFacts;
}

export interface MoneyNote {
  storyId: string;
  body: string;
  source: string;
  wallet: string;
  action: string;
  publishedAt: string;
  unconfirmed: boolean;
}

export const EDITORS = new Set(["overheard", "last30days"]);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SERIES: Array<{ re: RegExp; key: string }> = [
  { re: /\bfed\b|fomc|powell/, key: "fed" },
  { re: /\bcpi\b|inflation print/, key: "cpi" },
  { re: /\bnfp\b|jobs report|nonfarm/, key: "nfp" },
  { re: /\bbitcoin\b|\bbtc\b/, key: "btc" },
  { re: /\bethereum\b|\beth\b/, key: "eth" },
  { re: /\bsolana\b|\bsol\b/, key: "sol" },
  { re: /\bvoo\b/, key: "voo" },
  { re: /s&p 500|\b\^gspc\b/, key: "spx" },
  { re: /\bnasdaq\b|\b\^ixic\b/, key: "ndx" },
  { re: /\bnvidia\b|\bnvda\b/, key: "nvda" },
  { re: /\btesla\b|\btsla\b/, key: "tsla" },
  { re: /\bsnap\b|\bebt\b/, key: "snap" },
];

const MONEY_ANGLE = /\b(rate|fed|inflation|cpi|mortgage|rent|tax|tariff|oil|gas|bitcoin|btc|stock|market|dollar|wage|snap|ebt|price|cutoff|deadline|benefit)\b/;
const UNSOURCED_ODDS = /\b(?:odds|chance|probabilit)\b|\b\d{1,3}%\s+(?:dem|gop|rep|chance|odds)\b|\b(?:dem|gop|house|senate)\s+odds\b/i;
const POLL_CITE = /\b(pew|reuters|ap-norc|fivethirtyeight|538|economist|yougov|gallup)\b/i;
const WAR_DAY = /\bday\s+\d{2,4}\b/i;

export function monthYear(ms: number = Date.now()): { month: string; year: string } {
  const d = new Date(ms);
  return { month: MONTHS[d.getUTCMonth()], year: String(d.getUTCFullYear()) };
}

export function storyId(title: string, source: string, nowMs: number = Date.now()): string {
  const t = title.toLowerCase();
  const { month, year } = monthYear(nowMs);
  for (const s of SERIES) if (s.re.test(t)) return `${s.key}-${month}-${year}`;
  const slug = t.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36);
  const h = Math.abs(hash32(`${title}\n${source}`)).toString(36);
  return `${slug || "story"}-${h}`;
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function attachNote<T extends { id: string }>(item: T, note: MoneyNote | null): T & { note: MoneyNote | null } {
  if (!note || note.storyId !== item.id) return { ...item, note: null };
  return { ...item, note };
}

const dollarIn = (title: string): string | null =>
  title.match(/\$\s?[\d,.]+(?:\s?(?:billion|million|k|bn|m))?/i)?.[0] ?? null;
const pctIn = (title: string): string | null =>
  title.match(/[-+]?\d+(?:\.\d+)?%/)?.[0] ?? null;
const dateIn = (title: string): string | null =>
  title.match(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/i)?.[0]
  ?? title.match(/\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[0]
  ?? null;

export function autoNote(story: Story): MoneyNote | null {
  const title = story.title.trim();
  if (!title) return null;
  if (WAR_DAY.test(title) && !MONEY_ANGLE.test(title.toLowerCase())) return null;
  if (UNSOURCED_ODDS.test(title) && !POLL_CITE.test(title)) return null;

  const facts = story.facts ?? {};
  const sourcedPct = facts.pct !== undefined ? `${facts.pct >= 0 ? "+" : ""}${facts.pct.toFixed(1)}%` : null;
  const sourcedPx = facts.price !== undefined ? money(facts.price) : null;
  const fromTitleDollar = dollarIn(title);
  const fromTitlePct = sourcedPct ? null : pctIn(title);
  const deadline = dateIn(title);
  const tl = title.toLowerCase();

  // A number in the title is only a fact if the item's own source is the citation
  // and the title has a money angle. Odds without a poll cite already returned.
  const fact =
    sourcedPx && sourcedPct ? `${sourcedPx} (${sourcedPct})`
    : sourcedPx ? sourcedPx
    : sourcedPct ? sourcedPct
    : fromTitleDollar && MONEY_ANGLE.test(tl) ? fromTitleDollar
    : fromTitlePct && MONEY_ANGLE.test(tl) ? fromTitlePct
    : deadline && /\b(deadline|expire|cutoff|benefits?|apply|until|by)\b/.test(tl) ? deadline
    : null;
  if (!fact) return null;
  if (!MONEY_ANGLE.test(tl) && facts.price === undefined && facts.pct === undefined) return null;

  const wallet = sourcedPx || fromTitleDollar
    ? `${sourcedPx || fromTitleDollar} on this print`
    : deadline && /\b(benefits?|snap|ebt|deadline|apply)\b/.test(tl)
      ? `deadline ${deadline}`
      : sourcedPct || fromTitlePct
        ? `${sourcedPct || fromTitlePct} move`
        : null;
  if (!wallet) return null;

  const action = facts.pct !== undefined
    ? (Math.abs(facts.pct) < 1.5 ? "No trade — move is noise until it holds."
      : facts.pct <= -5 ? "Do not panic-sell this print; recheck in 24h."
      : facts.pct >= 5 ? "Size any add small; this can fade."
      : "Watch the next print before changing size.")
    : deadline
      ? `Act before ${deadline} or skip.`
      : "One fact, one source — wait for a second print before moving money.";

  const name = title.split(/[—–-]|\s{2,}/)[0].trim().slice(0, 80);
  const body = `${name}: ${fact}, per ${story.source}. ${wallet.startsWith("deadline") ? wallet : `Wallet: ${wallet}`}.`;
  return {
    storyId: story.id,
    body: body.slice(0, 280),
    source: story.source,
    wallet,
    action,
    publishedAt: story.publishedAt || new Date().toISOString(),
    unconfirmed: story.unconfirmed,
  };
}

function money(n: number): string {
  if (n >= 1000) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return "$" + n.toPrecision(3);
}

export function createEditorialNotes() {
  const byId = new Map<string, { note: MoneyNote; by: string }>();
  return {
    set(note: MoneyNote, by: string): string | null {
      if (!EDITORS.has(by.trim().toLowerCase())) return "only Overheard or last30days can replace an auto note";
      if (!note.storyId || !note.body || !note.source || !note.wallet || !note.action) return "note is missing required fields";
      byId.set(note.storyId, { note: { ...note, storyId: note.storyId }, by });
      return null;
    },
    get(storyId: string): MoneyNote | null {
      return byId.get(storyId)?.note ?? null;
    },
  };
}

export type EditorialNotes = ReturnType<typeof createEditorialNotes>;

export function resolveNote(story: Story, editorial: EditorialNotes | null): MoneyNote | null {
  const ed = editorial?.get(story.id) ?? null;
  if (ed && ed.storyId === story.id) return ed;
  const auto = autoNote(story);
  return auto && auto.storyId === story.id ? auto : null;
}
