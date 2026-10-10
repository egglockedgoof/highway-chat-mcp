import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assemble, parseLastOrient, sessionMarkerId, sessionMarkerText, LANES,
  partitionMission, isSuperseded, runOrient, createOrientCache, markStale,
} from "../dist/orient.js";
import type { Hit, Search } from "../dist/orient.js";

const hit = (id: string, extra: Partial<Hit> = {}): Hit => ({
  id, score: extra.score ?? 0.5, text: extra.text ?? id, kind: extra.kind ?? "decision",
  author: extra.author ?? "Nyx", verified: extra.verified ?? true, ts: extra.ts ?? 100,
  tags: extra.tags ?? [],
});

const fresh = (): Search => async () => [
  hit("decision:1", { text: "Measure before paying", tags: ["topic:quota"], kind: "decision" }),
];

test("parseLastOrient only accepts the marker form", () => {
  assert.equal(parseLastOrient(sessionMarkerText(42)), 42);
  assert.equal(parseLastOrient("LAST_ORIENT nope"), null);
  assert.equal(parseLastOrient("a decision about LAST_ORIENT 9"), null);
});

test("empty brain fails closed and tells the agent to ask", async () => {
  const b = await assemble(async () => [], { author: "Proto" });
  assert.equal(b.ok, false);
  assert.equal(b.freshness, "live");
  assert.equal(b.stale, false);
  assert.equal(b.stamped, false);
  assert.match(b.next, /Ask before inventing/);
});

test("one dead lane degrades that lane only", async () => {
  const search: Search = async (q) => {
    if (q.kind === "lesson") throw new Error("down");
    return [hit("decision:1", { kind: "decision", text: "Measure before paying" })];
  };
  const b = await assemble(search, { author: "Nyx" });
  assert.equal(b.ok, true);
  assert.ok(b.degraded.includes("constraints") && b.degraded.includes("failures"));
  assert.equal(b.lanes.mission.length, 1);
  assert.equal(b.lanes.constraints.length, 0);
});

test("since_ms counts only newer memories; get() marker is used when since is omitted", async () => {
  const search: Search = async () => [
    hit("old", { ts: 100, text: "old decision" }),
    hit("new", { ts: 900, text: "new decision", score: 0.9 }),
  ];
  const get = async (id: string) =>
    id === sessionMarkerId("Nyx") ? hit(id, { text: sessionMarkerText(500), kind: "fact" }) : null;
  const fromMarker = await assemble(search, { author: "Nyx", get });
  assert.equal(fromMarker.last_session_ms, 500);
  assert.ok(fromMarker.new_since > 0);
  assert.match(fromMarker.next, /newer than your last session/);
  const first = await assemble(search, { author: "Nyx" });
  assert.equal(first.last_session_ms, null);
  assert.match(first.next, /First session/);
  const forced = await assemble(search, { author: "Nyx", sinceMs: 1000 });
  assert.equal(forced.new_since, 0);
  assert.match(forced.next, /Nothing new/);
});

test("you-lane is scoped to the calling author", async () => {
  const seen: string[] = [];
  await assemble(async (q) => { if (q.query === LANES.you.query) seen.push(q.author ?? ""); return []; }, { author: "hollow" });
  assert.deepEqual(seen, ["hollow"]);
});

test("duplicate ids collapse to the higher score", async () => {
  const b = await assemble(async () => [
    hit("same", { score: 0.2, text: "low" }),
    hit("same", { score: 0.9, text: "high" }),
  ], { author: "Nyx" });
  assert.equal(b.lanes.mission[0].text, "high");
});

test("superseded decisions leave the mission lane and are listed explicitly", () => {
  const { active, superseded, conflicts } = partitionMission([
    hit("old", { text: "SUPERSEDED: pay for Blaze", tags: ["topic:billing", "superseded"] }),
    hit("new", { text: "Measure first", tags: ["topic:billing"] }),
  ]);
  assert.equal(isSuperseded(active[0]), false);
  assert.deepEqual(active.map((h) => h.id), ["new"]);
  assert.deepEqual(superseded.map((h) => h.id), ["old"]);
  assert.equal(conflicts.length, 0);
});

test("two live decisions with the same topic: tag are a conflict, not a winner", () => {
  const { conflicts } = partitionMission([
    hit("a", { text: "Pay for Blaze", tags: ["topic:billing"] }),
    hit("b", { text: "Do not pay yet", tags: ["topic:billing"] }),
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].topic, "billing");
  assert.deepEqual(conflicts[0].ids.sort(), ["a", "b"]);
});

test("assemble surfaces conflicts and tells the agent not to pick a winner", async () => {
  const b = await assemble(async () => [
    hit("a", { text: "Pay", tags: ["topic:billing"] }),
    hit("b", { text: "Wait", tags: ["topic:billing"] }),
  ], { author: "Nyx" });
  assert.equal(b.conflicts.length, 1);
  assert.match(b.next, /Conflicts on billing/);
});

test("firestore failure is bounded: no invented tasks, stamp still happens on a live briefing", async () => {
  let stamps = 0;
  const b = await runOrient({
    search: fresh(),
    cache: createOrientCache(),
    openFromStore: async () => { throw new Error("Quota exceeded."); },
    stamp: async () => { stamps++; },
  }, { author: "Nyx" });
  assert.equal(b.ok, true);
  assert.deepEqual(b.failed, ["firestore"]);
  assert.equal(b.lanes.open.some((h) => /invented/i.test(h.text)), false);
  assert.match(b.next, /no tasks were invented/);
  assert.equal(stamps, 1);
  assert.equal(b.stamped, true);
});

test("brain down returns a cached snapshot marked stale and does not stamp again", async () => {
  const cache = createOrientCache(60_000, () => 1000);
  const first = await runOrient({
    search: fresh(), cache, stamp: async () => {},
  }, { author: "Nyx" });
  assert.equal(first.freshness, "live");
  assert.equal(first.stale, false);
  cache.put("Nyx", first);
  let stamps = 0;
  const down: Search = async () => { throw new Error("offline"); };
  const second = await runOrient({
    search: down, cache, stamp: async () => { stamps++; },
  }, { author: "Nyx" });
  assert.equal(second.stale, true);
  assert.equal(second.freshness, "cached");
  assert.equal(second.ok, true);
  assert.equal(second.stamped, false);
  assert.equal(stamps, 0);
  assert.match(second.next, /potentially stale/);
  assert.equal(second.lanes.mission[0].text, "Measure before paying");
});

test("brain down with no cache is a bounded failure, not a fabricated mission", async () => {
  const b = await runOrient({
    search: async () => { throw new Error("offline"); },
    cache: createOrientCache(),
  }, { author: "Proto" });
  assert.equal(b.ok, false);
  assert.equal(b.freshness, "unavailable");
  assert.equal(b.lanes.mission.length, 0);
  assert.equal(b.stamped, false);
  assert.match(b.next, /Ask before inventing/);
});

test("recovery after a live success does not invent duplicate open items", async () => {
  const cache = createOrientCache();
  const search = fresh();
  const openFromStore = async () => [hit("task:1", { text: "Limit the tasks listener", kind: "idea", tags: ["topic:task"] })];
  const a = await runOrient({ search, cache, openFromStore, stamp: async () => {} }, { author: "Nyx" });
  const b = await runOrient({ search, cache, openFromStore, stamp: async () => {} }, { author: "Nyx" });
  assert.equal(a.lanes.open.filter((h) => h.id === "task:1").length, 1);
  assert.equal(b.lanes.open.filter((h) => h.id === "task:1").length, 1);
});

test("markStale never claims the snapshot is live", () => {
  const s = markStale({
    ok: true, author: "Nyx", freshness: "live", stale: false, age_ms: 0,
    last_session_ms: null, new_since: 0, lanes: { mission: [], constraints: [], open: [], failures: [], you: [] },
    superseded: [], conflicts: [], degraded: [], failed: [], stamped: true, next: "go",
  }, 15000);
  assert.equal(s.stale, true);
  assert.equal(s.freshness, "cached");
  assert.equal(s.stamped, false);
  assert.match(s.next, /stale/);
});
