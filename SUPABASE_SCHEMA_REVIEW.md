# Supabase Schema Review — Highway Chat MCP

**Reviewer:** schema-review subagent
**Date:** 2026-10-10
**Scope:** `migrations/001_init.sql`, `migrations/002_backfill_checkpoint.sql`, `src/store/postgres.ts`, `src/store/index.ts` (dual-write), `src/store/backfill.ts`, pg_listen wiring in `src/index.ts` / `src/site-api.ts`
**Status:** REVIEW ONLY — no migrations modified.

---

## Summary

The schema is a clean single-table (`highway.docs`) document seam: `(collection, id)` PK, JSONB `fields`, extracted `ts_num` for ordering. Index coverage matches the actual query patterns. The design correctly keeps the Firestore-shaped interface stable (interfaces permanent, implementations disposable).

Three issues are **critical** (fix before cutover), four are **important** (fix soon), the rest are nice-to-have.

---

## CRITICAL

### C1. Backfill upserts fire pg_notify on every row — SSE thundering herd

`001_init.sql` creates `docs_notify` trigger: `AFTER INSERT OR UPDATE ON highway.docs FOR EACH ROW` → `pg_notify('highway_events', ...)`.

`backfill.ts` backfills via sequential `store.upsert()` calls (page size 50). Every upsert fires the trigger → NOTIFY → `siteBus.publish` → fan-out to **all** connected SSE clients. A backfill of N thousand messages = N thousand SSE events pushed to every browser tab.

**Recommendation:** Make the trigger skippable during backfill. Options:
- `ALTER TABLE highway.docs DISABLE TRIGGER docs_notify` for the backfill session only (session-local, safe), re-enable after; or
- gate the trigger function on a session GUC, e.g. `WHEN (current_setting('highway.skip_notify', true) IS DISTINCT FROM '1')`, and have backfill `SET LOCAL highway.skip_notify = '1'`.

### C2. `since_ts` is filtered client-side after LIMIT 100 — silent message loss on PG reads

`src/index.ts:3017`: PG path fetches `listNewest(coll, min(max(limit,1),100))` then does `messages.filter(m => (m.ts ?? 0) > since_ts)`.

If more than 100 messages are newer than `since_ts` (busy room, client reconnects after hours), the older ones are **silently dropped**. The Firestore path does a real incremental `querySince` (index.ts:907). This is a behavior gap between backends.

**Recommendation:** push the predicate into SQL: add an optional `sinceTs` param to `listNewest` → `WHERE collection = $1 AND ($3::bigint IS NULL OR ts_num > $3)`. The existing `docs_newest` index serves this (range on second column).

### C3. pg_listen depends on Supabase pooler session mode — breaks silently on port 6543

`pg_listen` opens a dedicated `pg.Client` and issues `LISTEN highway_events` against `DATABASE_URL`. Current URL uses `aws-0-us-west-1.pooler.supabase.com:5432` (session-mode pooler → LISTEN works).

Supabase's **transaction-mode** pooler (port 6543) does **not** support LISTEN/NOTIFY. If anyone "fixes" the URL to the 6543 port, `pg_listen` fails at startup, `pgListenUp` stays false, `/health` shows `pg_listen:false`, and SSE realtime silently degrades to nothing — no crash, no loud alarm.

**Recommendation:** document the constraint next to `DATABASE_URL` (code comment + Render env description): *"pg_listen requires session-mode pooler (:5432 on pooler host) or direct connection. Port 6543 breaks realtime."* Consider a startup warning when the URL contains `:6543`.

---

## IMPORTANT

### I1. High-churn collections spam pg_notify (presence heartbeats)

`highway_presence` upserts on every client heartbeat (~45s/client). Each fires the trigger → NOTIFY → SSE fan-out to everyone. Typing indicators are worse (sub-second churn if migrated). This is pure noise: no SSE client needs a realtime event for someone else's heartbeat row.

**Recommendation:** restrict the trigger to low-churn collections:
```sql
CREATE TRIGGER docs_notify AFTER INSERT OR UPDATE ON highway.docs
FOR EACH ROW
WHEN (NEW.collection IN ('highway_messages','highway_code','highway_dm','highway_tasks','highway_activity'))
EXECUTE FUNCTION highway.highway_notify_doc();
```
(Trigger `WHEN` clauses can't call functions, but `IN` on NEW.collection is allowed.)

### I2. Dual-write secondary failures are swallowed — PG can drift silently

`createDualWriteStore`: secondary (PG) write failures are caught, logged, ignored. Primary (Firestore) is source of truth. If PG writes fail for an hour during dual-write, PG is missing an hour of data with no record of what was lost. The backfill `verify` (count/sample-hash) is a one-shot, not continuous.

**Recommendation (pick one):** (a) periodic verify job (count + sample-hash per collection, alert on mismatch); or (b) a `dual_write_failures` table/queue capturing failed secondary ops for replay. At minimum, log failures with collection+id (currently only the error message) so gaps are identifiable.

### I3. `highway_bridge` role needs least-privilege grants

The connection uses a dedicated `highway_bridge` role (per the ENOTFOUND error and migration header "owned by highway_bridge"). Nothing in the migrations sets ownership or revokes defaults. On Supabase, new roles can see the `public` schema and `pg_catalog` by default.

**Recommendation:** after creating the role:
```sql
REVOKE ALL ON SCHEMA public FROM highway_bridge;
GRANT USAGE, CREATE ON SCHEMA highway TO highway_bridge;
GRANT ALL ON ALL TABLES IN SCHEMA highway TO highway_bridge;
ALTER DEFAULT PRIVILEGES IN SCHEMA highway GRANT ALL ON TABLES TO highway_bridge;
```
Server-side-only access means RLS is unnecessary (no PostgREST exposure), but schema isolation is still worth doing.

### I4. No `statement_timeout` — one runaway query can exhaust the 5-connection pool

`postgresPool` sets `max: 5, connectionTimeoutMillis: 4000` but no `statement_timeout`. A stuck query holds a pool slot indefinitely; 5 stuck queries = total PG outage for the bridge (reads and dual-writes block).

**Recommendation:** add `statement_timeout` (e.g. 10s) via `options: '-c search_path=highway -c statement_timeout=10000'`.

---

## NICE-TO-HAVE

### N1. Migrations hardcode the `highway` schema; `DB_SCHEMA` override is broken for DDL

`migrate.ts` passes `schema` through, but both `.sql` files hardcode `highway.`. If `DB_SCHEMA` is ever set to something else, DDL and DML disagree. Either template the schema into the SQL or remove the `DB_SCHEMA` env knob. (Low risk: nothing sets DB_SCHEMA today.)

### N2. Dual-write secondary is sequential — adds write latency

`create()`/`upsert()`/`patch()`/`remove()` await primary, then await secondary. PG round-trip adds ~50–200ms to every write on the hot path. Fire-and-forget (`void secondary...`) would remove the latency but risks unobserved ordering issues. Given Render free-tier latency, acceptable for now; revisit if write p99 matters.

### N3. `updated_at` maintenance is manual

`upsert`/`patch` set `updated_at = now()` explicitly; `create` relies on the column default. Works, but a `BEFORE UPDATE` trigger would be more robust against future code paths that forget. Minor.

### N4. `countCollection` is fine; `listSampleDocs` uses PK correctly

`WHERE collection = $1` count can use the `docs_newest` index (leading column). `ORDER BY id ASC` sample uses the PK. No changes needed.

### N5. JSONB `fields` is the right call

Keeps the Firestore-shaped document interface stable across the seam. No hot-field extraction needed: no query filters on fields content, only on `collection`/`id`/`ts_num`. Revisit only if a field-filtered query appears.

### N6. `ts_num` nullable + `NULLS LAST` is handled correctly

Writes always populate `ts_num` (`tsNumOf(fields) ?? Date.now()`); backfill populates from Firestore fields. The index's `NULLS LAST` matches the query's `NULLS LAST`. The `row()` mapper falls back to `tsNumOf(fields)` when the column is null. Consistent.

---

## What is correct (no action)

- **Index/query alignment:** `docs_newest (collection, ts_num DESC NULLS LAST, created_at DESC)` exactly matches `listNewest`'s `WHERE` + `ORDER BY` + `LIMIT`. PK `(collection, id)` covers `get()`.
- **No vendor extensions:** trigger uses `pg_notify` + `json_build_object` (core PG). The "portable Postgres" claim holds — Supabase pooler compatible (session mode).
- **Schema-qualified DML with validated schema name:** `dbSchema()` regex-validates before interpolation; no SQL injection via `DB_SCHEMA`.
- **Probe isolation:** `startDbProbe` never blocks `/health`; `unref()`'d 60s timer. Good.
- **Backfill resumability:** `backfill_checkpoint` table with page_token + counters; idempotent upserts. Good.
- **Pooler + `pg` driver:** `pool.query(text, values)` uses unnamed portals — works on Supabase pooler in either mode for plain queries. Only LISTEN needs session mode (C3).

---

## Suggested migration 003 (for coordinator decision)

If the coordinator agrees, a `003_notify_hardening.sql` could:
1. Add `WHEN (NEW.collection IN (...))` to `docs_notify` (I1).
2. Optionally add the session-GUC skip for backfill (C1).

C2 (since_ts pushdown) and I4 (statement_timeout) are code changes in `postgres.ts` / `index.ts`, not DDL — separate PR.
