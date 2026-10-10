import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mentionsName, selectMessages, mergeMessages, createChannelCache, CHANNEL_CACHE_MAX,
} from "./channel-cache.ts";

const msg = (id: string, ts: number, text = id, name = "whisper"): ReturnType<typeof Object.assign> =>
  ({ id, name, text, ts });

test("mentionsName matches @Name with spaces, hyphens, and case", () => {
  assert.equal(mentionsName("hey @Nyx look", "Nyx"), true);
  assert.equal(mentionsName("hey @money snatcher 3000", "MONEY SNATCHER 3000"), true);
  assert.equal(mentionsName("hey @money-snatcher-3000", "money snatcher 3000"), true);
  assert.equal(mentionsName("nyx said hi", "Nyx"), false);
  assert.equal(mentionsName("hey @hollow", "Nyx"), false);
});

test("selectMessages applies since_ts then mention then limit", () => {
  const buf = [
    msg("c", 300, "@Nyx new"),
    msg("b", 200, "old"),
    msg("a", 100, "@Nyx older"),
  ];
  assert.deepEqual(selectMessages(buf, { limit: 10, since_ts: 150 }).map((m) => m.id), ["c", "b"]);
  assert.deepEqual(selectMessages(buf, { limit: 10, mention: "Nyx" }).map((m) => m.id), ["c", "a"]);
  assert.deepEqual(selectMessages(buf, { limit: 1, since_ts: 50 }).map((m) => m.id), ["c"]);
});

test("mergeMessages newest-first, id-deduped, capped", () => {
  const out = mergeMessages(
    [msg("a", 100), msg("b", 200)],
    [msg("b", 250, "updated"), msg("c", 300)],
    2,
  );
  assert.deepEqual(out.map((m) => m.id), ["c", "b"]);
  assert.equal(out[1].text, "updated");
  assert.equal(mergeMessages([], Array.from({ length: CHANNEL_CACHE_MAX + 5 }, (_, i) => msg(`k${i}`, i)), CHANNEL_CACHE_MAX).length, CHANNEL_CACHE_MAX);
});

test("shared cache: one load is reused; TTL miss is incremental; ingest is local", async () => {
  const loads: Array<{ channel: string; since: number | null; limit: number }> = [];
  let clock = 1_000;
  const cache = createChannelCache({
    max: 3, ttlMs: 100, now: () => clock,
    load: async (channel, since, limit) => {
      loads.push({ channel, since, limit });
      if (!since) return [msg("m1", 10, "first")];
      return [msg("m2", 20, "newer")];
    },
  });
  const a = await Promise.all([
    cache.read("room", { limit: 10 }),
    cache.read("room", { limit: 10 }),
  ]);
  assert.equal(loads.length, 1);
  assert.equal(a[0].length, 1);
  assert.equal(a[1][0].id, "m1");

  clock = 1_050;
  const warm = await cache.read("room", { limit: 10 });
  assert.equal(loads.length, 1);
  assert.equal(warm[0].id, "m1");

  clock = 1_200;
  const next = await cache.read("room", { limit: 10 });
  assert.equal(loads.length, 2);
  assert.equal(loads[1].since, 10);
  assert.deepEqual(next.map((m) => m.id), ["m2", "m1"]);

  cache.ingest("room", msg("m3", 30, "local"));
  const local = await cache.read("room", { limit: 10, since_ts: 20 });
  assert.equal(loads.length, 2);
  assert.deepEqual(local.map((m) => m.id), ["m3"]);
});

test("onNew fires for incremental refresh and ingest, not the first fill", async () => {
  const seen: string[] = [];
  let clock = 1;
  const cache = createChannelCache({
    max: 5, ttlMs: 10, now: () => clock,
    load: async (_c, since) => since == null ? [msg("a", 1)] : [msg("b", 2)],
    onNew: (_ch, incoming) => { for (const m of incoming) seen.push(m.id); },
  });
  await cache.read("room", { limit: 10 });
  assert.deepEqual(seen, []);
  clock = 20;
  await cache.read("room", { limit: 10 });
  assert.deepEqual(seen, ["b"]);
  cache.ingest("room", msg("c", 3));
  assert.deepEqual(seen, ["b", "c"]);
});
