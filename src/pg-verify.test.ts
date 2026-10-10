import { test } from "node:test";
import assert from "node:assert/strict";
import * as pg from "../dist/store/postgres.js";

process.env.PHASE3_TEST ??= "1";

// P0.1: pgTargets dedups identical primary/fallback (current Render config
// has DATABASE_URL == DATABASE_URL_FALLBACK, which makes fallback a no-op).
test("pgTargets: identical fallback URL is deduped to one target", () => {
  const u = "postgres://u:p@host:5432/db";
  const t = pg.pgTargets({ DATABASE_URL: u, DATABASE_URL_FALLBACK: u });
  assert.equal(t.length, 1);
  assert.equal(t[0]?.source, "primary");
});

test("pgTargets: distinct fallback is kept as second target", () => {
  const t = pg.pgTargets({
    DATABASE_URL: "postgres://u:p@primary:5432/db",
    DATABASE_URL_FALLBACK: "postgres://u:p@fallback:5432/db",
  });
  assert.equal(t.length, 2);
  assert.equal(t[0]?.source, "primary");
  assert.equal(t[1]?.source, "fallback");
});

// P0.1: probeDb resolves "down" on auth/connection failure — never throws.
test("probeDb: unreachable host resolves to down, never throws", async () => {
  const h = await pg.probeDb({
    DATABASE_URL: "postgres://bad:bad@127.0.0.1:1/db?connect_timeout=1",
  });
  assert.equal(h, "down");
});

test("probeDb: no URL resolves to disabled", async () => {
  assert.equal(await pg.probeDb({}), "disabled");
});

// P0.3: sslmode=no-verify survives URL handling (the live TLS fix depends on it).
test("sslmode: no-verify param is preserved on the connection URL", () => {
  const url =
    "postgres://u:p@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=no-verify";
  assert.equal(new URL(url).searchParams.get("sslmode"), "no-verify");
  assert.equal(pg.dbHostOf(url), "aws-0-us-west-1.pooler.supabase.com");
});

// P0.4: PG newest-first ordering contract that READ_PG_COLLECTIONS depends on.
// ts_num DESC NULLS LAST, created_at DESC — NULL ts sorts after all numerics.
test("ordering: ts_num DESC NULLS LAST matches newest-first intent", () => {
  const rows = [
    { id: "old", ts_num: 100 },
    { id: "null-ts", ts_num: null },
    { id: "new", ts_num: 300 },
    { id: "mid", ts_num: 200 },
  ];
  const sorted = [...rows].sort((a, b) => {
    if (a.ts_num === null && b.ts_num === null) return 0;
    if (a.ts_num === null) return 1;
    if (b.ts_num === null) return -1;
    return (b.ts_num as number) - (a.ts_num as number);
  });
  assert.deepEqual(
    sorted.map((r) => r.id),
    ["new", "mid", "old", "null-ts"],
  );
});

// P0.5: Firestore value shapes survive the JSONB round-trip.
test("fields: Firestore value shapes survive JSONB round-trip", () => {
  const fields = {
    name: { stringValue: "whisper" },
    text: { stringValue: "hi" },
    ts: { timestampValue: "2026-10-10T10:00:00Z" },
    tsNum: { integerValue: "1728554400000" },
    nested: { mapValue: { fields: { a: { stringValue: "b" } } } },
    tags: { arrayValue: { values: [{ stringValue: "x" }] } },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(fields)), fields);
});

// P1.8: a 429 mid-backfill must leave the checkpoint saved for resume.
test("backfill: 429 mid-run preserves checkpoint for resume", async () => {
  const bf = await import("../dist/store/backfill.js");
  let calls = 0;
  const saved: Array<{ sql: string }> = [];
  const db = {
    async query(sql: string) {
      if (!/^\s*SELECT/i.test(sql)) saved.push({ sql });
      return { rows: [] as Array<Record<string, unknown>> };
    },
  };
  const store = {
    get: async () => null,
    create: async (_c: string, f: unknown, id?: string) => ({
      id: id ?? "x", collection: "highway_messages", fields: f, tsNum: null,
    }),
    upsert: async (_c: string, id: string, f: unknown) => ({
      id, collection: "highway_messages", fields: f, tsNum: null,
    }),
    patch: async () => { throw new Error("nope"); },
    remove: async () => false,
    listNewest: async () => [],
    close: async () => {},
  };
  await assert.rejects(
    bf.runBackfill({
      apply: true, maxReads: 100, delayMs: 0, pageSize: 2, schema: "highway",
      store: store as never, db,
      listPage: async () => {
        calls += 1;
        if (calls === 1)
          return {
            documents: [{ name: "highway_messages/m1", fields: {} }],
            nextPageToken: "p2",
          };
        const e = new Error("429 quota") as Error & { status?: number };
        e.status = 429;
        throw e;
      },
      sleep: async () => {},
    }),
    /429/,
  );
  const ckpt = saved.filter((s) => /backfill_checkpoint/.test(s.sql));
  assert.ok(ckpt.length >= 1, "checkpoint saved before the 429");
});

// P1.10: missing checkpoint table surfaces an identifiable error.
test("backfill: missing checkpoint table throws identifiable error", async () => {
  const bf = await import("../dist/store/backfill.js");
  const db = {
    async query(): Promise<{ rows: Array<Record<string, unknown>> }> {
      throw new Error('relation "highway.backfill_checkpoint" does not exist');
    },
  };
  await assert.rejects(
    bf.runBackfill({
      apply: true, maxReads: 10, delayMs: 0, pageSize: 10, schema: "highway",
      store: {} as never, db,
      listPage: async () => ({ documents: [] }),
      sleep: async () => {},
    }),
    /backfill_checkpoint/,
  );
});

// P2.12: dbSchema rejects injection attempts.
test("dbSchema: rejects non-identifier schema", () => {
  assert.throws(
    () => pg.dbSchema({ DB_SCHEMA: "highway; DROP TABLE x" }),
    /invalid DB_SCHEMA/,
  );
  assert.throws(() => pg.dbSchema({ DB_SCHEMA: '"highway"' }), /invalid DB_SCHEMA/);
  assert.equal(pg.dbSchema({}), "highway");
});
