# Supabase Cutover Plan — Highway Chat MCP (Backfill & Cutover Coordinator)

**Repo:** `egglockedgoof/highway-chat-mcp` @ `4ed2fde` (main)
**Date:** 2026-10-10
**Authority:** sin — all-in on Supabase, speed is priority, NO live Firestore fallback, full cutover.
**Role of this doc:** planning only. No code changed in this review pass.

---

## 1. Migration file verification results

### `migrations/001_init.sql` — ✅ CORRECT, idempotent, but see open items

| Check | Result |
|---|---|
| `CREATE SCHEMA IF NOT EXISTS highway` | ✅ Idempotent |
| `CREATE TABLE IF NOT EXISTS highway.schema_migrations` | ✅ Idempotent |
| `CREATE TABLE IF NOT EXISTS highway.docs` — `(collection, id)` PK, `fields JSONB`, `ts_num BIGINT`, `created_at/updated_at` | ✅ Correct. Shape matches `StoreDoc`; `ts_num` solves Firestore's mixed-type `ts` ordering problem natively |
| `CREATE INDEX IF NOT EXISTS docs_newest (collection, ts_num DESC NULLS LAST, created_at DESC)` | ✅ Exactly matches `listNewest`'s `WHERE collection = ? ORDER BY ts_num DESC NULLS LAST LIMIT` in `src/store/postgres.ts` |
| `CREATE OR REPLACE FUNCTION highway.highway_notify_doc()` — `pg_notify('highway_events', ...)` | ✅ Portable Postgres (no vendor extensions). Payload `{type, id}` is fine for SSE fan-out |
| `DROP TRIGGER IF EXISTS docs_notify … CREATE TRIGGER docs_notify AFTER INSERT OR UPDATE` | ✅ Idempotent; drop+recreate pattern is safe |
| `migrate.ts` runner | ✅ Tracks applied files in `schema_migrations`; runs each file in `BEGIN/COMMIT`; double-guard with runner tracking + `IF NOT EXISTS` |

**Open items (blockers for a clean cutover):**
- **Trigger fires on ALL collections, no filter.** Every `highway_presence` heartbeat upsert (~45s/client) and backfill upsert fires `pg_notify` → SSE fan-out to all tabs. Fix belongs in the hardening coordinator's `003_notify_hardening.sql`: `DROP TRIGGER IF EXISTS docs_notify … CREATE TRIGGER … WHEN (NEW.collection IN ('highway_messages','highway_code','highway_dm','highway_tasks','highway_activity'))`. A `WHEN` clause is trigger-DDL-compatible and composes fine on top of 001 (drop + recreate).
- **`003_notify_hardening.sql` does not exist yet** (only `001`, `002` in `migrations/`). If it lands before cutover, verify: (a) it drops/recreates `docs_notify` rather than duplicating it; (b) the `WHEN` clause uses `IN (...)` on `NEW.collection` (function calls are illegal in `WHEN`); (c) it registers in `schema_migrations` via the normal runner (any new numbered file does).
- **Backfill fires the trigger per row** (C1 from schema review): backfilling N thousand messages = N thousand SSE events pushed to every connected client. Mitigations, pick one before backfill: (a) backfill runs before any SSE clients are served by the new deploy (boot ordering already does this — `startMessagesBackfill()` runs at boot, SSE clients connect later; mostly safe); or (b) session-GUC skip (`SET LOCAL highway.skip_notify = '1'` in backfill connection + `WHEN (current_setting('highway.skip_notify', true) IS DISTINCT FROM '1')` in trigger 003). (a) is free; (b) is belt-and-suspenders.
- `DB_SCHEMA` override is cosmetic-only: migrations hardcode `highway.` — leave `DB_SCHEMA` unset everywhere.

### `migrations/002_backfill_checkpoint.sql` — ✅ CORRECT, idempotent

Single `CREATE TABLE IF NOT EXISTS highway.backfill_checkpoint (collection TEXT PRIMARY KEY, page_token TEXT, docs/reads/upserts INT, done BOOLEAN, updated_at TIMESTAMPTZ)`. Matches `loadCheckpoint`/`saveCheckpoint` in `src/store/backfill.ts`. No secrets. Nothing to fix.

### Compatibility note for the hardening coordinator
`003` (when it arrives) **must not** `ALTER TRIGGER`; PG has no `ALTER TRIGGER … ADD WHEN`. The correct pattern is `DROP TRIGGER IF EXISTS docs_notify ON highway.docs;` then `CREATE TRIGGER` with the `WHEN` clause — fully compatible with re-running 001 afterward (001's drop/recreate restores the unfiltered trigger, 003 re-applies the filter; `schema_migrations` ordering keeps it deterministic).

---

## 2. Recommended cutover approach: option (b) — promote PG to primary inside the manual mirror pattern

### Why NOT option (a) — `STORE_BACKEND=postgres` + refactor `index.ts` onto `createStore()`
- `index.ts` makes **33 direct `firestore()` REST calls** (inventory count) plus `:runQuery` structured queries with `where`/`orderBy`, `:runAggregationQuery` counts, and `updateMask` PATCHes. The `Store` interface (`get/create/upsert/patch/remove/listNewest`) is **too thin** to express these — `querySince`, aggregation counts, and field-masked PATCHes have no Store equivalent.
- A true `createStore()` cutover means either (a1) expanding `Store` and rewriting 33+ call sites, or (a2) building a Firestore-REST-shaped shim over PG anyway — which is option (b) with extra steps.
- Slower, riskier, more merge conflicts with the live room. Speed is the mandate.

### Why NOT option (b)-as-stated (`READ_PG_COLLECTIONS=*` + stop Firestore writes)
- **Only 3 read sites honor `READ_PG_COLLECTIONS`** (`readChannelMessages` ~1204, `search_messages` ~1456, site `readMessages` ~3014). `readTasks`, `readPresence`, `readTyping`, `readNotes`, `readActivity`, `read_pinned`, aggregation counts, and every other tool read Firestore **directly** via `queryPage`/`querySince`/`listDocs`. Setting `READ_PG_COLLECTIONS=*` would flip only the message channels — everything else silently stays on Firestore. **This is a trap; do not treat it as a full read flip.**
- No write path writes PG as primary today. `mirrorToPg` is shadow-only under `STORE_DUAL_WRITE=1`, and several write sites have **no mirror call** (`react_to_message` → `mutateDoc` ~1437, `pin_message` → `patchFields`, notes/shared ~1881, sys_config ~2849, activity POST ~971, telemetry flush ~796). Cutting Firestore writes without first wiring PG writes there = **data loss**.

### ✅ Recommended: option (b′) — keep the manual mirror pattern, promote PG to primary
Fastest safe path because it works with the existing architecture instead of against it:

1. **Reads — route through the shared read helpers, not per-tool.** All Firestore reads in `index.ts` funnel through ~6 helpers: `queryPage`, `querySince`, `queryNewestNum`, `getDocOrNull`, `listDocs`, and the aggregation-count call (~1055). Adding a PG branch inside *these helpers* (keyed off a single env, e.g. `READ_PG_COLLECTIONS` including the collection, or a global `PG_READS=1`) flips **every tool at once** instead of touching 20+ call sites. Keep `since_ts`/`mention` filtering behavior identical (note C2 below).
2. **Writes — make PG the primary in the write choke points.** `writeIdempotent` (~552) and `mutateDoc` (~932) cover nearly all document writes. Add `pgStore.upsert` as the **primary** write (awaited), keep the `firestore()` call temporarily as the shadow mirror. Then add the missing mirror/PG-primary calls at the known missed sites (`react_to_message`, `pin_message`, activity POST, telemetry flush). Once `/health` and parity checks confirm PG is complete, delete the Firestore writes.
3. **This needs one small code change batch** (helpers + write choke points) — but no architectural refactor, no interface redesign, and the existing `pgStore` pool, `dbProbe`, `/health` wiring, and `pg_listen` all carry over unchanged.

### Pre-existing bugs that must be fixed in that batch (all verified at commit `4ed2fde`)
- **C2 — `since_ts` silent message loss on PG reads.** Both PG read branches fetch `listNewest(coll, min(limit,100))` and filter `since_ts` client-side. >100 new messages since `since_ts` → older ones silently dropped. Firestore's `querySince` is server-side. Fix: push the predicate into SQL (`WHERE collection=$1 AND ($3::bigint IS NULL OR ts_num > $3)` — `docs_newest` index serves it).
- **I2 — secondary failures swallowed.** `mirrorToPg` catches and `recordFailure`s only. During the dual-write soak, a failed PG write leaves a gap with no replay record. Log `collection/id` with failures at minimum; consider a `dual_write_failures` replay queue for the soak phase.
- **I4 — no `statement_timeout`.** `postgresPool` sets `max:5, connectionTimeoutMillis:4000` but no statement timeout. 5 stuck queries = total PG outage. Add `statement_timeout=10000` via `options` before cutover.
- **C3 — pg_listen session-mode constraint.** Works on `:5432` session-mode pooler only; `:6543` (transaction mode) silently kills realtime. Pin `DATABASE_URL` to the `:5432` pooler host (or direct connection). Add a startup warning if the URL contains `:6543`.

---

## 3. Step-by-step cutover checklist

> Convention: each step ends with a **verify gate**. Do not advance past a red gate.

### Phase 0 — Credentials & migrations (pre-deploy)
- [ ] 0.1 Supabase project reachable from Render. `DATABASE_URL` = session-mode pooler (`:5432`, **not** `:6543`), `DATABASE_URL_FALLBACK` = direct connection (as `DATABASE_URL_FALLBACK`).
- [ ] 0.2 `highway_bridge` role least privilege:
  ```sql
  REVOKE ALL ON SCHEMA public FROM highway_bridge;
  GRANT USAGE, CREATE ON SCHEMA highway TO highway_bridge;
  GRANT ALL ON ALL TABLES IN SCHEMA highway TO highway_bridge;
  ALTER DEFAULT PRIVILEGES IN SCHEMA highway GRANT ALL ON TABLES TO highway_bridge;
  ```
- [ ] 0.3 Deploy the migration/code bundle (001 + 002 + 003 if delivered). Boot runs `runMigrations()` automatically before serving.
- **Gate:** `SELECT id FROM highway.schema_migrations` shows `001_init.sql`, `002_backfill_checkpoint.sql` (and `003…` if shipped). `/health` → `db` = ok.

### Phase 1 — Backfill (deploy with `BACKFILL_MESSAGES=1`)
- [ ] 1.1 Deploy with `BACKFILL_MESSAGES=1`, `STORE_DUAL_WRITE=1`, `READ_PG_COLLECTIONS` empty (reads still on Firestore).
- [ ] 1.2 Boot order is automatic: `runMigrations` → `connectPostgres` → `runBackfill` loop → `verifyMessages`. See §5 for the full flow.
- [ ] 1.3 **Backfill currently covers `highway_messages` ONLY** (`MESSAGES` in `backfill.ts`). Other collections (`highway_code`, `highway_dm`, `highway_tasks`, `highway_activity`, `highway_presence`, notes, etc.) have **no backfill** — they are caught up by dual-write going forward, plus a one-time manual backfill or per-collection backfill run if their history matters. Decide per collection: messages/code/dm = backfill; presence/typing = skip (ephemeral).
- **Gate:** `/health` → `backfill.state == "done"`, `checkpoint.done == true`, `counts` shows firestore == postgres, `verify.ok == true`, `verify.mismatches == []`. See §5 "what done looks like".

### Phase 2 — Dual-write soak (PG catches up live)
- [ ] 2.1 `STORE_DUAL_WRITE=1` stays on. Fix the missed write sites (`react_to_message`, `pin_message`, notes/shared, activity, telemetry) so every write lands in both.
- [ ] 2.2 Soak ≥ 1 full activity cycle (room active period). Watch logs for `dual-write … failed` and `dual_write:` failure records — investigate every one.
- [ ] 2.3 Periodic parity check: run count + sample-hash per collection (reuse `verifyMessages` logic via `/admin/backfill` or a one-off script). Alert on any mismatch.
- **Gate:** zero dual-write failures for the soak window; per-collection counts match.

### Phase 3 — Flip reads to Postgres
- [ ] 3.1 Deploy the read-helper PG branches (recommended §2), then set `READ_PG_COLLECTIONS` to all migrated collections (or global `PG_READS=1`).
- [ ] 3.2 **C2 fix must ship in the same deploy** (server-side `since_ts` in `listNewest`) — otherwise clients reconnecting after a quiet period lose messages.
- [ ] 3.3 Verify in-room: send a message, confirm it appears in widget (SSE), in MCP `read_messages`, and in site API `readMessages`. Test `since_ts` pagination with a large gap.
- **Gate:** `/health` → `site.read_pg` lists all collections; `site.pg_listen == true`; tool outputs identical between two deploys (or A/B via `READ_PG_COLLECTIONS` toggle). Firestore reads should drop to ~zero in `reads` counters.

### Phase 4 — Flip writes to Postgres (point of no return for live traffic)
- [ ] 4.1 Deploy with PG as primary write (`writeIdempotent`/`mutateDoc` → `pgStore` awaited first). Keep Firestore mirror **on for this deploy only** as a safety net (shadow direction unchanged).
- [ ] 4.2 **This is when `docs_notify` starts doing real work** — confirm SSE realtime: post from one client, see it arrive live in another within ~1s. If 003's `WHEN` filter shipped, presence heartbeats should NOT produce SSE storms.
- **Gate:** send/receive round-trip works end-to-end (widget → bridge → PG → LISTEN → SSE → widget). New doc appears in `highway.docs` via SQL (`SELECT count(*) FROM highway.docs WHERE collection='highway_messages'` increments). `/health` → `db: ok`.

### Phase 5 — Confirm & cut Firestore out
- [ ] 5.1 Full parity verification: counts + sample hash per migrated collection (Firestore vs PG).
- [ ] 5.2 Deploy with Firestore writes removed and `STORE_DUAL_WRITE=0`. Keep `DATABASE_URL_FALLBACK` as the PG-side fallback (not Firestore).
- [ ] 5.3 **Do NOT delete Firestore data yet.** Leave the Firestore project untouched as a cold archive until sin explicitly orders decommission — disaster recovery, not a live fallback (see §4).
- **Gate:** `/health` shows `db: ok`, `backfill.done`, `pg_listen: true`, `dual_write: false`, `read_pg` = all. Room fully functional for 24h with zero Firestore reads/writes.

---

## 4. Rollback procedure (catastrophic-only; sin ordered no live Firestore fallback)

The no-fallback order stands for normal operation. This section exists for **catastrophic failure only** (data corruption, PG outage, Supabase incident) and requires sin's explicit go to execute, except step R1 which is safe to do unilaterally.

- [ ] **R1 — Stop the bleeding (reads).** Set `READ_PG_COLLECTIONS` empty (or `PG_READS=0`) and redeploy. Reads fall back to Firestore instantly. Safe because Firestore kept receiving writes until the write-flip (Phase 4), and during Phase 4+ the mirror was still shadowing.
- [ ] **R2 — Restore writes.** Roll back to the previous Render deploy (Render dashboard → Deploys → rollback). Writes resume on Firestore. Any writes made while PG was primary are in `highway.docs` — export them (`pg_dump` of schema `highway` or `COPY (SELECT …) TO STDOUT`) and re-apply to Firestore via a script if needed.
- [ ] **R3 — Data recovery.** If PG data itself is suspect: restore from Supabase's point-in-time backup (dashboard → Database → Backups; free tier has limited PITR — know the window *before* cutover). Re-run backfill (`BACKFILL_MESSAGES=1` + redeploy) to rebuild `highway_messages` from Firestore, which remains the untouched archive until decommission.
- [ ] **R4 — Resume.** Once stable, restart the cutover at the phase that failed. Record the failure in the lessons register (`~/workspace/marrow-amendments/lessons-register.md`).

> Cheapest insurance that does not violate "no fallback": **never delete or overwrite Firestore data during cutover.** A cold, untouched Firestore archive costs nothing and turns a catastrophe into a re-backfill.

---

## 5. Backfill monitoring guide

### What runs when (`src/store/boot-backfill.ts`)
1. `startMessagesBackfill()` fires at boot if `BACKFILL_MESSAGES=1` (unref'd timer — never blocks listen, never blocks `/health`).
2. **migrate** → `runMigrations(env)`: applies `migrations/*.sql` in order, tracked in `schema_migrations`.
3. **connect** → `connectPostgres(env)`: tries `DATABASE_URL`, then `DATABASE_URL_FALLBACK`.
4. **run** → `runBackfill(opts)` loop:
   - loads `backfill_checkpoint` for `highway_messages` (resumes from `page_token` if present);
   - pages Firestore REST (`pageSize` = 50, `maxReads` = **200 per invocation** — quota guard);
   - `store.upsert()` each doc into PG (idempotent — safe to re-run);
   - saves checkpoint after every page;
   - repeats until a page comes back empty or `nextPageToken` is absent → `done = true`.
5. **verify** → `verifyMessages`: `countFs` vs `countPg` must match; then `sample` = 20 PG docs fetched and field-compared against Firestore (`firestore` hash vs `postgres` hash, `mismatches[]`).

### How to monitor
- **`/health` → `backfill`** (live snapshot, no polling cost):
  ```json
  { "enabled": true, "state": "running|verifying|done|error", "done": false,
    "checkpoint": { "docs": 1234, "reads": 1234, "upserts": 1234, "done": false, "updatedAt": "…" },
    "counts": { … }, "verify": { "n": 20, "ok": true, "mismatches": [] }, "error": null }
  ```
- **Logs:** JSON lines `{"backfill":"progress", docs, reads, upserts, done}` after every `runBackfill` invocation; `{"backfill":"verify", done, counts, verify}` at the end. Render log stream shows progress without extra tooling.
- **`/admin/backfill`** returns the same snapshot (check auth — it's under admin routes).

### What "done" looks like
- `state == "done"`, `done == true`, `checkpoint.done == true`
- `counts` shows equal Firestore/PG counts
- `verify.ok == true`, `verify.mismatches` empty
- Boot log contains `"backfill":"verify"` with `"done":true`

### If backfill fails mid-way (checkpoint resumability)
- **Crash / deploy / SIGTERM mid-backfill:** checkpoint row persists in PG (`page_token`, cumulative `docs/reads/upserts`). Next boot with `BACKFILL_MESSAGES=1` resumes from `page_token` — no docs re-processed beyond the current page (upserts are idempotent anyway).
- **Error state:** `runBootBackfill` catches → `state: "error"`, `error: "<message>"` on `/health`, `console.warn("backfill: failed: …")`. Fix the cause, redeploy — it resumes.
- **Firestore 429 (quota):** `maxReads` = 200/invocation caps session reads; `delayMs` paces pages. The loop just stops for this boot; resume next boot. The Firestore 50k/day quota is shared with the room — schedule the backfill deploy after the daily read budget resets if quota is tight.
- **Verify mismatch:** `state: "error"`, `error: "verify mismatch"`, `counts`/`verify.mismatches` pinpoint the gap. Upserts are idempotent — safe to re-run; mismatches usually mean writes happened during backfill (re-run catches up) or a missed mirror site.
- **Never set `BACKFILL_MESSAGES=1` permanently:** once `done`, unset it (or leave it — `runBackfill` early-returns on `cp.done`, but the migrate+connect still runs each boot; unsetting keeps boots lean).

---

## 6. pg_listen / realtime constraints

- `src/site-api.ts` `startPgListen()`: opens a **dedicated `pg.Client`** (not pool) and issues `LISTEN highway_events`. Payloads → `parseNotifyPayload` → `siteBus.publish` → SSE fan-out to widget clients.
- **Hard constraint: session-mode pooler (`:5432`) or direct connection.** Supabase's transaction-mode pooler (`:6543`) does **not** support `LISTEN/NOTIFY`. If `DATABASE_URL` is changed to `:6543`, `pg_listen` fails at startup, `pgListenUp` stays `false`, `/health` shows `site.pg_listen: false`, and **SSE realtime silently degrades to nothing** — no crash, no loud alarm. Plain queries (`pool.query`) work on either port; **only LISTEN needs session mode.**
- **Operational rules:**
  1. Pin `DATABASE_URL` to the `:5432` pooler host in Render env. Document next to the env var: *"pg_listen requires session-mode pooler (:5432). Port 6543 breaks realtime."*
  2. Ship a startup warning when the URL contains `:6543` (code change, one line in the `pg_listen` boot block).
  3. Watch `/health` → `site.pg_listen` after every deploy. `false` = realtime is down.
  4. `LISTEN` reconnect: current code tries targets once at boot (`for … return` on first success, `recordFailure` on all-fail). There is **no auto-reconnect** on mid-session drop — the `client.on("error")` handler only records. If the LISTEN connection dies silently mid-run, SSE goes quiet. Recommend a reconnect loop / periodic `pgListenUp` re-check as a follow-up.
- **Backfill interaction (C1):** every backfill upsert fires `docs_notify` → one SSE event per row to every connected client. Boot-ordering (backfill runs before clients connect on a fresh deploy) mostly covers this; 003's `WHEN` filter + a session-GUC skip closes it fully.

---

## 7. Open items for the implementation team (not this coordinator)

1. `003_notify_hardening.sql` — pending from Schema Hardening coordinator. Must use drop+recreate with `WHEN (NEW.collection IN (…))`.
2. PG branches in the 6 shared read helpers + `READ_PG_COLLECTIONS` semantics (or `PG_READS=1`).
3. PG-primary writes in `writeIdempotent` / `mutateDoc` + missed mirror sites (`react_to_message`, `pin_message`, activity, telemetry).
4. C2 server-side `since_ts` in `listNewest`; I4 `statement_timeout=10000`; `:6543` startup warning; richer dual-write failure logging.
5. Backfill coverage decision for non-message collections (code/dm/tasks/activity/notes) — extend `runBackfill` beyond `MESSAGES` or accept dual-write-only catch-up.
6. `pg_listen` reconnect logic.

---

*No code was modified in this review. All findings verified against commit `4ed2fde`. Cross-reference: `SUPABASE_SCHEMA_REVIEW.md` (critical/important findings), `SUPABASE_INVENTORY.md` (full Firestore dependency map).*
