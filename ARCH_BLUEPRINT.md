# ARCH_BLUEPRINT.md: single hand-off file for every coding agent
Updated Sat Oct 10, 2026, ~2:00 AM PT by MONEY SNATCHER 3000 (blueprints only, no code). Full inventory: marrowz/INVENTORY_2026-10-10.md. Previous version: ARCH_BLUEPRINT.bak_2026-10-10_0141.md.

## 1. Standing hand-off rule
"Do not write out the code changes. Provide only the architectural blueprint, file paths, and pseudo-instructions for my coding agents to execute."
- Every coding agent (Nyx, coder 2, coder 3, Cursor agents, Muse, any other) reads this file before touching code.
- When a slice is done, the agent flips its item's status in section 4 and re-ranks section 5.
- Rules: lean, minimal, built to last; Unreal Protocol (marrowz/unreal_protocol.md); Hollow fast-reviews before every merge; never force-push main; no secrets in git or chat (env var NAMES only).

## 2. Architecture now (verified 1:50 AM PT)
- Highway Chat web app: static site (money-city-ui repo) on GitHub Pages. Talks DIRECTLY to Firebase Auth + Firestore (8 live listeners), and to the bridge for /news, /metrics/reads, /upload.
- highway-chat-mcp bridge: Node/TypeScript MCP server on Render (free, Oregon, auto-deploys main). 63 MCP tools. Signs in as each bot and reads/writes Firestore over REST. Read cache + daily read meter. Talks to Cloudinary (uploads), Pinecone (shared brain), Apify (paid tools), public market/news APIs.
- Bots: MCP callers via Bearer token (MCP_CALLERS) or legacy /mcp/<secret> path (LEGACY_PATH_AUTH=on, the spoof hole).
- Firebase project highway-chat: Firestore (free tier, 50K reads/day, blew at 1:30 AM) + Auth. Rules deployed by hand; repo copy is not the live file.
- hollow-inbox: tiny in-memory webhook inbox on Render (free). No live caller found.
- CI: GitHub Actions (tsc + tests on every PR/push); "THE STATIC" pings /health every 4 h.
- MONEY CITY local stack (/workspace/money-city-ui-publish, Ollama, :8765/:8787): not live, not in a repo.
- Not used: Railway (no projects), Render Postgres/Key Value (none), Firebase Hosting (empty site).

## 3. File paths and component map
| Path | What | Lives on |
|---|---|---|
| highway-chat-mcp/src/index.ts | Bridge entry: Express routes (/mcp, /upload, /health, /metrics/reads, /news) + all 63 MCP tools | Render highway-chat-mcp |
| src/security.ts, src/identity (tests) | Caller auth, MCP_CALLERS binding, legacy path | Render |
| src/read-cache.ts | Bridge read cache + read meter | Render |
| src/curated-news.ts, src/privacy.ts | Crew-curated news doc (system_config/crew_curated), editor + PII gate | Render |
| src/brain.ts | Pinecone remember/recall/dream | Render -> Pinecone |
| src/cloudinary-upload.ts | /upload to Cloudinary | Render -> Cloudinary |
| src/orient.ts, src/reflect.ts, src/skills.ts | Session orient, Reflection Engine, team skills | Render |
| src/client-metrics.ts, src/message-limits.ts, src/rules-read.ts | Widget read metrics, message caps, rules coverage check | Render |
| firestore.rules (repo) | Read-coverage summary, NOT the deployed rules (#22 fixes) | GitHub only |
| render.yaml, .env.example, README.md | Service + env var names | GitHub/Render |
| scripts/smoke.ts | Post-deploy smoke | run by reviewer |
| .github/workflows/ci.yml, defibrillator.yml | CI gate, /health pinger | GitHub Actions |
| money-city-ui/index.html, highway.js, highway.css, sw.js, manifest.json | Highway site | GitHub Pages |
| hollow-inbox/hollow-inbox.js | Webhook inbox | Render hollow-inbox |
| /workspace/firebase-highway/ | Live rules backup + firebase.json | box |
| /home/box/shared/marrowz/ | Ops board, blueprint, inventory, handoffs | box |

## 4. Status board (todo / in progress / review / merged / live)
Phase 3 (close ASAP). GitHub state checked 1:55 AM PT; Nyx flip Sat Oct 10 ~2:10 AM PT.
| Item | Owner | Status | Next |
|---|---|---|---|
| Piece A: legacy client sends caller Bearer token (PR #24, cursor/legacy-caller-creds-27e5) | coder 3 | review | merge after CI + Snatcher (Hollow on hold). Then MCP_CALLERS set on Render (token minted by a coder, stored out of band), a bound write is proven |
| #14 token flip (spoof fix) | Nyx | in progress (draft; blocked on Piece A + MCP_CALLERS on Render) | after Piece A |
| #12 money notes | Nyx | review | keep green; do not merge until Sin says |
| #21 Unreal Protocol config (re-open of #20) | coder 3 | review | CI + Snatcher |
| #22 rules console mirror | coder 2 | review | CI + Snatcher |
| #23 tool-surface catalog (draft) | coder 2 | in progress | rook/ember must send idempotency_key after deploy |
| #16 read cache + since-last-seen reads | Nyx | merging (CI green) | land then site-via-bridge |
| §7.2 site via bridge (no browser Firestore listeners) | Nyx | PAUSED | no write access to money-city-ui (admin/maintain/pull/push/triage all false). Keep moving. |
| §7.5 storage seam | coder 2 | review (PR #28, CI green) | Nyx wires MCP after it lands |
| §7.6 thin API + SSE (LISTEN/NOTIFY, one DB listener) | Nyx | merging (PR #26, CI green) | additive; no read flip |
| §7.7 dual-write / read flip (messages first) | Nyx + coder 3 | in progress / flip PAUSED | DATABASE_URL live; flip waits on coder 3 count verify. Flag rollback. |
| #9, #10, #11, #15, #17, #18, #19 | various | live (deploy d936044, 1:11 AM PT) | — |
Phase 4 (after phase 3 closes): Whisper's 4-piece compatibility scope in the Highway room. Status: todo. Do not contact Whisper or Hollow.
Consolidation (from INVENTORY): status todo for all; see section 5.

## 5. Self-ranking priority queue
Rule: when Sin says "get this done", the TOP item fires through the whole chain (coder builds, CI + Snatcher review, merge, deploy) with no further discussion. Hollow is on hold — do not contact. Coding agents own this ranking: highest impact + lowest risk first. Re-rank whenever an item finishes or a new one appears; one line of impact/risk each. §7a applies to every data-path item.
1. #16 read cache (CI green). Impact: stops the daily read-quota blackout. Risk: low.
2. §7.6 thin API + SSE (PR #26, CI green). Impact: site can drop Firestore listeners. Risk: low.
3. §7.2 site via bridge. Impact: kills the 8 browser listeners. Risk: medium. PAUSED — no money-city-ui write access.
4. Wire MCP/connectors through `src/store` (after #28). Impact: no direct Firebase from tool paths. Risk: low if dual-write + flag default Firestore.
5. §7.7 messages read flip. Impact: off Firebase reads for the hot collection. Risk: medium. PAUSED until coder 3 count verify. Instant rollback: flag off.
6. #12 money notes. Impact: news feed value. Risk: low. Do not merge until told.
7. Piece A #24 then #14 token flip. Impact: closes name-spoofing. Risk: medium after every bot has a token.
8. #22 rules mirror. Impact: curated news / approvals rules. Risk: low-medium.
9. #21 Unreal / ESLint. Impact: quality gate. Risk: low.
10. #23 tool-surface catalog. Impact: stable 63-tool surface. Risk: low.
11. Retire dead weight (hollow-inbox, Hosting, second connector, push_subs). Risk: low. Wait on deletes.
12. Incinerator pass on unused bridge tools. Risk: low.

## 6. Next goal: off Firebase
Target: core logic in a Postgres-backed service layer behind a thin API on Render; the website becomes a dashboard client; Firebase Auth kept only for sign-in until replaced.
Steps (pseudo-instructions, no code):
1. Add a storage seam in the bridge: one interface (messages, tasks, notes, activity, presence, locks, approvals, curated news) with a Firestore implementation (today's behavior) and a Postgres implementation. File: src/store/ (new), index.ts calls the interface only.
2. Create Render Postgres (free for dry run; Basic $6/month for real, since free expires in 30 days with no backups). Env var NAME: DATABASE_URL. Schema migrations in migrations/ (plain SQL).
3. Thin API: REST + server-sent events on the bridge (/api/messages, /api/tasks, ...), auth = Firebase ID token verified server-side, then bridge-issued session later.
4. Site: replace Firestore SDK listeners with the bridge API + SSE. The site holds no DB logic.
5. Dual-write -> backfill from Firestore export -> verify counts -> flip reads per collection -> stop Firestore writes -> archive.
6. Later device links (LIDAR, LEDs, robots): an MQTT broker (or gRPC service) next to the API; devices publish/subscribe through the service layer, never to the DB directly.

## 7. SUPABASE MOVE (APPROVED by Sin, Oct 10 2026 2:07 AM PT). Source: marrowz/EVOLUTION_PATH_2026-10-10.md
Design: Firebase data -> Postgres on Supabase Free. The bridge is the ONLY reader/writer of the DB; the website never touches a database directly. Plain `pg` driver + `DATABASE_URL` only (no Supabase SDK in core paths) so a later move to Render Postgres is dump/restore. Live updates = bridge SSE fed by Postgres LISTEN/NOTIFY.
Free-tier limits to design around: 500 MB DB, 5 GB/mo egress + 5 GB cached, 200 realtime connections, 2M realtime msgs/mo, 1 GB storage, 50k MAU, NO automatic backups, pauses after 1 week inactive. Since-last-seen reads only; keep payloads small.
Merge gate while Hollow is on hold: required CI (install, tsc, tests, smoke) green + MONEY SNATCHER 3000 review. Do not contact Whisper or Hollow.
Steps (owner / status):
1. Gate: make CI checks required on main (branch protection; if no admin API access, say so). Owner: coder 3. Status: review (PR #27)
2. Merge #16 read cache (after CI green), then route money-city-ui site through the bridge only (no browser Firestore listeners). Owner: Nyx. Status: #16 merging (CI green). Site routing PAUSED — no write access to money-city-ui (admin/maintain/pull/push/triage all false).
3. Prep removal PRs: push_subs code, duplicate connector docs, Hosting config. Service/project deletions (hollow-inbox, Firebase Hosting site, second connector) WAIT for Sin's approval. Owner: coder 2. Status: todo
4. DONE 2:15 AM PT: Supabase project keysean-highway (ref wxqzwicmxdrqoutwyvss, us-west-1, Free, org Sin Inc). Bridge-only role highway_bridge owns schema highway. Render env set: DATABASE_URL (session pooler aws-0-us-west-1:5432), DATABASE_URL_FALLBACK (aws-1-us-west-1:5432), DB_SCHEMA=highway. Box cannot reach Postgres ports, so first connection test must run on Render: storage layer tries DATABASE_URL then FALLBACK and logs which host works (no secrets in logs). Status: done
5. Storage seam src/store/ (Firestore impl + Postgres impl), plain-SQL migrations/, CI runs migrations, nightly pg_dump via GitHub Actions to a private location. Owner: coder 2. Status: review (PR #28)
6. Thin API + SSE on the bridge (/api/messages, /api/tasks, ...), Firebase ID token verified server-side. Owner: Nyx (after step 2). Status: merging (PR #26, CI green). No read flip in this slice.
7. Dual-write, backfill from Firestore export, compare counts, flip reads one collection at a time (messages first), Firestore -> read-only archive. Owner: coder 3 (backfill/verify scripts) + Nyx (flip). Status: flip PAUSED — waiting coder 3 count verify. Dual-write/MCP wire in progress. Instant-rollback flag required.
8. Brain -> pgvector, uploads -> Supabase Storage. Owner: coder 3. Status: later
9. Auth -> Supabase Auth / bridge sessions; Firebase project deletion is Sin's call. Status: later
10. Graduation: DB > ~400 MB or Sin wants same-host backups -> pg_dump to Render Postgres Basic ($6/mo). Status: later
Rule: small PRs, lean code, Unreal Protocol, never force-push main, no secrets in git or chat. Flip your status line here when a slice lands.

### 7a. ZERO-DOWNTIME RULE (Sin, Oct 10 2:09 AM PT): "Highway stays operational, functional, and beautiful."
- The bridge keeps serving reads and writes at every step. Dual-write before any read flip; flip one collection at a time behind a flag with instant rollback.
- Every PR touching the data path says in its description: downtime risk (none/low/high) and rollback step. Any step that could take Highway down: STOP, mark status "PAUSED - downtime risk", and wait for MONEY SNATCHER 3000.
- Deploys only after CI + smoke green; post-deploy smoke must pass or roll back immediately.
- No UI regressions: the site keeps its current look; any visual change ships with before/after screenshots in the PR.
- Free-tier guardrails: stay under 150 of 200 realtime connections (bridge holds ONE DB listener and fans out via SSE), under 1.5M of 2M realtime msgs/mo, under 4 GB of 5 GB egress/mo; since-last-seen reads only; log daily usage to the bridge metrics.

### 7b. FULL AUTONOMY MANDATE (Sin, Oct 10 2:15 AM PT): "I green light everything. Get this running."
- Run the whole move to completion with NO further approvals from Sin and NO messages to him. MONEY SNATCHER 3000 is the reviewer/merger of record; merge on CI green + Snatcher review.
- Downtime: a temporary takedown is OK ONLY if it is guaranteed to come back up (tested rollback, flag flip, or redeploy of a known-good commit). Any uncertainty: mark PAUSED in this file with the reason and move to other work. Never ask Sin.
- Scope: dual-write -> backfill + count verify -> read flip one collection at a time (messages first) -> site reroute to bridge API/SSE -> MCP server and every connector off direct Firebase -> nightly pg_dump backup -> brain to pgvector, uploads to Supabase Storage -> auth move (bot accounts re-provisioned) -> Firebase project deletion LAST, only after: every collection flipped and verified, auth moved and all bots/site signing in on the new path for 24h clean, and a final full Firestore export saved.
- Every step logs a line in marrowz/move_log.md (time PT, step, result, any downtime and how long).
- Nyx report channel for this run: PR links + status + blockers only (Sin asked in-band).
