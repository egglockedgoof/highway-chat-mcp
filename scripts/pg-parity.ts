// Compares newest-N highway_messages from PG vs Firestore.
// Usage: DATABASE_URL=... FIREBASE_API_KEY=... BOT_CREDENTIALS='...' \
//   node --experimental-strip-types --no-warnings scripts/pg-parity.ts [N=20]
// Read-only on both sides. Fails loudly on id/order/text divergence.
// DO NOT RUN against production until the migration coordinator gives the go-ahead.
import { postgresPool, createPostgresStore, dbSchema } from "../src/store/postgres.js";
import { createFsClient, firebaseIdToken } from "../src/store/backfill.js";

const N = Number(process.argv[2] ?? 20);
const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(2);
}
const schema = dbSchema();
const pool = postgresPool(url, schema);
const pgStore = createPostgresStore(pool, schema);

try {
  const pgDocs = await pgStore.listNewest("highway_messages", N);

  const fs = createFsClient({ token: () => firebaseIdToken() });
  // Firestore newest-first: page wide and sort client-side (mixed ts types).
  const page = await fs.listPage(undefined, Math.min(N * 2, 200));
  const tsOf = (fields: Record<string, unknown>): number => {
    const v = fields.tsNum as { integerValue?: string } | undefined;
    const n = Number(v?.integerValue ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const fsDocs = page.documents
    .map((d) => ({ id: d.name?.split("/").pop() ?? "", fields: d.fields ?? {} }))
    .filter((d) => d.id)
    .sort((a, b) => tsOf(b.fields) - tsOf(a.fields))
    .slice(0, N);

  const pgIds = pgDocs.map((d) => d.id);
  const fsIds = fsDocs.map((d) => d.id);
  const pgSet = new Set(pgIds);

  const missingInPg = fsIds.filter((id) => !pgSet.has(id));
  const orderDiverged =
    pgIds.slice(0, fsIds.length).join(",") !== fsIds.join(",");

  let textMismatch = 0;
  for (const f of fsDocs) {
    const p = pgDocs.find((d) => d.id === f.id);
    if (!p) continue;
    const pt = (p.fields.text as { stringValue?: string } | undefined)?.stringValue;
    const ft = (f.fields.text as { stringValue?: string } | undefined)?.stringValue;
    if (pt !== ft) {
      textMismatch += 1;
      console.error(`text mismatch: ${f.id}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        pg: pgIds.length,
        firestore: fsIds.length,
        missingInPg: missingInPg.length,
        missingIds: missingInPg.slice(0, 5),
        orderDiverged,
        textMismatch,
      },
      null,
      1,
    ),
  );
  if (missingInPg.length || textMismatch) process.exit(1);
  console.log("pg-parity: PASS");
} finally {
  await pool.end();
}
