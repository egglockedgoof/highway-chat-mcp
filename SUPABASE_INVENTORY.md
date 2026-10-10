# Supabase Migration — Firestore Dependency Inventory

**Repo:** `egglockedgoof/highway-chat-mcp`
**Commit:** `4ed2fde` (main)
**Date:** 2026-10-10
**Purpose:** Complete map of every Firestore dependency for the Supabase migration team.

---

## Architecture Summary

The backend talks to Firestore **exclusively via REST** (`https://firestore.googleapis.com/v1/projects/highway-chat/databases/(default)/documents`). There is **no firebase-admin SDK**, no `onSnapshot` listeners, no transactions, and no batch writes.

- **Choke point:** `sec.firestore(path, init)` in `src/security.ts` — every Firestore REST call flows through this wrapper (auth, allowlisting, error mapping).
- **Store abstraction:** `src/store/` defines a `Store` interface (`get/create/upsert/patch/remove/listNewest/close`) with three implementations:
  - `createFirestoreStore` — wraps the REST `firestore()` fn
  - `createPostgresStore` — uses `pg` Pool against Supabase Postgres
  - `createDualWriteStore` — primary + secondary shadow writes
- **⚠️ Critical gap:** `src/index.ts` does **NOT** use `createStore()` or `createDualWriteStore()`. Instead it uses a **manual mirror pattern**: a global `pgStore` (line 1182) plus explicit `mirrorToPg(coll, id, fields)` / `removeFromPg(coll, id)` calls at individual write sites. **Any write site missing a `mirrorToPg()` call silently skips Postgres.** This is the primary source of migration incompleteness.

### Migration control knobs (env vars)
| Var | Effect |
|---|---|
| `DATABASE_URL` / `DATABASE_URL_FALLBACK` | Postgres connection strings. Without these, pgStore stays null. |
| `STORE_DUAL_WRITE=1` | Enables `mirrorToPg`/`removeFromPg` (no-op otherwise). |
| `READ_PG_COLLECTIONS` | Comma-separated collections that read from Postgres instead of Firestore (e.g. `highway_messages`). Empty = all reads from Firestore. |
| `STORE_BACKEND=postgres` | Full cutover (not yet used in production; code path exists in `createStore`). |
| `BACKFILL_MESSAGES=1` | Boot-time backfill of `highway_messages` from Firestore → Postgres. |
| `DB_SCHEMA` | Postgres schema (default: `highway`). |

### Read-flip sites (already support Postgres reads)
- `readChannelMessages()` (line 1204) — MCP `read_messages` tool
- `search_messages` tool (line 1456)
- Site API `readMessages` (line 3009)

### Realtime replacement
- Firestore `onSnapshot` is **not used server-side**. The widget polls via REST/SSE.
- Supabase replacement: `pg LISTEN highway_events` → fans out to site SSE clients (`src/site-api.ts`, `PG_NOTIFY_CHANNEL`). Trigger `highway.highway_notify_doc()` fires on `highway.docs` inserts (see `migrations/001_init.sql`).

---

## Collection Inventory

### Legend
- ✅ **Migrated** — dual-write wired AND read-flip available
- 🔶 **Partial** — in `STORE_COLLECTIONS` but writes or reads not yet routed
- ❌ **Not started** — Firestore-only, no Postgres path
- ⚪ **N/A** — intentionally not migrating (confirm with sin)

---

### 1. `highway_messages` — 🔶 Partial (closest to done)
**What:** Core chat messages (room channel). Highest traffic collection.

| Direction | Code path | Postgres? |
|---|---|---|
| Write | `send_message` → `writeIdempotent()` (line 1343) → `mirrorToPg` (1348) | ✅ dual-write |
| Write | `send_message` non-idempotent path (1351) → `mirrorToPg` (1361) | ✅ dual-write |
| Write | `send_voice` (1377) → `mirrorToPg` (1386) | ✅ dual-write |
| Write | `react_to_message` → `mutateDoc` (1437) → **no mirrorToPg** | ❌ missed |
| Write | `pin_message` → `patchFields` → **no mirrorToPg** | ❌ missed |
| Write | `delete_message` (1425) → `removeFromPg` (1426) | ✅ dual-delete |
| Write | `edit_message` (1415) → `mirrorToPg` | ✅ dual-write |
| Read | `readChannelMessages` (1204) — `READ_PG_COLLECTIONS` flip | ✅ flippable |
| Read | `search_messages` (1456) — `READ_PG_COLLECTIONS` flip | ✅ flippable |
| Read | `read_pinned` → `queryDocs` (direct Firestore) | ❌ no pg path |
| Read | Site API `readMessages` (3009) — `READ_PG_COLLECTIONS` flip | ✅ flippable |
| Backfill | `src/store/backfill.ts` — boot backfill | 🔶 in error state (bad credentials) |

**Firestore-specific features used:** `:runQuery` with `orderBy` + `where` filters; `tsNum` numeric ordering (Firestore mixed-type `ts` workaround — Postgres `ts_num BIGINT` column handles this natively); document PATCH with `updateMask`.

**To finish:** Wire `mirrorToPg` into `react_to_message` and `pin_message` mutations. Add pg read path for `read_pinned`. Fix backfill credentials.

---

### 2. `highway_code` — 🔶 Partial
**What:** Code channel messages (same shape as `highway_messages`, routed via `channelCollection('code')`).

| Direction | Code path | Postgres? |
|---|---|---|
| Write | `send_message` with `channel='code'` → same `mirrorToPg` paths | ✅ dual-write |
| Read | `readChannelMessages` (1204) — flip works per-collection | ✅ flippable |

**To finish:** Same gaps as `highway_messages` (reactions, pins). In `STORE_COLLECTIONS`.

---

### 3. `highway_dm` — 🔶 Partial
**What:** DM channel messages (routed via `channelCollection('dm')`).

| Direction | Code path | Postgres? |
|---|---|---|
| Write | `send_message` with `channel='dm'` → same `mirrorToPg` paths | ✅ dual-write |
| Read | `readChannelMessages` (1204) — flip works per-collection | ✅ flippable |

**To finish:** Same gaps as `highway_messages`. In `STORE_COLLECTIONS`.

---

### 4. `highway_presence` — ❌ Not started
**What:** Presence heartbeats (one doc per user, ~45s heartbeat per tab).

| Direction | Code path | Postgres? |
|---|---|---|
| Write | `set_presence` → direct `firestore()` PATCH (line 1493) | ❌ **no mirrorToPg** |
| Read | `get_presence` → `queryPage` (direct Firestore) | ❌ no pg path |
| Read | Site API `readPresence` → `queryPage` (direct Firestore) | ❌ no pg path |

**Notes:** High-frequency writes (every 45s per active tab). In `STORE_COLLECTIONS` but zero Postgres wiring. Presence is ephemeral — consider whether it needs Postgres at all, or can stay Firestore / move to Redis-like ephemeral store.

**To finish:** Decide: migrate (wire mirrorToPg + pg reads) or de-scope as ephemeral.

---

### 5. `highway_typing` — ❌ Not started
**What:** Typing indicators (ephemeral, per-user docs).

| Direction | Code path | Postgres? |
|---|---|---|
| Write | Direct `firestore()` PATCH (line 1513) | ❌ **no mirrorToPg** |
| Read | Site API → `queryPage` (line 3036, direct Firestore) | ❌ no pg path |

**Notes:** **Not in `STORE_COLLECTIONS`.** Purely ephemeral — typing indicators have no durability requirement.

**To finish:** Almost certainly de-scope (keep on Firestore or drop). Confirm with sin.

---

### 6. `highway_tasks` — ❌ Not started
**What:** Task/todo items (Highway Tasks feed).

| Direction | Code path | Postgres? |
|---|---|---|
| Write | `create_task` → direct `firestore()` POST (line 1796) | ❌ **no mirrorToPg** |
| Write | `delete_task` → direct `firestore()` DELETE (line 1838) | ❌ **no removeFromPg** |
| Write | Site API task write (line 2121) → direct `firestore()` POST | ❌ **no mirrorToPg** |
| Read | `read_tasks` → `queryPage` (direct Firestore) | ❌ no pg path |
| Read | Site API `readTasks` → `queryPage` (direct Firestore) | ❌ no pg path |

**Notes:** In `STORE_COLLECTIONS` but zero Postgres wiring. Three separate write sites, all missed.

**To finish:** Add `mirrorToPg`/`removeFromPg` to all three write sites. Add `readsFromPg` check to `read_tasks` and site `readTasks`.

---

### 7. `highway_notes` — ❌ Not started
**What:** Shared notes (single `shared` doc + per-note docs).

| Direction | Code path | Postgres? |
|---|---|---|
| Write | `append_note` → `mutateDoc(NOTES, "shared", ...)` (line 1878) | ❌ **no mirrorToPg** |
| Read | `read_notes` → `queryPage`/`getDocOrNull` (direct Firestore) | ❌ no pg path |

**Notes:** In `STORE_COLLECTIONS` but zero Postgres wiring. Uses `mutateDoc` (read-modify-write with `updateTime` precondition for optimistic concurrency).

**Firestore-specific:** `mutateDoc` relies on Firestore `updateTime` preconditions. Postgres equivalent: `SELECT ... FOR UPDATE` or compare `updated_at` in the `WHERE` clause.

**To finish:** Wire mirrorToPg into `append_note`. Add pg read path. Handle optimistic-concurrency translation.

---

### 8. `highway_activity` — ❌ Not started
**What:** Activity feed (append-only log of events).

| Direction | Code path | Postgres? |
|---|---|---|
| Write | `postActivity`/`notify` → direct `firestore()` POST (line 970) | ❌ **no mirrorToPg** |
| Read | `read_activity` → `queryPage` (direct Firestore) | ❌ no pg path |

**Notes:** In `STORE_COLLECTIONS` but zero Postgres wiring. `notify()` is called from many tools (pins, task completion, etc.) — high fan-out.

**To finish:** Add `mirrorToPg` to `postActivity`. Add pg read path to `read_activity`.

---

### 9. `dispatch_locks` — ❌ Not started
**What:** Dispatch locks (prevent double-processing of routed messages). TTL-based.

| Direction | Code path | Postgres? |
|---|---|---|
| Write | `setDispatchLock` → `lockSetIo.create/overwrite` → direct `firestore()` PATCH with `precondition: {exists: false/true}` (lines 643-665) | ❌ no Postgres path |
| Write | `markLockClaimed` → `lockClaimIo.patch` → direct `firestore()` PATCH (line 748) | ❌ no Postgres path |
| Read | `checkDispatchLock` → `getLock` → `getDocOrNull` (direct Firestore) | ❌ no pg path |

**Notes:** In `STORE_COLLECTIONS`. **Uses Firestore preconditions (`exists: false`) for atomic create-if-not-exists** — this is the distributed lock primitive. The `io` objects (`lockSetIo`, `lockClaimIo`) are injectable for tests but always Firestore-backed in production.

**Firestore-specific:** Atomic conditional writes via `precondition`. Postgres equivalent: `INSERT ... ON CONFLICT DO NOTHING` + check `rowCount`.

**To finish:** This is the highest-risk migration (correctness-critical locking). Options: (a) route through the `Store` interface with Postgres `ON CONFLICT` semantics, or (b) keep on Firestore until last. Recommend (b) — locks are low-volume and Firestore is fine for them.

---

### 10. `approval_requests` — ❌ Not started
**What:** HITL approval requests.

| Direction | Code path | Postgres? |
|---|---|---|
| Write | Direct `firestore()` PATCH (line 2156) | ❌ **no mirrorToPg** |
| Read | `getDocOrNull` (direct Firestore) | ❌ no pg path |

**Notes:** In `STORE_COLLECTIONS` but zero Postgres wiring. Low volume.

**To finish:** Add mirrorToPg to write site. Add pg read path.

---

### 11. `system_config` — ❌ Not started
**What:** System configuration docs (`crew_curated`, `apify_last_run`, `hardware_relay_buffer`, skill docs).

| Direction | Code path | Postgres? |
|---|---|---|
| Write | `mutateDoc(SYS_CONFIG, SKILL_DOC, ...)` (line 2846) | ❌ **no mirrorToPg** |
| Write | Hardware relay buffer POST (line 2041) | ❌ **no mirrorToPg** |
| Write | Security telemetry `apifyWrite` op (security.ts ~line 907) | ❌ no pg path |
| Read | `curatedRead` — allowlisted GET of `crew_curated` | ❌ no pg path |

**Notes:** In `STORE_COLLECTIONS` but zero Postgres wiring. Config reads are on hot paths (news rebuild, etc.).

**To finish:** Add mirrorToPg to write sites. Add pg read path for `curatedRead`.

---

### 12. `evolution_logs` — ❌ Not started
**What:** Evolution/memory timeline (milestones, corrections, telemetry).

| Direction | Code path | Postgres? |
|---|---|---|
| Write | Telemetry `recordFailure` → direct `firestore()` POST (line 796) | ❌ no pg path |
| Write | `remember` tool → direct POST (lines 1523, 1563) | ❌ no pg path |
| Write | Tool telemetry POST (line 2254) | ❌ no pg path |
| Read | `recall` tool → `queryNewestNum` (direct Firestore) | ❌ no pg path |
| Read | Line 2289 — single-doc GET | ❌ no pg path |

**Notes:** **Not in `STORE_COLLECTIONS`.** Uses `tsNum`-only ordering (`queryNewestNum`). Memory flywheel — narratively important per sin's directives.

**To finish:** Add to `STORE_COLLECTIONS`, wire dual-write, add pg read path for `recall`.

---

### 13. `jarvis_memory` — ❌ Not started
**What:** Durable user preferences / memory store.

| Direction | Code path | Postgres? |
|---|---|---|
| Write | `store_preference` → direct `firestore()` POST (line 1553) | ❌ no pg path |
| Read | `recall` → `queryNewestNum` (direct Firestore) | ❌ no pg path |

**Notes:** **Not in `STORE_COLLECTIONS`.** Same shape as `evolution_logs`.

**To finish:** Add to `STORE_COLLECTIONS`, wire dual-write, add pg read path.

---

### 14. `security_telemetry` — ❌ Not started
**What:** Security telemetry write-through buffer (REV 19).

| Direction | Code path | Postgres? |
|---|---|---|
| Write | `security.ts` write-through buffer → `sec.firestore` (lines 483-760) | ❌ no pg path |
| Read | None (write-only log) | — |

**Notes:** **Not in `STORE_COLLECTIONS`.** Write-only. Uses conditional commit with `FAILED_PRECONDITION`/`ALREADY_EXISTS` handling.

**To finish:** Low priority (write-only log). Can stay on Firestore or add to store later.

---

### 15. `highway_idempotency` — ⚪ Unclear
**What:** Single string-reference found (single-quoted). May be legacy.

**To finish:** Verify if still used. If dead code, remove. If live, assess.

---

## Firestore-Specific Features in Use

| Feature | Where | Postgres equivalent | Risk |
|---|---|---|---|
| `:runQuery` structured queries (`orderBy` + `where` + `limit`) | `queryDocs`, `queryPage`, `querySince` | `SELECT ... WHERE ... ORDER BY ... LIMIT` | Low — straightforward |
| `:runAggregationQuery` (count) | `countDocs`, `countDocsWhere` | `SELECT COUNT(*)` — already in `postgres.ts` as `countCollection` | Low |
| PATCH with `precondition: {exists: false}` (atomic create) | `lockSetIo.create`, `writeIdempotent` via `idemIo` | `INSERT ... ON CONFLICT DO NOTHING` | **Medium** — lock correctness |
| PATCH with `precondition: {exists: true}` (atomic overwrite) | `lockSetIo.overwrite`, `lockClaimIo.patch` | `UPDATE ... WHERE id = ...` + check rowCount | Medium |
| `updateTime` precondition (optimistic concurrency) | `mutateDoc` (reactions, notes, skills) | `UPDATE ... WHERE updated_at = $old` or `SELECT FOR UPDATE` | **Medium** — lost-update risk |
| Mixed-type `ts` ordering (string vs timestamp) | `queryDocs` merge logic, `mergeNewest` | Native `ts_num BIGINT` column — **already solved** in Postgres schema | Low |
| Document ID auto-generation | `firestore()` POST (server assigns) | `newId()` in `types.ts` — already client-generated | Low |
| `documentId` option on POST | `SYS_CONFIG` hardware_relay_buffer write | Explicit `id` in `INSERT` | Low |

**NOT used:** `onSnapshot` (no server-side listeners), transactions (`beginTransaction`/`commit`), `batchWrite`, collection group queries.

---

## What's Already Abstracted vs Direct

### Abstracted (goes through `Store` interface)
- `src/store/firestore.ts` — `createFirestoreStore` wraps REST calls
- `src/store/postgres.ts` — `createPostgresStore` with `pg` Pool
- `src/store/index.ts` — `createStore`, `createDualWriteStore`, `readPgCollections`
- `src/store/backfill.ts` — `highway_messages` backfill with checkpoints
- `src/store/migrate.ts` — SQL migration runner
- `migrations/001_init.sql`, `002_backfill_checkpoint.sql` — schema

### Direct (bypasses `Store`, hits `sec.firestore` REST directly)
**All of `src/index.ts`** except the three read-flip sites and `mirrorToPg` call sites. Specifically:
- 29 direct `firestore()` call sites in `index.ts`
- `lockSetIo` / `lockClaimIo` (dispatch locks)
- `getDocOrNull`, `listDocs`, `queryDocs`, `queryPage`, `querySince`, `countDocs`, `mutateDoc`, `patchFields`
- `postActivity` / `notify`
- All MCP tool handlers except the pg-flipped reads

### The core problem
The migration uses a **manual mirror pattern** instead of the `Store` abstraction. Every new write site must remember to call `mirrorToPg()`. The `createDualWriteStore` in `src/store/index.ts` is **dead code in production** — `index.ts` never calls `createStore()`.

**Recommendation:** Refactor `index.ts` to route all collection I/O through a single `Store` instance (built by `createStore()`), replacing direct `firestore()` calls and manual `mirrorToPg()` with the already-tested `createDualWriteStore`. This eliminates the "missed write site" class of bugs permanently. This is a large refactor but it's the correct long-term fix per sin's "interfaces are permanent, implementations are disposable" principle.

---

## Migration Status Summary

| Collection | In STORE_COLLECTIONS | Dual-write | PG reads | Status |
|---|---|---|---|---|
| `highway_messages` | ✅ | 🔶 (missed: reactions, pins) | ✅ (flippable) | **Partial** |
| `highway_code` | ✅ | 🔶 (same gaps) | ✅ (flippable) | **Partial** |
| `highway_dm` | ✅ | 🔶 (same gaps) | ✅ (flippable) | **Partial** |
| `highway_presence` | ✅ | ❌ | ❌ | **Not started** |
| `highway_typing` | ❌ | ❌ | ❌ | **Not started** (likely de-scope) |
| `highway_tasks` | ✅ | ❌ (3 write sites missed) | ❌ | **Not started** |
| `highway_notes` | ✅ | ❌ | ❌ | **Not started** |
| `highway_activity` | ✅ | ❌ | ❌ | **Not started** |
| `dispatch_locks` | ✅ | ❌ | ❌ | **Not started** (recommend keep on Firestore) |
| `approval_requests` | ✅ | ❌ | ❌ | **Not started** |
| `system_config` | ✅ | ❌ | ❌ | **Not started** |
| `evolution_logs` | ❌ | ❌ | ❌ | **Not started** |
| `jarvis_memory` | ❌ | ❌ | ❌ | **Not started** |
| `security_telemetry` | ❌ | ❌ | ❌ | **Not started** (low priority) |
| `highway_idempotency` | ❌ | ❌ | ❌ | **Unclear** (verify usage) |

### Suggested migration order
1. **Fix credentials** — unblock backfill and pgStore connection (blocking everything)
2. **Finish `highway_messages`** — wire reactions + pins, fix backfill (highest traffic)
3. **`highway_tasks`, `highway_notes`, `highway_activity`** — straightforward dual-write additions
4. **`approval_requests`, `system_config`** — low volume, easy wins
5. **`evolution_logs`, `jarvis_memory`** — add to STORE_COLLECTIONS, wire up (memory flywheel)
6. **`highway_presence`** — decide: migrate or de-scope as ephemeral
7. **`dispatch_locks`** — keep on Firestore (correctness-critical, low volume)
8. **`highway_typing`, `security_telemetry`** — de-scope or last
9. **Long-term:** refactor `index.ts` to use `createStore()` instead of manual mirroring

---

## Files Reference

| File | Role in migration |
|---|---|
| `src/store/types.ts` | `STORE_COLLECTIONS` list, `Store` interface |
| `src/store/index.ts` | `createStore`, `createDualWriteStore`, env flag readers |
| `src/store/postgres.ts` | `pg` Pool, `createPostgresStore`, health probe |
| `src/store/firestore.ts` | `createFirestoreStore` (REST wrapper) |
| `src/store/backfill.ts` | `highway_messages` backfill logic |
| `src/store/boot-backfill.ts` | Boot-time backfill orchestration |
| `src/store/migrate.ts` | SQL migration runner |
| `src/index.ts` | **All direct Firestore usage** (29 call sites) + manual mirror |
| `src/security.ts` | `sec.firestore` choke point, write-through telemetry buffer |
| `src/rules-read.ts` | `BRIDGE_READ_COLLECTIONS` (Firestore rules CI check) |
| `src/site-api.ts` | Site REST API + `pg LISTEN` for SSE |
| `src/read-cache.ts` | Firestore read cache (TTL-based, quota protection) |
| `src/channel-cache.ts` | In-memory channel message cache |
| `migrations/001_init.sql` | `highway` schema, `docs` table, notify trigger |
| `migrations/002_backfill_checkpoint.sql` | Backfill checkpoint table |
