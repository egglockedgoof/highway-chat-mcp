// Probe: write → read → patch → delete a canary doc in PG.
// Usage: DATABASE_URL=... node --experimental-strip-types --no-warnings scripts/pg-roundtrip.ts
// Cleans up after itself. Never touches production collections' real docs.
// DO NOT RUN against production until the migration coordinator gives the go-ahead.
import { postgresPool, createPostgresStore, dbSchema } from "../src/store/postgres.js";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(2);
}
const schema = dbSchema();
const pool = postgresPool(url, schema);
const store = createPostgresStore(pool, schema);
const id = `__probe_${Date.now()}`;

try {
  const created = await store.create(
    "highway_messages",
    {
      name: { stringValue: "__probe__" },
      text: { stringValue: "supabase round-trip probe" },
      tsNum: { integerValue: String(Date.now()) },
    },
    id,
  );
  if (created.id !== id) throw new Error(`create id mismatch: ${created.id}`);

  const got = await store.get("highway_messages", id);
  if (got?.id !== id) throw new Error("get failed");

  await store.patch("highway_messages", id, { text: { stringValue: "patched" } });
  const got2 = await store.get("highway_messages", id);
  const patched = (got2?.fields.text as { stringValue?: string } | undefined)?.stringValue;
  if (patched !== "patched") throw new Error(`patch failed: ${patched}`);

  const newest = await store.listNewest("highway_messages", 5);
  if (!newest.some((d) => d.id === id)) throw new Error("listNewest missing probe");

  const removed = await store.remove("highway_messages", id);
  if (removed !== true) throw new Error("remove failed");
  if ((await store.get("highway_messages", id)) !== null) throw new Error("probe not gone");

  console.log("pg-roundtrip: ALL PASS");
} finally {
  await pool.end();
}
