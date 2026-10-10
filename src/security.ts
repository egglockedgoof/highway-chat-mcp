// src/security.ts — REV 19 bridge security implementation (local proof).
//
// WHAT THIS IS: a standalone, locally-runnable implementation of the REV 19 design
// (~/workspace/marrow-amendments/bridge-security-design.md). It is NOT the bridge:
// no bridge repo files were touched, no live Firestore calls are made (all I/O goes
// through an injected transport; tests use a mock). It exists to produce
// implementation-level evidence for Hollow's independent review.
//
// STRUCTURE:
//   Part 1 — pure functions, ported 1:1 from ../security-verify/security.js (59/59).
//            Logic fidelity over language: identical semantics, TypeScript types added.
//   Part 2 — integration layer: firestore() choke-point wrapper, ALS request context,
//            telemetry store (§3e), auth route logic (§1), Apify claim (§3f).
//
// LESSONS HONORED (see ../lessons-register.md):
//   #18 choke-point enforcement — allowlist checked inside firestore(), not by convention.
//   #22 duplicate-header semantics — headersDistinct/rawHeaders, proven by real-HTTP test.
//   #23 no query strings in paths — rejected before anything else.
//   #26 malformed timestamps → invalid, rejected.
//   #29 doc/implementation parity — this file IS the implementation the doc describes.
//   #30 durability precedes acknowledgment — bound write-through INSIDE the signal
//            recorder, off the auth path (reconciled with hollow #34: the auth path never
//            awaits telemetry; pending signals fail readiness closed per #31).
//   #31 pending write-through tracked — readiness fail-closed while pending.
//   #32 global precondition validation — before any branch, for every caller.

import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';

// ============================================================================
// Part 1 — pure functions (ported 1:1 from security-verify/security.js)
// ============================================================================

export const SYSTEM_BOT = 'system';

/** Canonical bot identity: trim, lowercase, collapse spaces / _ / - so
 *  "MONEY SNATCHER 3000", "money-snatcher-3000", and "money snatcher 3000"
 *  resolve to the same BOT_CREDENTIALS / MCP_CALLERS row. */
export function normalizeBotName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

// --- §1b: Authorization parsing ---
// Node joins duplicate headers with ", " in req.headers (except set-cookie), so an
// Array.isArray check on req.headers NEVER fires for Authorization. Read the
// duplicate-preserving representations instead.

export type ParsedAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'malformed'; reason: string }
  | { kind: 'ambiguous' };

export interface AuthRequest {
  headersDistinct?: Record<string, string | string[] | undefined>;
  rawHeaders?: string[];
}

export function getAuthorizationValues(req: AuthRequest): string[] | undefined {
  const distinct = req.headersDistinct?.['authorization'];
  if (distinct !== undefined) return Array.isArray(distinct) ? distinct : [distinct];
  const out: string[] = [];
  const raw: string[] = req.rawHeaders || [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'authorization') out.push(raw[i + 1]);
  }
  return out.length ? out : undefined;
}

export function parseBearer(req: AuthRequest): ParsedAuth {
  const vals = getAuthorizationValues(req);
  if (!vals) return { kind: 'none' };
  if (vals.length !== 1) return { kind: 'ambiguous' }; // duplicates → reject, no fallback
  const h = vals[0];
  if (!h.trim()) return { kind: 'malformed', reason: 'empty' };
  const m = h.match(/^\s*([A-Za-z]+)\s*(.*?)\s*$/);
  if (!m) return { kind: 'malformed', reason: 'unparseable' };
  const scheme = m[1].toLowerCase(), token = m[2];
  if (scheme === 'bearer') {
    if (!token) return { kind: 'malformed', reason: 'missing_token' };
    return { kind: 'bearer', token };
  }
  if (scheme.startsWith('bearer')) return { kind: 'malformed', reason: 'bad_scheme' };
  return { kind: 'none' }; // Basic + other schemes → ignored
}

// --- §3b: Write detection (exact-equality default-deny classifier) ---

export function isWriteRequest(method: string, path: string): boolean {
  if (method === 'GET') return false;
  if (method === 'POST' && (path === ':runQuery' || path === ':runAggregationQuery')) return false;
  return true; // default-deny
}

// --- §3c: System allowlist + preconditions ---
// Default-deny. Preconditions are first-class (typed param), NEVER embedded in the path string.
// Paths containing '?' are rejected by firestore() before this check (no query smuggling).

export type SystemOp =
  | 'recordFailure' | 'track_tool_telemetry' | 'apifyWrite'
  | 'apifyState' | 'flushSecurityTelemetry' | 'readSecurityTelemetry'
  | 'curatedRead' | 'curatedWrite';
export type Precondition = 'none' | 'exists-false' | 'updateTime' | 'either';
export type PreconditionKind = 'none' | 'exists-false' | 'updateTime' | 'both' | 'invalid';

export interface PreconditionInput {
  exists?: boolean;
  updateTime?: string;
}

export const SYSTEM_ALLOWLIST: Record<SystemOp, Array<{ docPath: string; method: string; precondition: Precondition }>> = {
  recordFailure:          [{ docPath: '/evolution_logs',    method: 'POST',  precondition: 'none' }],
  track_tool_telemetry:   [{ docPath: '/evolution_logs',    method: 'POST',  precondition: 'none' }],
  apifyWrite:             [{ docPath: '/system_config/apify_last_run', method: 'PATCH', precondition: 'either' }],
  apifyState:             [{ docPath: '/system_config/apify_last_run', method: 'GET',   precondition: 'none' }],
  // Whole-doc replace, one PATCH, no precondition (last batch wins). 'either'
  // would force a GET for updateTime plus a second write.
  curatedRead:            [{ docPath: '/system_config/crew_curated', method: 'GET',   precondition: 'none' }],
  curatedWrite:           [{ docPath: '/system_config/crew_curated', method: 'PATCH', precondition: 'none' }],
  flushSecurityTelemetry: [
    { docPath: '/security_telemetry', method: 'GET',   precondition: 'none' },
    // Creation uses PATCH with exists=false — POST is NOT allowlisted (removed per review).
    { docPath: '/security_telemetry', method: 'PATCH', precondition: 'either' },
  ],
  readSecurityTelemetry:  [{ docPath: '/security_telemetry', method: 'GET',   precondition: 'none' }],
};

// Firestore updateTime: RFC 3339 UTC, e.g. 2026-10-08T18:32:00.123456Z.
// Malformed or empty timestamps are never accepted as preconditions.
export function isValidTimestamp(s: unknown): boolean {
  if (typeof s !== 'string' || !s) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) return false;
  return !Number.isNaN(Date.parse(s));
}

export function preconditionKind(precondition?: PreconditionInput): PreconditionKind {
  const hasExists = precondition?.exists === false;
  const rawUT = precondition?.updateTime;
  const hasUpdateTime = isValidTimestamp(rawUT);
  const hasBadUpdateTime = rawUT !== undefined && !hasUpdateTime;
  if (hasBadUpdateTime) return 'invalid';
  if (hasExists && hasUpdateTime) return 'both';
  if (hasExists) return 'exists-false';
  if (hasUpdateTime) return 'updateTime';
  return 'none';
}

export interface ScopeResult {
  ok: boolean;
  reason?: string;
  pc?: PreconditionKind;
}

export function checkSystemScope(sysOp: string, path: string, method: string, precondition?: PreconditionInput): ScopeResult {
  if (path.includes('?')) return { ok: false, reason: 'query-in-path' };
  const pc = preconditionKind(precondition);
  if (pc === 'invalid') return { ok: false, reason: 'bad-timestamp', pc };
  const entries = (SYSTEM_ALLOWLIST as Record<string, Array<{ docPath: string; method: string; precondition: Precondition }>>)[sysOp] || [];
  const allowed = entries.some(a =>
    a.docPath === path && a.method === method &&
    (a.precondition === 'either'
      ? (pc === 'exists-false' || pc === 'updateTime') // exactly one — never none, never both, never invalid
      : a.precondition === pc)
  );
  return allowed ? { ok: true } : { ok: false, reason: 'not-allowlisted', pc };
}

// Global precondition validation — applies to ALL callers, not just system.
// A malformed precondition must never silently become an unconditional request.
export function validatePreconditionGlobal(precondition?: PreconditionInput): { ok: boolean; reason?: string; pc?: PreconditionKind } {
  const pc = preconditionKind(precondition);
  if (pc === 'invalid') return { ok: false, reason: 'bad-timestamp' };
  if (pc === 'both') return { ok: false, reason: 'contradictory-precondition' };
  return { ok: true, pc };
}

// Bound-signal write-through tracking — fail closed while pending/failed.
// An entry is added when a throttled write-through is triggered and removed ONLY
// on durable success. A successful batch flush reconciles all (it merged the delta).
export interface BoundWriteTracker {
  markPending(bot: string, nowIso: string): void;
  markDurable(bot: string): void;
  reconcileAll(): void;
  hasPending(): boolean;
  pendingBots(): string[];
}

export function createBoundWriteTracker(): BoundWriteTracker {
  const pending = new Map<string, string>();
  return {
    markPending(bot, nowIso) { pending.set(bot, nowIso); },
    markDurable(bot) { pending.delete(bot); },
    reconcileAll() { pending.clear(); },
    hasPending() { return pending.size > 0; },
    pendingBots() { return [...pending.keys()]; },
  };
}

// --- §3c: Identity gate ---

export type CallerMethod = 'header_bound' | 'header_legacy' | 'path_legacy' | 'system';

export interface CallerCtx {
  bot: string | null;
  method: CallerMethod;
  sysOp?: SystemOp;
}

export interface GateDeps {
  isSunset: () => boolean;
  count: (n: string) => void;
  readBot: string;
  recordBoundUse: (b: string) => void;
  recordLegacyName: (n: string | undefined) => void;
}

export interface GateResolution {
  ok: boolean;
  bot?: string;
  code?: string;
  status?: number;
  message?: string;
}

export interface Gate {
  resolveRead(ctx: CallerCtx | null): GateResolution;
  resolveWrite(ctx: CallerCtx | null, forName?: string): GateResolution;
}

export function createGate(deps: GateDeps): Gate {
  const ok = (bot: string): GateResolution => ({ ok: true, bot });
  const err = (code: string, status: number, message: string): GateResolution => ({ ok: false, code, status, message });
  return {
    resolveRead(ctx: CallerCtx | null): GateResolution {
      if (ctx?.bot && ctx.method === 'header_bound') { deps.recordBoundUse(ctx.bot); return ok(ctx.bot); }
      if (ctx?.bot && ctx.method === 'system') return ok(ctx.bot);
      return ok(deps.readBot);
    },
    resolveWrite(ctx: CallerCtx | null, forName?: string): GateResolution {
      if (!ctx) return err('no_identity', 401, 'missing authentication context');
      if (ctx.method === 'header_legacy' || ctx.method === 'path_legacy') {
        if (deps.isSunset()) return err('legacy_retired', 401, 'legacy auth retired');
        if (normalizeBotName(forName || '') === SYSTEM_BOT) {
          deps.count('reserved_identity');
          return err('reserved_identity', 403, '"system" is reserved and cannot be named');
        }
        const bot = forName || deps.readBot;
        deps.count(forName ? 'legacy_write_named' : 'legacy_write_fallback');
        deps.recordLegacyName(forName);
        return ok(bot);
      }
      if (ctx.method === 'header_bound') {
        deps.recordBoundUse(ctx.bot!);
        if (forName && normalizeBotName(forName) !== normalizeBotName(ctx.bot || '')) {
          deps.count('identity_mismatch');
          return err('identity_mismatch', 403, `caller "${ctx.bot}" cannot mint for "${forName}"`);
        }
        return ok(ctx.bot!);
      }
      if (ctx.method === 'system') return ok(ctx.bot!);
      return err('no_identity', 401, 'unknown context');
    },
  };
}

// --- Telemetry merge (pure part of §3e flush) ---

export interface ByNameEntry {
  writes: number;
  lastSeen: string | null;
  boundLastSeen: string | null;
}

export interface TelemetryDelta {
  counts: Record<string, number>;
  lastSeen: Record<string, string>;
  byName: Record<string, ByNameEntry>;
}

export function emptyDelta(): TelemetryDelta {
  return { counts: {}, lastSeen: {}, byName: {} };
}

function maxTs(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b > a ? b : a;
}

export function mergeDelta(a: TelemetryDelta, b: TelemetryDelta): TelemetryDelta {
  const counts: Record<string, number> = { ...a.counts };
  for (const [k, v] of Object.entries(b.counts || {})) counts[k] = (counts[k] || 0) + v;
  const lastSeen: Record<string, string> = { ...a.lastSeen };
  for (const [k, v] of Object.entries(b.lastSeen || {})) {
    const m = maxTs(lastSeen[k], v);
    if (m) lastSeen[k] = m;
  }
  const byName: Record<string, ByNameEntry> = {};
  for (const [name, e] of Object.entries(a.byName || {})) byName[name] = { ...e };
  for (const [name, s] of Object.entries(b.byName || {})) {
    const e = byName[name] || { writes: 0, lastSeen: null, boundLastSeen: null };
    e.writes += s.writes || 0;
    e.lastSeen = maxTs(e.lastSeen, s.lastSeen);
    e.boundLastSeen = maxTs(e.boundLastSeen, s.boundLastSeen);
    byName[name] = e;
  }
  return { counts, lastSeen, byName };
}

export function mergeTelemetry(
  doc: { counts?: Record<string, number>; lastSeen?: Record<string, string>; byName?: Record<string, ByNameEntry>; updatedAt?: string },
  snap: TelemetryDelta,
  nowIso?: string,
): { counts: Record<string, number>; lastSeen: Record<string, string>; byName: Record<string, ByNameEntry>; updatedAt: string } {
  const merged = mergeDelta(
    { counts: doc.counts || {}, lastSeen: doc.lastSeen || {}, byName: doc.byName || {} },
    snap,
  );
  return { ...merged, updatedAt: nowIso ?? new Date().toISOString() };
}

// ============================================================================
// Part 2 — integration layer
// ============================================================================

// --- Errors ---

export class UserError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'UserError';
    this.code = code;
    this.status = status;
  }
}

export class FirestoreError extends UserError {
  grpcCode: string;
  constructor(httpStatus: number, grpcCode: string, message: string) {
    super(grpcCode, httpStatus, message);
    this.name = 'FirestoreError';
    this.grpcCode = grpcCode;
  }
  static fromResponse(status: number, body: any): FirestoreError {
    // :runQuery reports errors as a one-element array, not a bare object.
    const e = (Array.isArray(body) ? body[0] : body)?.error || {};
    return new FirestoreError(status, e.status || 'UNKNOWN', e.message || `firestore ${status}`);
  }
}

// Kept for API stability (route maps it to 503); nothing in the current auth path
// throws it — the legacy signal recorder uses bound write-through instead (#34).
export class WriteThroughFailed extends UserError {
  constructor() {
    super('write_through_failed', 503, 'telemetry write-through failed; retry the request');
    this.name = 'WriteThroughFailed';
  }
}

// --- Request context (§3a): AsyncLocalStorage-carried CallerCtx ---

export const reqCtx = new AsyncLocalStorage<CallerCtx>();

export function runAsSystem<T>(op: SystemOp, fn: () => T | Promise<T>): Promise<T> {
  const ctx: CallerCtx = { bot: SYSTEM_BOT, method: 'system', sysOp: op };
  return reqCtx.run(ctx, () => Promise.resolve(fn()));
}

// --- Transport (injected; the mock implements this in tests — zero live calls) ---

export interface HttpResponse {
  status: number;
  body: any;
}

export interface HttpOpts {
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface FirestoreTransport {
  request(method: string, url: string, opts: HttpOpts): Promise<HttpResponse>;
}

export interface FirestoreInit {
  method: string;
  body?: unknown;
  forName?: string;
  precondition?: PreconditionInput;
  /** Field paths for updateMask — §3e write-through/flush need this; the allowlist
   *  gates (op, path, method, precondition), updateMask only selects touched fields. */
  updateMask?: string[];
  /** Page size for list queries — validated positive int ≤ 1000. */
  pageSize?: number;
  /** Document ID for POST creates — validated against safe charset. */
  documentId?: string;
}

export interface SecurityDeps {
  baseUrl: string;
  fsTimeoutMs: number;
  readBot: string;
  isSunset: () => boolean;
  request: (method: string, url: string, opts: HttpOpts) => Promise<HttpResponse>;
  getIdToken: (bot: string, forceRefresh?: boolean) => Promise<string>;
  now: () => string; // ISO-8601 clock (injectable for tests)
}

// --- §3c: firestore() choke-point wrapper ---
// Order (REV 19): query-string rejection → GLOBAL precondition validation → gate →
// system allowlist (via checkSystemScope — the same function the unit tests cover,
// so doc and implementation cannot diverge, lesson #29) → validated URL build →
// 401 retry. Malformed preconditions never reach URL construction (lesson #32).

export type FirestoreFn = (path: string, init: FirestoreInit) => Promise<any>;

export function buildFirestoreQuery(init: FirestoreInit): string {
  const params = new URLSearchParams();
  // Firestore REST wants one updateMask.fieldPaths per field. A single
  // comma-joined value is parsed as ONE path ("name,text,...") and rejected
  // as "Invalid property path name,text,ts,tsNum,deviceId,idempotency_key".
  if (init.updateMask && init.updateMask.length) {
    for (const field of init.updateMask) params.append('updateMask.fieldPaths', field);
  }
  const pc = preconditionKind(init.precondition); // validated upstream; recompute for the kind
  if (pc === 'exists-false') params.set('currentDocument.exists', 'false');
  else if (pc === 'updateTime') params.set('currentDocument.updateTime', init.precondition!.updateTime!);
  if (init.pageSize !== undefined) {
    if (!Number.isInteger(init.pageSize) || init.pageSize <= 0 || init.pageSize > 1000)
      throw new UserError('bad-page-size', 400, 'pageSize must be a positive integer ≤ 1000');
    params.set('pageSize', String(init.pageSize));
  }
  if (init.documentId !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(init.documentId))
      throw new UserError('bad-document-id', 400, 'documentId contains unsafe characters');
    params.set('documentId', init.documentId);
  }
  const s = params.toString();
  return s ? '?' + s : '';
}

export function createFirestoreFn(
  deps: SecurityDeps,
  gate: Gate,
  count: (n: string) => void,
): FirestoreFn {
  return async function firestore(path: string, init: FirestoreInit): Promise<any> {
    if (path.includes('?')) throw new UserError('query-in-path', 400, 'query strings not accepted in path');
    // GLOBAL precondition validation — every caller, before any branch.
    const pv = validatePreconditionGlobal(init.precondition);
    if (!pv.ok) { count('bad_precondition'); throw new UserError(pv.reason!, 400, `malformed precondition: ${pv.reason}`); }
    const ctx = reqCtx.getStore() ?? null;
    const write = isWriteRequest(init.method, path);
    const r = write ? gate.resolveWrite(ctx, init.forName) : gate.resolveRead(ctx);
    if (!r.ok) throw new UserError(r.code!, r.status!, r.message!);
    if (ctx?.method === 'system') {
      // Same checkSystemScope the pure tests cover — no parallel implementation.
      const scope = checkSystemScope(ctx.sysOp!, path, init.method, init.precondition);
      if (!scope.ok) { count('system_scope_violation'); throw new UserError(scope.reason!, 403, `system op "${ctx.sysOp}" denied: ${init.method} ${path} (precondition ${scope.pc})`); }
    }
    // URL built from the VALIDATED result — never from raw input.
    const url = `${deps.baseUrl}${path}${buildFirestoreQuery(init)}`;
    for (let attempt = 0; ; attempt++) {
      const idToken = await deps.getIdToken(r.bot!, attempt > 0);
      const res = await deps.request(init.method, url, {
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        timeoutMs: deps.fsTimeoutMs,
      });
      if (res.status === 401 && attempt === 0) continue; // refresh token, retry once
      if (res.status >= 400) throw FirestoreError.fromResponse(res.status, res.body);
      return res.body;
    }
  };
}

// --- §3e: Sunset telemetry — multi-instance continuity protocol ---
//
// Document `security_telemetry` (+schemaVersion: 1, +instances registry).
// Flush: snapshot/swap → conditional commit (≤3 attempts) → ack or requeue. In-process mutex.
// Write-through: legacy BLOCKING (no ack until durable, 503 on persistent failure);
// bound throttled (1/hour/caller) + pendingWriteTracker — readiness false while pending.

export const TELEMETRY_DOC_PATH = '/security_telemetry';
export const TELEMETRY_SCHEMA_VERSION = 1;

export interface TelemetryDocData {
  schemaVersion: number;
  counts: Record<string, number>;
  lastSeen: Record<string, string>;
  byName: Record<string, ByNameEntry>;
  instances: Record<string, { startedAt: string; lastFlush: string }>;
  updatedAt: string;
}

export interface TelemetryOpts {
  instanceId: string;
  instanceStartedAt: string;
  quietWindowMs: number;
  boundWriteThroughMs: number;
  now: () => string;
  firestore: FirestoreFn;
  docPath?: string;
}

export interface ReadinessInput {
  now: string;
  instanceStartedAt: string;
  quietWindowMs: number;
  doc: TelemetryDocData | null;
  docUpdateTime: string | null;
  forcedFlushOk: boolean;
  flushFailuresInWindow: number;
  pendingWriteBots: string[];
  mcpCallers: string[];
}

export interface ReadinessResult {
  ready: boolean;
  reasons: string[];
}

// Pure evaluation of the continuity rule — every failure mode returns false with a reason.
// Missing/unreadable/malformed/stale/incomplete → false.
export function evaluateReadiness(i: ReadinessInput): ReadinessResult {
  const reasons: string[] = [];
  const ageMs = Date.parse(i.now) - Date.parse(i.instanceStartedAt);
  if (!(ageMs > i.quietWindowMs)) reasons.push('instance-too-young');
  if (!i.doc) {
    reasons.push('doc-missing');
  } else {
    if (i.doc.schemaVersion !== TELEMETRY_SCHEMA_VERSION) reasons.push('bad-schema');
    if (!i.forcedFlushOk) reasons.push('forced-flush-failed');
    if (i.docUpdateTime && Date.parse(i.now) - Date.parse(i.docUpdateTime) >= 3600000) reasons.push('doc-stale');
    if (i.flushFailuresInWindow > 0) reasons.push('flush-failures-in-window');
    if (i.pendingWriteBots.length > 0) reasons.push('pending-writes');
    for (const [method, ts] of Object.entries(i.doc.lastSeen || {})) {
      if (Date.parse(i.now) - Date.parse(ts) <= i.quietWindowMs) { reasons.push(`legacy-active:${method}`); break; }
    }
    for (const bot of i.mcpCallers) {
      const b = i.doc.byName?.[bot]?.boundLastSeen;
      if (!b || Date.parse(i.now) - Date.parse(b) > i.quietWindowMs) reasons.push(`caller-stale:${bot}`);
    }
  }
  return { ready: reasons.length === 0, reasons };
}

export interface Telemetry {
  recordCount(name: string): void;
  counts(): Record<string, number>;
  recordBoundUse(bot: string): void;
  recordLegacyName(name: string | undefined, readBot: string): void;
  flush(): Promise<{ ok: boolean; reason?: string }>;
  recordLegacySignal(method: 'header_legacy' | 'path_legacy'): Promise<void>;
  boundWriteThrough(bot: string): Promise<'triggered' | 'skipped'>;
  checkReadiness(mcpCallers: string[]): Promise<ReadinessResult>;
  tracker: BoundWriteTracker;
  deltaSize(): number;
}

export function createTelemetry(opts: TelemetryOpts): Telemetry {
  const docPath = opts.docPath ?? TELEMETRY_DOC_PATH;
  const now = opts.now;
  let delta: TelemetryDelta = emptyDelta();
  let cachedUpdateTime: string | null = null;
  let docExists = false;
  let lastDoc: TelemetryDocData | null = null;
  const boundCache = new Map<string, string>();
  const tracker = createBoundWriteTracker();
  const flushFailures: string[] = []; // ISO timestamps of flush failures
  let mutex: Promise<unknown> = Promise.resolve();

  function recordCount(name: string): void {
    delta.counts[name] = (delta.counts[name] || 0) + 1;
  }

  function getCounts(): Record<string, number> {
    return { ...delta.counts };
  }

  function recordBoundUse(bot: string): void {
    const e = delta.byName[bot] || (delta.byName[bot] = { writes: 0, lastSeen: null, boundLastSeen: null });
    e.writes += 1;
    const t = now();
    const m = maxTs(e.boundLastSeen, t);
    if (m) e.boundLastSeen = m;
  }

  function recordLegacyName(name: string | undefined, readBot: string): void {
    const bot = name || readBot;
    const e = delta.byName[bot] || (delta.byName[bot] = { writes: 0, lastSeen: null, boundLastSeen: null });
    e.writes += 1;
    const t = now();
    const m = maxTs(e.lastSeen, t);
    if (m) e.lastSeen = m;
  }

  // GET the doc; refresh cached state. Throws on transport errors.
  async function refreshDocState(): Promise<TelemetryDocData | null> {
    try {
      const body = await runAsSystem('flushSecurityTelemetry', () =>
        opts.firestore(docPath, { method: 'GET' }));
      cachedUpdateTime = body.updateTime ?? null;
      docExists = true;
      lastDoc = {
        schemaVersion: body.schemaVersion,
        counts: body.counts || {},
        lastSeen: body.lastSeen || {},
        byName: body.byName || {},
        instances: body.instances || {},
        updatedAt: body.updatedAt || '',
      };
      return lastDoc;
    } catch (e) {
      if (e instanceof FirestoreError && e.grpcCode === 'NOT_FOUND') {
        docExists = false;
        cachedUpdateTime = null;
        lastDoc = null;
        return null;
      }
      throw e;
    }
  }

  function preconditionForWrite(): PreconditionInput {
    return docExists && cachedUpdateTime ? { updateTime: cachedUpdateTime } : { exists: false };
  }

  async function doFlush(): Promise<{ ok: boolean; reason?: string }> {
    // snapshot/swap — new signals accumulate in a fresh delta while we commit
    const snap = delta;
    delta = emptyDelta();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const doc = await refreshDocState();
        const merged = mergeTelemetry(
          {
            counts: doc?.counts, lastSeen: doc?.lastSeen, byName: doc?.byName,
            updatedAt: doc?.updatedAt,
          },
          snap,
          now(),
        );
        // instance registry: heartbeat + prune beyond 2× quiet window
        const instances: TelemetryDocData['instances'] = { ...(doc?.instances || {}) };
        instances[opts.instanceId] = { startedAt: opts.instanceStartedAt, lastFlush: now() };
        const pruneBefore = Date.parse(now()) - 2 * opts.quietWindowMs;
        for (const [id, rec] of Object.entries(instances)) {
          if (id !== opts.instanceId && Date.parse(rec.lastFlush) < pruneBefore) delete instances[id];
        }
        const full: TelemetryDocData = {
          schemaVersion: TELEMETRY_SCHEMA_VERSION,
          counts: merged.counts,
          lastSeen: merged.lastSeen,
          byName: merged.byName,
          instances,
          updatedAt: merged.updatedAt,
        };
        try {
          const res = await runAsSystem('flushSecurityTelemetry', () =>
            opts.firestore(docPath, {
              method: 'PATCH',
              precondition: preconditionForWrite(),
              updateMask: ['schemaVersion', 'counts', 'lastSeen', 'byName', 'instances', 'updatedAt'],
              body: full,
            }));
          cachedUpdateTime = res.updateTime;
          docExists = true;
          lastDoc = full;
          tracker.reconcileAll(); // the flush merged the delta containing every pending signal
          return { ok: true };
        } catch (e) {
          if (e instanceof FirestoreError && (e.grpcCode === 'FAILED_PRECONDITION' || e.grpcCode === 'ALREADY_EXISTS')) {
            continue; // contention or create-race: re-read, re-merge, retry
          }
          throw e;
        }
      }
      // attempts exhausted → requeue: merge the snapshot back so nothing is lost
      delta = mergeDelta(delta, snap);
      flushFailures.push(now());
      return { ok: false, reason: 'attempts-exhausted' };
    } catch (e) {
      delta = mergeDelta(delta, snap);
      flushFailures.push(now());
      return { ok: false, reason: e instanceof Error ? e.message : 'unknown' };
    }
  }

  function flush(): Promise<{ ok: boolean; reason?: string }> {
    // in-process mutex: concurrent flushes serialize on one chain
    const run = mutex.then(() => doFlush());
    mutex = run.catch(() => {});
    return run;
  }

  // BOUND legacy write-through — fire-and-forget from the auth path (hollow #34).
  // Lesson #30 durability lives INSIDE the recorder, off the auth path: the signal
  // is marked pending, written with retries, and marked durable only on success.
  // A failed write stays pending for the batch flush to reconcile; readiness fails
  // closed while any entry is pending (lesson #31). Never throws — telemetry must
  // not be able to 503 the auth path.
  function recordLegacySignal(method: 'header_legacy' | 'path_legacy'): Promise<void> {
    const fieldPath = `lastSeen.${method}`;
    const ts = now();
    const trackKey = `legacy:${method}`;
    tracker.markPending(trackKey, ts);
    return runAsSystem('flushSecurityTelemetry', async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const doc = await refreshDocState().catch(() => null);
        const effectiveTs = maxTs(doc?.lastSeen?.[method], ts) ?? ts;
        try {
          const res = await opts.firestore(docPath, {
            method: 'PATCH',
            precondition: preconditionForWrite(),
            updateMask: [fieldPath],
            body: { lastSeen: { [method]: effectiveTs } },
          });
          cachedUpdateTime = res.updateTime;
          docExists = true;
          const m = maxTs(delta.lastSeen[method], effectiveTs);
          if (m) delta.lastSeen[method] = m; // belt-and-suspenders: delta agrees with durable
          tracker.markDurable(trackKey);
          return;
        } catch (e) {
          if (e instanceof FirestoreError && (e.grpcCode === 'FAILED_PRECONDITION' || e.grpcCode === 'ALREADY_EXISTS')) {
            continue; // contention: re-read, max-merge, retry
          }
          break; // other failures fail fast — entry stays pending for flush
        }
      }
      recordCount('write_through_failed');
      // No throw: the batch flush reconciles pending entries (lesson #31).
    });
  }

  // Throttled bound write-through — fire-and-forget, but tracked: the entry is
  // removed ONLY on durable success; a successful batch flush reconciles the rest.
  // Readiness is false while any entry remains (lesson #31).
  // Returns the promise so tests can await it; the request path does not await.
  function boundWriteThrough(bot: string): Promise<'triggered' | 'skipped'> {
    const ts = now();
    const cached = boundCache.get(bot);
    if (cached && Date.parse(ts) - Date.parse(cached) < opts.boundWriteThroughMs) {
      return Promise.resolve('skipped');
    }
    tracker.markPending(bot, ts);
    const fieldPath = `byName.${bot}.boundLastSeen`;
    return runAsSystem('flushSecurityTelemetry', async () => {
      try {
        const res = await opts.firestore(docPath, {
          method: 'PATCH',
          precondition: preconditionForWrite(),
          updateMask: [fieldPath],
          body: { byName: { [bot]: { boundLastSeen: ts } } },
        });
        cachedUpdateTime = res.updateTime;
        docExists = true;
        boundCache.set(bot, ts);
        tracker.markDurable(bot);
      } catch {
        recordCount('bound_write_through_failed');
        // entry REMAINS pending — the batch flush reconciles it
      }
    }).then(() => 'triggered' as const);
  }

  async function checkReadiness(mcpCallers: string[]): Promise<ReadinessResult> {
    const flushRes = await flush(); // forced flush first
    const windowStart = Date.parse(now()) - opts.quietWindowMs;
    const failuresInWindow = flushFailures.filter(t => Date.parse(t) >= windowStart).length;
    return evaluateReadiness({
      now: now(),
      instanceStartedAt: opts.instanceStartedAt,
      quietWindowMs: opts.quietWindowMs,
      doc: lastDoc,
      docUpdateTime: cachedUpdateTime,
      forcedFlushOk: flushRes.ok,
      flushFailuresInWindow: failuresInWindow,
      pendingWriteBots: tracker.pendingBots(),
      mcpCallers,
    });
  }

  return {
    recordCount,
    counts: getCounts,
    recordBoundUse,
    recordLegacyName,
    flush,
    recordLegacySignal,
    boundWriteThrough,
    checkReadiness,
    tracker,
    deltaSize(): number {
      return Object.keys(delta.counts).length + Object.keys(delta.lastSeen).length + Object.keys(delta.byName).length;
    },
  };
}

// --- §1: Authentication route logic ---
//
// Routes: POST /mcp bare (header only); /mcp/<secret> legacy (Bearer authoritative over path).
// Presented malformed/invalid Bearer is authoritative — never falls back to path secret.
// All authentication failures produce the IDENTICAL 404 decoy (lesson #10: no oracle).

export const DECOY_STATUS = 404;
export const DECOY_BODY = { error: 'not found' };

export interface AuthConfig {
  /** token -> bot name (MCP_CALLERS) */
  mcpCallers: Record<string, string>;
  /** legacy path secret */
  legacySecret: string;
  legacyEnabled: boolean;
}

export function validateCallerConfig(mcpCallers: Record<string, string>): { ok: boolean; reason?: string } {
  const entries = Object.entries(mcpCallers);
  if (entries.length === 0) return { ok: false, reason: 'empty' };
  const seen = new Set<string>();
  for (const [token, bot] of entries) {
    if (!token || token.length < 16) return { ok: false, reason: `weak-token:${bot}` };
    if (seen.has(token)) return { ok: false, reason: 'duplicate-token' };
    seen.add(token);
    if (!bot || normalizeBotName(bot) === SYSTEM_BOT) return { ok: false, reason: `reserved-name:${bot}` };
  }
  return { ok: true };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Scan every MCP_CALLERS token. No early return — comparison count does not
 *  leak whether the match was first or last. Last match wins if two compare equal. */
export function matchCallerToken(
  presented: string,
  mcpCallers: Record<string, string>,
  equal: (a: string, b: string) => boolean = constantTimeEqual,
): string | null {
  let matched: string | null = null;
  for (const [token, bot] of Object.entries(mcpCallers)) {
    if (equal(presented, token)) matched = bot;
  }
  return matched;
}

export type AuthResolution = { kind: 'ctx'; ctx: CallerCtx } | { kind: 'decoy' };

export interface AuthDeps {
  config: AuthConfig;
  isSunset: () => boolean;
  count: (n: string) => void;
  recordLegacySignal: (method: 'header_legacy' | 'path_legacy') => Promise<void>;
}

// resolveAuth implements the §1b/§1c decision table. Legacy signals are recorded
// fire-and-forget — telemetry stays OFF the auth path (hollow #34). The request is
// acknowledged as soon as the secret validates; durability is the recorder's own
// bound write-through, tracked for readiness (lessons #30 inside the recorder,
// #31 fail-closed while pending).
export function createResolveAuth(deps: AuthDeps): (req: AuthRequest, urlPath: string) => Promise<AuthResolution> {
  return async function resolveAuth(req: AuthRequest, urlPath: string): Promise<AuthResolution> {
    const parsed = parseBearer(req);
    if (parsed.kind === 'bearer') {
      const bot = matchCallerToken(parsed.token, deps.config.mcpCallers);
      if (bot) return { kind: 'ctx', ctx: { bot, method: 'header_bound' } };
      deps.count('rejected');
      return { kind: 'decoy' };
    }
    if (parsed.kind === 'malformed' || parsed.kind === 'ambiguous') {
      deps.count('rejected');
      return { kind: 'decoy' }; // authoritative — never path fallback
    }
    // kind === 'none' → path logic may apply
    const m = urlPath.match(/^\/mcp(?:\/([^/?#]+))?$/);
    if (!m) { deps.count('rejected'); return { kind: 'decoy' }; }
    const pathSecret = m[1];
    if (!pathSecret) { deps.count('rejected'); return { kind: 'decoy' }; } // bare /mcp, no credential
    // Post-sunset / disabled-legacy: identical 404 decoy (no oracle)
    if (!deps.config.legacyEnabled || deps.isSunset()) { deps.count('rejected'); return { kind: 'decoy' }; }
    if (!constantTimeEqual(pathSecret, deps.config.legacySecret)) { deps.count('rejected'); return { kind: 'decoy' }; }
    // Legacy authenticated — durability precedes acknowledgment (lesson #30).
    deps.recordLegacySignal('path_legacy').catch(() => {});
    deps.count('legacy_auth');
    return { kind: 'ctx', ctx: { bot: null, method: 'path_legacy' } };
  };
}

// --- §3f: Deploy-order gate + atomic Apify claim ---
// Atomic claim via typed precondition: first run → exists=false; else updateTime.
// Error taxonomy: FAILED_PRECONDITION/ALREADY_EXISTS → quiet skip;
// permission/auth/network/other → abort loudly before paid calls.

export const APIFY_DOC_PATH = '/system_config/apify_last_run';

export interface Security {
  gate: Gate;
  firestore: FirestoreFn;
  telemetry: Telemetry;
  resolveAuth: (req: AuthRequest, urlPath: string) => Promise<AuthResolution>;
  runAsSystem: typeof runAsSystem;
  counts: () => Record<string, number>;
  now: () => string;
  reqCtx: typeof reqCtx;
}

export async function apifyClaimSlot(sec: Security, readUpdateTime: string | null): Promise<'claimed' | 'skipped-quiet'> {
  const precondition: PreconditionInput = readUpdateTime ? { updateTime: readUpdateTime } : { exists: false };
  try {
    await sec.runAsSystem('apifyWrite', () =>
      sec.firestore(APIFY_DOC_PATH, {
        method: 'PATCH',
        precondition,
        updateMask: ['claimedAt', 'slotHours'],
        body: { claimedAt: sec.now(), slotHours: 6 },
      }));
    return 'claimed';
  } catch (e) {
    if (e instanceof FirestoreError && (e.grpcCode === 'FAILED_PRECONDITION' || e.grpcCode === 'ALREADY_EXISTS')) {
      return 'skipped-quiet';
    }
    throw e; // permission/auth/network/other → abort loudly before paid calls
  }
}

// --- Factory: wires gate ↔ telemetry ↔ firestore ↔ auth with shared counters ---

export interface TelemetryFactoryOpts {
  instanceId: string;
  instanceStartedAt: string;
  quietWindowMs: number;
  boundWriteThroughMs: number;
  docPath?: string;
}

export function createSecurity(deps: SecurityDeps, teleOpts: TelemetryFactoryOpts, authConfig: AuthConfig): Security {
  let firestoreImpl: FirestoreFn = () => { throw new Error('firestore not initialized'); };
  const telemetry = createTelemetry({
    ...teleOpts,
    now: deps.now,
    firestore: (path, init) => firestoreImpl(path, init),
  });
  const count = (n: string) => telemetry.recordCount(n);
  const gate = createGate({
    readBot: deps.readBot,
    isSunset: deps.isSunset,
    count,
    recordBoundUse: (b: string) => telemetry.recordBoundUse(b),
    recordLegacyName: (n: string | undefined) => telemetry.recordLegacyName(n, deps.readBot),
  });
  firestoreImpl = createFirestoreFn(deps, gate, count);
  const firestore: FirestoreFn = (path, init) => firestoreImpl(path, init);
  const resolveAuth = createResolveAuth({
    config: authConfig,
    isSunset: deps.isSunset,
    count,
    recordLegacySignal: (m) => telemetry.recordLegacySignal(m),
  });
  return {
    gate,
    firestore,
    telemetry,
    resolveAuth,
    runAsSystem,
    counts: () => telemetry.counts(),
    now: deps.now,
    reqCtx,
  };
}
