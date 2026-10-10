import { test } from "node:test";
import assert from "node:assert/strict";
import {
  curatedWriter, normalizeBatch, parseCuratedItem, toNewsItems, itemsFromDocFields, CURATED_MAX_ITEMS,
} from "../dist/curated-news.js";
import { checkSystemScope } from "../dist/security.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");

const item = (over: Record<string, unknown> = {}) => ({
  story_key: "fed-oct-2026",
  lane: "macro",
  title: "Fed holds rates",
  description: "No cut this meeting.",
  url: "https://www.federalreserve.gov/x",
  sources: ["Overheard"],
  image: "",
  paper: false,
  published_at: "2026-10-10T11:00:00Z",
  expires_at: "2026-10-12T00:00:00Z",
  ...over,
});

test("drops expired rows and keeps the latest story_key", () => {
  const batch = normalizeBatch([
    item({ published_at: "2026-10-09T00:00:00Z", title: "Fed older" }),
    item({ published_at: "2026-10-10T11:00:00Z", title: "Fed newer" }),
    item({ story_key: "old-play", expires_at: "2026-10-10T11:59:00Z", title: "expired", url: "https://ex/old" }),
  ], NOW);
  assert.deepEqual(batch.map((i) => i.title), ["Fed newer"]);
});

test("PAPER prefix and OVERHEARD mapping", () => {
  const [paper] = toNewsItems(normalizeBatch([item({ paper: true })], NOW));
  assert.equal(paper.title, "PAPER: Fed holds rates");
  assert.equal(paper.source, "OVERHEARD");
  assert.equal(paper.description, "No cut this meeting.");
  const [already] = toNewsItems(normalizeBatch([item({ paper: true, title: "PAPER: already" })], NOW));
  assert.equal(already.title, "PAPER: already");
});

test("rejects items without a real url or published_at", () => {
  assert.equal(parseCuratedItem(item({ url: "not-a-url" })), null);
  assert.equal(parseCuratedItem(item({ published_at: "soon" })), null);
  assert.equal(parseCuratedItem(item({ story_key: "" })), null);
});

test("reads the Firestore stringValue batch and ignores junk JSON", () => {
  const ok = itemsFromDocFields({ items: { stringValue: JSON.stringify([item()]) } }, NOW);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].source, "OVERHEARD");
  assert.deepEqual(itemsFromDocFields({ items: { stringValue: "{" } }, NOW), []);
});

test("caps the batch", () => {
  const raw = Array.from({ length: CURATED_MAX_ITEMS + 5 }, (_, i) =>
    item({ story_key: `k-${i}`, url: `https://ex/${i}`, published_at: new Date(NOW - i * 1000).toISOString() }));
  assert.equal(normalizeBatch(raw, NOW).length, CURATED_MAX_ITEMS);
});

test("only a header-bound crew bot can write", () => {
  assert.equal(curatedWriter({ method: "header_bound", bot: "Overheard" }), "Overheard");
  assert.equal(curatedWriter({ method: "path_legacy", bot: "Overheard" }), null);
  assert.equal(curatedWriter({ method: "header_legacy", bot: "Overheard" }), null);
  assert.equal(curatedWriter({ method: "header_bound", bot: null }), null);
  assert.equal(curatedWriter(null), null);
});

test("system allowlist: curated read/write only on /system_config/crew_curated", () => {
  assert.equal(checkSystemScope("curatedRead", "/system_config/crew_curated", "GET").ok, true);
  assert.equal(checkSystemScope("curatedWrite", "/system_config/crew_curated", "PATCH").ok, true);
  assert.equal(checkSystemScope("curatedWrite", "/system_config/crew_curated", "GET").ok, false);
  assert.equal(checkSystemScope("curatedRead", "/system_config/apify_last_run", "GET").ok, false);
  assert.equal(checkSystemScope("apifyState", "/system_config/crew_curated", "GET").ok, false);
  // PATCH with no precondition is the single whole-doc replace. 'either' would deny it.
  assert.equal(checkSystemScope("curatedWrite", "/system_config/crew_curated", "PATCH", { exists: false }).ok, false);
});
