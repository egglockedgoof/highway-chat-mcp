import { test } from "node:test";
import assert from "node:assert/strict";
import { attachNote, autoNote, createEditorialNotes, resolveNote, storyId } from "../dist/money-notes.js";
import { createCardBook, presentItem, publicCard, PRICE_TTL_MS, mergeCard } from "../dist/news-cards.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");

// Live /news headlines from 2026-10-10T06:08Z plus the cited bad examples.
const LIVE = [
  { title: "Fired OpenAI employees question the company's commitment to safety", source: "WORLD", url: "https://example.com/openai" },
  { title: "Trump says U.S. to get diesel from Russia, relaxing pressure on Moscow to ease prices before midterms", source: "WORLD", url: "https://example.com/diesel" },
  { title: "Did Russia play by the rules in reporting lab worker's death?", source: "WORLD", url: "https://example.com/lab" },
  { title: "How the oil industry is preparing for Hurricane Isaias", source: "WORLD", url: "https://example.com/isaias" },
  { title: "Trump announces deal for Russian diesel as Zelensky calls it a gift to Putin", source: "WORLD", url: "https://example.com/diesel2" },
  { title: "Accelerating Agentic AI in Production to Drive Measurable Outcomes", source: "SOCIAL", url: "https://example.com/agentic" },
  { title: "7 in 10 enterprises expected to abandon vendor-built agentic AI by 2028", source: "SOCIAL", url: "https://example.com/710" },
  { title: "Asia-Pacific AI in Computer Vision Market Size, Share,Trends, Growth Analysis Report, 2030", source: "SOCIAL", url: "https://example.com/cv" },
  { title: "91% Dem House odds", source: "WORLD", url: "https://example.com/odds" },
  { title: "Iran war day 222", source: "WORLD", url: "https://example.com/iran" },
  { title: "BTC $82,716 +0.2%", source: "CRYPTO", url: "https://www.coingecko.com/en/coins/bitcoin", facts: { price: 82716, pct: 0.2 } },
] as const;

test("acceptance: 10 recent stories — zero mismatched notes, zero generic notes", () => {
  const cards = LIVE.map((s) => presentItem(s, null, NOW));
  assert.equal(cards.length, LIVE.length);
  for (const c of cards) {
    if (!c.note) continue;
    assert.equal(c.note.storyId, c.id, `note bound to wrong story: ${c.title}`);
    assert.match(c.note.body, new RegExp(c.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(c.note.wallet, `note missing wallet: ${c.title}`);
    assert.ok(c.note.action, `note missing action: ${c.title}`);
    assert.equal(/watch your wallet|oil spikes|markets reprice|builders move first|who funds it/i.test(c.note.body), false, c.note.body);
  }
  const noted = cards.filter((c) => c.note);
  assert.deepEqual(noted.map((c) => c.title), ["BTC $82,716 +0.2%"]);
  assert.match(noted[0].note!.body, /82,716|\$82716|\$82,716/);
  assert.match(noted[0].note!.body, /CRYPTO/);
  assert.equal(cards.find((c) => c.title.startsWith("91%"))!.note, null);
  assert.equal(cards.find((c) => c.title.startsWith("Iran"))!.note, null);
  assert.equal(cards.find((c) => c.title.includes("lab worker"))!.note, null);
  const pub = cards.map(publicCard);
  for (const p of pub) {
    if (!p.note) assert.equal(p.description, "");
    else { assert.equal(p.note.storyId, p.id); assert.equal(p.description, p.note.body); }
  }
});

test("a note whose storyId does not match the card is dropped", () => {
  const card = presentItem(LIVE[10], null, NOW);
  const swapped = attachNote(card, { ...card.note!, storyId: "not-this-card" });
  assert.equal(swapped.note, null);
});

test("editorial note from Overheard replaces auto; strangers cannot", () => {
  const ed = createEditorialNotes();
  const btc = presentItem(LIVE[10], null, NOW);
  assert.ok(btc.note);
  const err = ed.set({
    storyId: btc.id, body: "Overheard: spot bid held $82.7k into the New York open.",
    source: "Overheard", wallet: "$82,716", action: "Do not chase the +0.2%.",
    publishedAt: new Date(NOW).toISOString(), unconfirmed: false,
  }, "Overheard");
  assert.equal(err, null);
  const next = presentItem(LIVE[10], ed, NOW);
  assert.match(next.note!.body, /Overheard/);
  assert.equal(next.note!.storyId, next.id);
  assert.match(ed.set(next.note!, "Nyx") ?? "", /only Overheard/);
});

test("editorial set and autoNote refuse private data", () => {
  const ed = createEditorialNotes();
  const btc = presentItem(LIVE[10], null, NOW);
  assert.match(ed.set({
    storyId: btc.id, body: "Mail the wire to nyx@highway.chat",
    source: "Overheard", wallet: "$82,716", action: "Do not chase.",
    publishedAt: new Date(NOW).toISOString(), unconfirmed: false,
  }, "Overheard") ?? "", /email in body/);
  assert.match(ed.set({
    storyId: btc.id, body: "Held the bid.",
    source: "Overheard", wallet: "4111-1111-1111-1111", action: "Do not chase.",
    publishedAt: new Date(NOW).toISOString(), unconfirmed: false,
  }, "Overheard") ?? "", /card number in wallet/);
  assert.equal(autoNote({
    id: "x", title: "BTC $1 +1.0% — call (415) 555-0134",
    url: "https://ex", source: "CRYPTO", publishedAt: null, unconfirmed: false,
    facts: { price: 1, pct: 1 },
  }), null);
});

test("series stories share one key; a new headline updates the card instead of duplicating", () => {
  const book = createCardBook(() => NOW);
  const a = presentItem({ title: "Fed holds rates", source: "WORLD", url: "https://ex/a" }, null, NOW);
  const b = presentItem({ title: "Fed signals a later cut", source: "WORLD", url: "https://ex/b" }, null, NOW);
  assert.equal(a.id, b.id);
  assert.equal(a.id, "fed-oct-2026");
  const first = book.ingest([a]);
  const second = book.ingest([b]);
  assert.equal(second.length, 1);
  assert.equal(second[0].title, "Fed signals a later cut");
  assert.equal(second[0].lines[0].title, "Fed signals a later cut");
  assert.equal(book.size(), 1);
  assert.equal(first[0].id, second[0].id);
});

test("price cards expire 48h after the last quote; benefits expire on their deadline", () => {
  let t = NOW;
  const book = createCardBook(() => t);
  const quote = presentItem({ title: "BTC $80,000 +1.0%", source: "CRYPTO", url: "https://ex/btc", facts: { price: 80000, pct: 1 } }, null, t);
  book.ingest([quote]);
  assert.equal(book.size(), 1);
  t = NOW + PRICE_TTL_MS + 1;
  assert.equal(book.ingest([]).length, 0);
  assert.equal(book.size(), 0);

  t = NOW;
  const snap = presentItem({ title: "SNAP benefits end October 31", source: "WORLD", url: "https://ex/snap" }, null, t);
  assert.equal(snap.kind, "benefit");
  assert.ok(snap.note);
  const book2 = createCardBook(() => t);
  book2.ingest([snap]);
  t = Date.UTC(2026, 9, 31);
  assert.equal(book2.ingest([snap]).length, 0);
});

test("mergeCard prepends a new line and does not invent a second id", () => {
  const a = presentItem({ title: "NVDA $180 +6.0% — top mover", source: "MARKETS", url: "https://ex/n", facts: { price: 180, pct: 6 } }, null, NOW);
  const b = { ...a, title: "NVDA $190 +11.0% — top mover" };
  const m = mergeCard(a, b, NOW + 1000);
  assert.equal(m.id, a.id);
  assert.equal(m.lines[0].title, b.title);
});

test("autoNote refuses a title-only percent with no money angle", () => {
  assert.equal(autoNote({
    id: "x", title: "7 in 10 enterprises expected to abandon vendor-built agentic AI by 2028",
    url: "https://ex", source: "SOCIAL", publishedAt: null, unconfirmed: true,
  }), null);
});

test("VOO and S&P 500 do not share a story key", () => {
  const voo = presentItem({ title: "VOO S&P 500 716 +0.2%", source: "MARKETS", url: "https://ex/voo", facts: { price: 716, pct: 0.2 } }, null, NOW);
  const spx = presentItem({ title: "S&P 500 7,812 +0.1%", source: "MARKETS", url: "https://ex/spx", facts: { price: 7812, pct: 0.1 } }, null, NOW);
  assert.equal(voo.id, "voo-oct-2026");
  assert.equal(spx.id, "spx-oct-2026");
  assert.notEqual(voo.id, spx.id);
  assert.match(voo.note!.body, /716/);
  assert.match(spx.note!.body, /7,812|7812/);
});

test("resolveNote never returns a note for a different id", () => {
  const story = { id: "btc-oct-2026", title: "BTC $1 +1.0%", url: "https://ex", source: "CRYPTO", publishedAt: null, unconfirmed: false, facts: { price: 1, pct: 1 } };
  const n = autoNote(story)!;
  n.storyId = "other";
  const ed = createEditorialNotes();
  ed.set(n, "last30days");
  const resolved = resolveNote(story, ed);
  assert.ok(resolved === null || resolved.storyId === story.id);
  assert.notEqual(resolved?.storyId, "other");
});
