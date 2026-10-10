import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrain, memoryId, cleanTags, buildFilter, episodesFrom, UPSERT_BATCH, BrainError } from "../dist/brain.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakePinecone(respond: (c: Call) => { status: number; body: string } = () => ({ status: 201, body: "" })) {
  const calls: Call[] = [];
  const brain = createBrain({
    apiKey: () => "pk-test", indexName: "marrow-brain", namespace: "shared", now: () => 1000,
    request: async (url, init) => {
      const c = { url, ...init };
      calls.push(c);
      if (url.startsWith("https://api.pinecone.io/indexes/")) return { status: 200, body: JSON.stringify({ host: "brain.pinecone.io" }) };
      return respond(c);
    },
  });
  return { brain, calls };
}

const mem = (brain: ReturnType<typeof createBrain>, text: string) =>
  brain.memory({ text, kind: "fact", author: "Nyx", verified: true, source: "test" });

test("memoryId is stable per author/kind/text and case-insensitive on author", () => {
  assert.equal(memoryId("Nyx", "fact", "quota resets at 07:00 UTC"), memoryId("nyx", "fact", " quota resets at 07:00 UTC "));
  assert.notEqual(memoryId("Nyx", "fact", "a"), memoryId("Nyx", "lesson", "a"));
  assert.match(memoryId("Nyx", "fact", "a"), /^fact:[0-9a-f]{32}$/);
});

test("cleanTags lowercases, dedupes, drops blanks, caps at 8", () => {
  assert.deepEqual(cleanTags([" Quota ", "quota", "", "Firestore"]), ["quota", "firestore"]);
  assert.equal(cleanTags(Array.from({ length: 12 }, (_, i) => `t${i}`)).length, 8);
});

test("buildFilter only includes requested constraints", () => {
  assert.equal(buildFilter({ query: "q", topK: 3 }), undefined);
  assert.deepEqual(buildFilter({ query: "q", topK: 3, kind: "decision", author: "sin", verifiedOnly: true }),
    { kind: { $eq: "decision" }, author: { $eq: "sin" }, verified: { $eq: true } });
});

test("upsert resolves the host once, sends NDJSON with _id, and batches at the Pinecone limit", async () => {
  const { brain, calls } = fakePinecone();
  const many = Array.from({ length: UPSERT_BATCH + 4 }, (_, i) => mem(brain, `memory ${i}`));
  assert.equal(await brain.upsert(many), UPSERT_BATCH + 4);
  const upserts = calls.filter((c) => c.url.endsWith("/upsert"));
  assert.equal(calls.filter((c) => c.url.includes("api.pinecone.io")).length, 1);
  assert.equal(upserts.length, 2);
  assert.equal(upserts[0].url, "https://brain.pinecone.io/records/namespaces/shared/upsert");
  assert.equal(upserts[0].headers["Content-Type"], "application/x-ndjson");
  assert.equal(upserts[0].headers["Api-Key"], "pk-test");
  const first = JSON.parse(upserts[0].body!.split("\n")[0]);
  assert.equal(first._id, many[0].id);
  assert.equal(first.id, undefined);
  assert.equal(first.author, "Nyx");
  assert.equal(upserts[1].body!.split("\n").length, 4);
});

test("recall sends text query with filter and maps hits", async () => {
  const { brain, calls } = fakePinecone(() => ({ status: 200, body: JSON.stringify({ result: { hits: [
    { _id: "fact:1", _score: 0.8, fields: { text: "t", kind: "fact", author: "hollow", verified: true, ts: 5, source: "remember", tags: ["x"] } },
  ] } }) }));
  const hits = await brain.recall({ query: "what did hollow decide", topK: 4, verifiedOnly: true });
  assert.deepEqual(hits, [{ id: "fact:1", score: 0.8, text: "t", kind: "fact", author: "hollow", verified: true, ts: 5, source: "remember", tags: ["x"] }]);
  const body = JSON.parse(calls.at(-1)!.body!);
  assert.deepEqual(body.query, { inputs: { text: "what did hollow decide" }, top_k: 4, filter: { verified: { $eq: true } } });
});

test("errors surface as BrainError; 429 keeps its status; missing key is 503", async () => {
  const { brain } = fakePinecone(() => ({ status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) }));
  await assert.rejects(brain.recall({ query: "q", topK: 1 }),
    (e: unknown) => e instanceof BrainError && e.status === 429 && /rate limited/.test(e.message));
  const noKey = createBrain({ apiKey: () => undefined, indexName: "i", namespace: "n", request: async () => ({ status: 200, body: "{}" }) });
  await assert.rejects(noKey.recall({ query: "q", topK: 1 }), (e: unknown) => e instanceof BrainError && e.status === 503);
});

test("episodesFrom keeps substantive in-window messages with idempotent ids", () => {
  const eps = episodesFrom([
    { id: "a", name: "sin", text: "Ship the shared brain before the widget redesign", ts: 200 },
    { id: "b", name: "Grok", text: "ok", ts: 200 },
    { id: "c", name: "", text: "anonymous text that is long enough", ts: 200 },
    { id: "d", name: "whisper", text: "an old message from before the window opened", ts: 50 },
  ], "room", 100);
  assert.deepEqual(eps.map((e) => e.id), ["episode:room:a"]);
  assert.equal(eps[0].text, "sin: Ship the shared brain before the widget redesign");
  assert.equal(eps[0].verified, false);
  assert.equal(eps[0].kind, "episode");
});
