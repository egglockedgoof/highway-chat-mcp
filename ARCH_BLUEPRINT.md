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
Phase 3 (close ASAP). GitHub state checked 1:55 AM PT.
| Item | Owner | Status | Next |
|---|---|---|---|
| Piece A: legacy client sends caller Bearer token (PR #24, cursor/legacy-caller-creds-27e5) | coder 3 | review | Hollow review, merge. Then MCP_CALLERS set on Render (token minted by a coder, stored out of band), Hollow's client sends the Bearer, a bound write is proven |
| #14 token flip (spoof fix) | Nyx | in progress (draft; blocked on Piece A + Hollow re-review) | after Piece A |
| #12 money notes | Nyx | review | rebase, Hollow review, merge |
| #21 Unreal Protocol config (re-open of #20) | coder 3 | review | Hollow review, merge |
| #22 rules console mirror | coder 2 | review | Hollow review, merge |
| #23 tool-surface catalog (draft) | coder 2 | in progress | rook/ember must send idempotency_key after deploy |
| #16 read cache + since-last-seen reads | Nyx | in progress (draft) | TOP after #12: Highway read quota blew 1:30 AM |
| #9, #10, #11, #15, #17, #18, #19 | various | live (deploy d936044, 1:11 AM PT) | — |
Phase 4 (after phase 3 closes): Whisper's 4-piece compatibility scope in the Highway room. Status: todo.
Consolidation (from INVENTORY): status todo for all; see section 5.

## 5. Self-ranking priority queue
Rule: when Sin says "get this done", the TOP item fires through the whole chain (coder builds, Hollow fast-reviews, merge, deploy) with no further discussion. Coding agents own this ranking: highest impact + lowest risk first. Re-rank whenever an item finishes or a new one appears; one line of impact/risk each.
1. #16 read cache + since-last-seen. Impact: stops the daily read-quota blackout. Risk: low (bridge-only, draft exists).
2. #12 money notes. Impact: news feed value for Sin. Risk: low (review-ready).
3. Piece A #24. Impact: unblocks the spoof fix. Risk: low (client change + one env var name).
4. #14 token flip. Impact: closes name-spoofing. Risk: medium (bots without tokens lose write; flip only after every bot has a token).
5. #22 rules mirror + add missing live rules for system_config/crew_curated and approval_requests. Impact: curated news and approvals likely 403 today (unverified at runtime). Risk: low-medium (console deploy by Sin).
6. #21 Unreal Protocol / ESLint gate. Impact: code quality gate. Risk: low.
7. #23 tool-surface catalog. Impact: stable 63-tool client surface. Risk: low.
8. Retire dead weight: hollow-inbox, empty Firebase Hosting site, second MCP connector, unused push_subs. Impact: frees Render free hours, less attack surface. Risk: low (confirm no caller first).
9. Phase 4 pieces (Whisper's scope). Impact/risk: set when Whisper posts the 4 pieces.
10. Route site reads/writes through the bridge (no direct Firestore from browser). Impact: one writer, one rules story, quota control. Risk: medium (touches every tab).
11. Postgres service layer (section 6, steps 1-4). Impact: off Firebase lock-in. Risk: medium-high; dual-write first.
12. Incinerator pass on unused bridge tools (check track_tool_telemetry first). Impact: smaller surface. Risk: low.

## 6. Next goal: off Firebase
Target: core logic in a Postgres-backed service layer behind a thin API on Render; the website becomes a dashboard client; Firebase Auth kept only for sign-in until replaced.
Steps (pseudo-instructions, no code):
1. Add a storage seam in the bridge: one interface (messages, tasks, notes, activity, presence, locks, approvals, curated news) with a Firestore implementation (today's behavior) and a Postgres implementation. File: src/store/ (new), index.ts calls the interface only.
2. Create Render Postgres (free for dry run; Basic $6/month for real, since free expires in 30 days with no backups). Env var NAME: DATABASE_URL. Schema migrations in migrations/ (plain SQL).
3. Thin API: REST + server-sent events on the bridge (/api/messages, /api/tasks, ...), auth = Firebase ID token verified server-side, then bridge-issued session later.
4. Site: replace Firestore SDK listeners with the bridge API + SSE. The site holds no DB logic.
5. Dual-write -> backfill from Firestore export -> verify counts -> flip reads per collection -> stop Firestore writes -> archive.
6. Later device links (LIDAR, LEDs, robots): an MQTT broker (or gRPC service) next to the API; devices publish/subscribe through the service layer, never to the DB directly.
