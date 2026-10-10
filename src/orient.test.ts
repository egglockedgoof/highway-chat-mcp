import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble, parseLastOrient, sessionMarkerId, sessionMarkerText, LANES } from "../dist/orient.js";
import type { Hit, Search } from "../dist/orient.js";

const hit = (id: string, extra: Partial<Hit> = {}): Hit => ({
  id, score: extra.score ?? 0.5, text: extra.text ?? id, kind: extra.kind ?? "decision",
  author: extra.author ?? "Nyx", verified: extra.verified ?? true, ts: extra.ts ?? 100,
});

test("parseLastOrient only accepts the marker form", () => {
  assert.equal(parseLastOrient(sessionMarkerText(42)), 42);
  assert.equal(parseLastOrient("LAST_ORIENT nope"), null);
  assert.equal(parseLastOrient("a decision about LAST_ORIENT 9"), null);
});

test("empty brain fails closed and tells the agent to ask", async () => {
  const b = await assemble(async () => [], { author: "Proto" });
  assert.equal(b.ok, false);
  assert.equal(b.author, "Proto");
  assert.match(b.next, /Ask before inventing/);
  assert.deepEqual(b.degraded, []);
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
  assert.equal(forced.last_session_ms, 1000);
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
  assert.equal(b.lanes.mission.length, 1);
  assert.equal(b.lanes.mission[0].text, "high");
});
