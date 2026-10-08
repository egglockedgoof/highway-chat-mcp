/**
 * MarrowSystemZ — The last system the world will need.
 * (Founding vow preserved verbatim — see MARROW_CORE.md)
 *
 * THE PROTOCOL OF THE UNREAL — pass 3, core re-architecture. 50 tools.
 *  - One McpServer + transport per request (the shared instance 500'd every overlapping call).
 *  - One HTTP primitive: whole-lifecycle timeout, byte cap, redirect control.
 *  - SSRF guard on every caller-supplied URL.
 *  - Optimistic concurrency on read-modify-write docs; no lost updates.
 *  - Paid Apify calls claim their 6h slot BEFORE spending; fail closed on config errors.
 *  - Every unexpected failure lands in evolution_logs (deduped + budgeted); nothing is swallowed.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ============ FAIL-CLOSED ENV ============
const REQUIRED_ENV = ["FIREBASE_API_KEY", "MCP_SECRET", "HIGHWAY_CLIENT_KEY"] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`FATAL: ${k} environment variable is not set.`);
    process.exit(1);
  }
}
const API_KEY = process.env.FIREBASE_API_KEY as string;
const MCP_SECRET = process.env.MCP_SECRET as string;

const BASE =
  process.env.FIRESTORE_BASE ||
  "https://firestore.googleapis.com/v1/projects/highway-chat/databases/(default)/documents";

const MESSAGES = "highway_messages";
const PRESENCE = "highway_presence";
const ACTIVITY = "highway_activity";
const TASKS = "highway_tasks";
const NOTES = "highway_notes";
const TYPING = "highway_typing";
const EVO_LOGS = "evolution_logs";
const JARVIS_MEM = "jarvis_memory";
const SYS_CONFIG = "system_config";

const DEVICE_ID = "mcp-bridge";
const READ_BOT = "whisper";
const FS_TIMEOUT = 15000;
const EXT_TIMEOUT = 10000;
const ONLINE_WINDOW = 90000; // presence heartbeat freshness
const MAX_API_BYTES = 8 * 1024 * 1024; // vendor JSON / Firestore responses
const MAX_PAGE_BYTES = 4 * 1024 * 1024; // caller-supplied pages (truncated, not rejected)
const MAX_REDIRECTS = 3;
const UA = { "User-Agent": "Mozilla/5.0 (compatible; highway-chat/1.0)" };

type Fields = Record<string, any>;
type Doc = { name: string; fields?: Fields; createTime?: string; updateTime?: string };

// ============ ERRORS ============
/** Expected, caller-fixable failure (bad input, not found, not the author). Never written to telemetry. */
class UserError extends Error {}
class FirestoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ============ CREDENTIALS (parsed once) ============
const BOT_CREDS: Record<string, { email: string; password: string }> = (() => {
  try { return JSON.parse(process.env.BOT_CREDENTIALS || "{}"); }
  catch { console.error("FATAL: BOT_CREDENTIALS is not valid JSON."); process.exit(1); }
})();

// ============ HTTP PRIMITIVE ============
// One timer covers headers AND body (a stalled body used to hang forever); bytes are capped;
// redirects are the caller's choice. Every outbound request in this file goes through here.
type HttpResult = { status: number; ok: boolean; statusText: string; body: string; location: string | null };

const hostOf = (url: string): string => { try { return new URL(url).hostname; } catch { return url.slice(0, 60); } };

async function readCapped(res: globalThis.Response, max: number, overflow: "throw" | "truncate"): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      if (overflow === "throw") throw new Error(`response exceeds ${max} bytes`);
      chunks.push(value.subarray(0, value.byteLength - (total - max)));
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function http(
  url: string,
  init: RequestInit,
  ms: number,
  opts: { maxBytes?: number; overflow?: "throw" | "truncate" } = {}
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await readCapped(res, opts.maxBytes ?? MAX_API_BYTES, opts.overflow ?? "throw");
    return { status: res.status, ok: res.ok, statusText: res.statusText, body, location: res.headers.get("location") };
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`timeout after ${ms}ms: ${hostOf(url)}`);
    throw e;
  } finally { clearTimeout(timer); }
}

function parseJson(body: string): any {
  try { return JSON.parse(body); } catch { return {}; }
}

// Trusted vendor endpoints (hard-coded URLs): redirects followed, size-capped.
async function fetchText(url: string, ms = 12000): Promise<string> {
  const r = await http(url, { headers: UA }, ms);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${hostOf(url)}`);
  return r.body;
}
async function fetchJson(url: string, ms = 12000): Promise<any> {
  const body = await fetchText(url, ms);
  try { return JSON.parse(body); } catch { throw new Error(`non-JSON response from ${hostOf(url)}`); }
}

// ============ SSRF GUARD (caller-supplied URLs only) ============
function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (/^fe[89ab]/.test(v) || /^f[cd]/.test(v)) return true; // link-local, unique-local
  const dotted = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPrivateIp(dotted[1]);
  const hex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UserError("invalid url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UserError("only http(s) urls are allowed");
  if (u.username || u.password) throw new UserError("credentials in urls are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host))
    throw new UserError("private hostnames are not allowed");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
    throw new UserError("url resolves to a private address");
  return u;
}

// Redirects are followed by hand so every hop is re-validated. Residual risk: DNS rebinding
// between lookup and connect (closing it needs a pinned-IP dispatcher).
async function fetchPublic(raw: string, ms: number): Promise<string> {
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertPublicUrl(url);
    const r = await http(u.href, { headers: UA, redirect: "manual" }, ms,
      { maxBytes: MAX_PAGE_BYTES, overflow: "truncate" });
    if (r.status >= 300 && r.status < 400 && r.location) { url = new URL(r.location, u).href; continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${u.hostname}`);
    return r.body;
  }
  throw new UserError("too many redirects");
}

// ============ TOKEN CACHE (in-flight dedup kills stampedes; backoff kills auth hammering) ============
const _tokens = new Map<string, { token: string; exp: number }>();
const _inflight = new Map<string, Promise<string>>();
const _authBackoff = new Map<string, { until: number; message: string }>();
const AUTH_BACKOFF_MS = 15000;
const tokenKey = (forName?: string): string => (forName || READ_BOT).toLowerCase();

async function getIdToken(forName?: string): Promise<string> {
  const key = tokenKey(forName);
  const cached = _tokens.get(key);
  if (cached && Date.now() < cached.exp - 60000) return cached.token;
  const pending = _inflight.get(key);
  if (pending) return pending;
  const creds = BOT_CREDS[key];
  if (!creds?.email || !creds?.password) throw new UserError(`No credentials configured for bot "${key}"`);
  const backoff = _authBackoff.get(key);
  if (backoff && Date.now() < backoff.until) throw new Error(backoff.message);

  const p = (async (): Promise<string> => {
    try {
      const r = await http(
        `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${API_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: creds.email, password: creds.password, returnSecureToken: true }) },
        EXT_TIMEOUT);
      const data = parseJson(r.body);
      if (!r.ok) throw new Error(`Auth ${r.status}: ${data?.error?.message ?? r.statusText}`);
      if (!data.idToken) throw new Error("Auth succeeded but returned no idToken");
      _tokens.set(key, { token: data.idToken, exp: Date.now() + parseInt(data.expiresIn || "3600", 10) * 1000 });
      _authBackoff.delete(key);
      return data.idToken as string;
    } catch (e) {
      _authBackoff.set(key, { until: Date.now() + AUTH_BACKOFF_MS, message: `auth backoff: ${errMsg(e)}` });
      throw e;
    }
  })();

  _inflight.set(key, p);
  try { return await p; }
  finally { _inflight.delete(key); }
}

// ============ FIRESTORE PRIMITIVES ============
async function firestore(path: string, init: { method: string; body?: unknown; forName?: string }): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const idToken = await getIdToken(init.forName);
    const r = await http(`${BASE}${path}`, {
      method: init.method,
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY, "Authorization": `Bearer ${idToken}` },
      body: init.body ? JSON.stringify(init.body) : undefined,
    }, FS_TIMEOUT);
    // revoked/expired-early token: drop the cache and retry exactly once
    if (r.status === 401 && attempt === 0) { _tokens.delete(tokenKey(init.forName)); continue; }
    const data = parseJson(r.body);
    if (!r.ok) {
      const err = Array.isArray(data) ? data[0]?.error : data?.error;
      throw new FirestoreError(r.status, String(err?.status ?? ""), `Firestore ${r.status}: ${err?.message ?? r.statusText}`);
    }
    return data;
  }
}

const is404 = (e: unknown): boolean => e instanceof FirestoreError && e.status === 404;

async function getDocOrNull(collectionId: string, docId: string, forName?: string): Promise<Doc | null> {
  try { return (await firestore(`/${collectionId}/${encodeURIComponent(docId)}`, { method: "GET", forName })) as Doc; }
  catch (e) { if (is404(e)) return null; throw e; }
}

async function listDocs(collectionId: string, pageSize = 300): Promise<Doc[]> {
  const data = await firestore(`/${collectionId}?pageSize=${pageSize}`, { method: "GET" });
  return (data.documents ?? []) as Doc[];
}

const str = (f: any): string => f?.stringValue ?? "";
const boolOf = (f: any): boolean => f?.booleanValue ?? false;
// tsOf: mixed-type aware — highway_messages ts is stringValue OR timestampValue (never trust the type)
const tsOf = (f: any): number | null => {
  if (!f) return null;
  if (f.timestampValue !== undefined) return Date.parse(f.timestampValue);
  if (f.stringValue !== undefined) {
    const t = Date.parse(f.stringValue);
    return isNaN(t) ? null : t;
  }
  if (f.integerValue !== undefined) return Number(f.integerValue);
  if (f.doubleValue !== undefined) return Number(f.doubleValue);
  return null;
};
const nowTs = () => ({ timestampValue: new Date().toISOString() });
const nowNum = () => ({ integerValue: String(Date.now()) });
const docIdOf = (name: string): string => {
  const i = name.lastIndexOf("/");
  return i >= 0 ? decodeURIComponent(name.slice(i + 1)) : name;
};
// FNV-1a: deterministic content hash, no imports
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
// bestTs: one timestamp source of truth — tsNum (numeric) beats ts (mixed), createTime last
const bestTs = (d: Doc): number => {
  const f = d.fields ?? {};
  return tsOf(f.tsNum) ?? tsOf(f.ts) ?? (d.createTime ? Date.parse(d.createTime) : 0);
};
const isOnline = (ts: number | null, now: number = Date.now()): boolean =>
  ts !== null && now - ts < ONLINE_WINDOW;

// stripHtml is hash-stable by contract (diff_check_page / extract_site_schema fingerprints depend on it).
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === "#") {
      const cp = g[1].toLowerCase() === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
function htmlToText(html: string): string {
  return decodeEntities(stripHtml(html).replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function buildMessageFields(name: string, text: string) {
  return { fields: {
    name: { stringValue: name },
    text: { stringValue: text },
    ts: nowTs(),
    tsNum: nowNum(),
    deviceId: { stringValue: DEVICE_ID },
  } };
}

// Shared evolution_logs doc — one builder, three tools
function evoDoc(type: string, text: string) {
  return { fields: { type: { stringValue: type }, text: { stringValue: text }, tsNum: nowNum() } };
}
function telemetryDoc(tool: string, latencyMs: number, success: boolean, error = "") {
  return { fields: {
    type: { stringValue: "telemetry" },
    text: { stringValue: `telemetry:${tool}:${success ? "ok" : "fail"}:${Math.round(latencyMs)}ms${error ? ":" + error.slice(0, 200) : ""}` },
    tool_name: { stringValue: tool },
    latency_ms: { doubleValue: latencyMs },
    success: { booleanValue: success },
    tsNum: nowNum(),
  } };
}

// ============ OBSERVABILITY: failures reach the permanent log, never the void ============
// Deduped per (scope, message) and budgeted per hour so an outage cannot burn the Firestore write quota.
const FAIL_DEDUPE_MS = 10 * 60 * 1000;
const FAIL_BUDGET_PER_HOUR = 60;
const _failSeen = new Map<string, number>();
let _budget = { windowStart: Date.now(), used: 0 };

function recordFailure(scope: string, err: unknown, latencyMs = 0): void {
  const msg = errMsg(err);
  console.error(`[fail] ${scope}: ${msg}`);
  const now = Date.now();
  const key = `${scope}:${msg.slice(0, 80)}`;
  if (now - (_failSeen.get(key) ?? 0) < FAIL_DEDUPE_MS) return;
  if (now - _budget.windowStart > 3600000) _budget = { windowStart: now, used: 0 };
  if (_budget.used >= FAIL_BUDGET_PER_HOUR) return;
  _budget.used++;
  _failSeen.set(key, now);
  if (_failSeen.size > 500) for (const [k, t] of _failSeen) if (now - t > FAIL_DEDUPE_MS) _failSeen.delete(k);
  // fire-and-forget; this path never calls recordFailure, so it cannot recurse
  firestore(`/${EVO_LOGS}`, { method: "POST", body: telemetryDoc(scope, latencyMs, false, msg) })
    .catch((e: unknown) => console.error(`[fail] telemetry write for ${scope} failed: ${errMsg(e)}`));
}

async function settle<T>(label: string, p: Promise<T>, fallback: T, degraded: string[]): Promise<T> {
  try { return await p; }
  catch (e) { degraded.push(label); recordFailure(label, e); return fallback; }
}

const okText = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj) }],
});
const errText = (toolName: string, e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: `${toolName} failed: ${errMsg(e)}` }],
});

type ToolCfg<S extends z.ZodRawShape> = {
  title: string; description: string; inputSchema: S;
  readOnly?: boolean; destructive?: boolean; openWorld?: boolean;
};

function tool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  cfg: ToolCfg<S>,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>
): void {
  server.registerTool(name,
    {
      title: cfg.title,
      description: cfg.description,
      inputSchema: cfg.inputSchema,
      annotations: {
        readOnlyHint: !!cfg.readOnly,
        destructiveHint: !!cfg.destructive,
        idempotentHint: !!cfg.readOnly,
        openWorldHint: !!cfg.openWorld,
      },
    },
    (async (args: z.infer<z.ZodObject<S>>) => {
      const t0 = Date.now();
      try { return okText(await handler(args)); }
      catch (e) {
        if (!(e instanceof UserError)) recordFailure(name, e, Date.now() - t0);
        return errText(name, e);
      }
    }) as never
  );
}

// ============ QUERIES ============
const rowsOf = (data: any): Doc[] =>
  (Array.isArray(data) ? data : []).map((r: any) => r.document).filter(Boolean) as Doc[];
const newest = (docs: Doc[], limit: number): Doc[] => docs.sort((a, b) => bestTs(b) - bestTs(a)).slice(0, limit);

type Where = { field: string; op: string; value: unknown; match: (d: Doc) => boolean };

// Fetch 2x, sort client-side by bestTs, slice. The composite-index fallback triggers ONLY on
// FAILED_PRECONDITION (and is reported, with Google's index-creation link); every other error propagates.
async function queryDocs(
  collectionId: string,
  o: { orderField: string; limit: number; where?: Where }
): Promise<{ docs: Doc[]; degraded: boolean }> {
  try {
    const data = await firestore(`:runQuery`, { method: "POST", body: { structuredQuery: {
      from: [{ collectionId }],
      ...(o.where ? { where: { fieldFilter: {
        field: { fieldPath: o.where.field }, op: o.where.op, value: o.where.value } } } : {}),
      orderBy: [{ field: { fieldPath: o.orderField }, direction: "DESCENDING" }],
      limit: Math.min(o.limit * 2, 400),
    } } });
    return { docs: newest(rowsOf(data), o.limit), degraded: false };
  } catch (e) {
    if (!o.where || !(e instanceof FirestoreError) || e.code !== "FAILED_PRECONDITION") throw e;
    recordFailure(`index_missing:${collectionId}`, e);
    const docs = (await listDocs(collectionId)).filter(o.where.match);
    return { docs: newest(docs, o.limit), degraded: true };
  }
}

const queryNewest = async (collectionId: string, limit: number): Promise<Doc[]> =>
  (await queryDocs(collectionId, { orderField: "ts", limit })).docs;

// Collections stamped only with tsNum (evolution_logs, jarvis_memory): newest-first by number,
// falling back to a page read for legacy docs that predate tsNum.
async function queryNewestNum(collectionId: string, limit: number): Promise<Doc[]> {
  const { docs } = await queryDocs(collectionId, { orderField: "tsNum", limit });
  return docs.length ? docs : newest(await listDocs(collectionId), limit);
}

// ============ SHARED MUTATION HELPERS ============
const maskKey = (k: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `\`${k.replace(/`/g, "\\`")}\``);
const maskOf = (fields: Record<string, unknown>): string =>
  Object.keys(fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(maskKey(k))}`).join("&");

async function patchFields(collectionId: string, docId: string, fields: Record<string, unknown>, forName?: string) {
  await firestore(`/${collectionId}/${encodeURIComponent(docId)}?${maskOf(fields)}`, {
    method: "PATCH", body: { fields }, forName,
  });
}

// Read-modify-write under an updateTime precondition: concurrent writers retry instead of
// silently overwriting each other (react_to_message and append_note used to lose updates).
async function mutateDoc(
  collectionId: string,
  docId: string,
  mutate: (current: Fields | null) => Record<string, unknown>,
  forName?: string
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const cur = await getDocOrNull(collectionId, docId, forName);
    const patch = mutate(cur?.fields ?? null);
    const precondition = cur?.updateTime
      ? `currentDocument.updateTime=${encodeURIComponent(cur.updateTime)}`
      : "currentDocument.exists=false";
    try {
      await firestore(`/${collectionId}/${encodeURIComponent(docId)}?${maskOf(patch)}&${precondition}`,
        { method: "PATCH", body: { fields: patch }, forName });
      return;
    } catch (e) {
      const contended = e instanceof FirestoreError &&
        (e.code === "FAILED_PRECONDITION" || e.code === "ABORTED" || e.status === 409 || e.status === 412);
      if (!contended || attempt >= 3) throw e;
    }
  }
}

function parseReactions(f: any): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries<any>(f?.mapValue?.fields ?? {}))
    out[k] = (v?.arrayValue?.values ?? []).map((x: any) => x?.stringValue).filter(Boolean);
  return out;
}
function encodeReactions(rx: Record<string, string[]>): unknown {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rx))
    fields[k] = { arrayValue: { values: v.map((n) => ({ stringValue: n })) } };
  return { mapValue: { fields } };
}

async function postActivity(by: string, text: string, forName?: string): Promise<void> {
  await firestore(`/${ACTIVITY}`, { method: "POST", forName,
    body: { fields: { text: { stringValue: text }, by: { stringValue: by }, ts: nowTs() } } });
}
// notify: postActivity that NEVER throws — failures go to the permanent log
async function notify(by: string, text: string, forName?: string): Promise<void> {
  try { await postActivity(by, text, forName); }
  catch (e) { recordFailure(`notify:${by}`, e); }
}

async function getMessageOrThrow(message_id: string, forName?: string): Promise<{ id: string; fields: Fields }> {
  const doc = await getDocOrNull(MESSAGES, message_id, forName);
  if (!doc?.fields) throw new UserError("message not found");
  return { id: docIdOf(doc.name), fields: doc.fields };
}
function requireAuthor(fields: Fields, name: string, action: string): void {
  const author = str(fields.name);
  if (author.toLowerCase() !== name.toLowerCase())
    throw new UserError(`only the author (${author}) can ${action} this message`);
}

async function findTask(task_id?: string, title?: string): Promise<{ id: string; fields: Fields } | null> {
  if (task_id) {
    const doc = await getDocOrNull(TASKS, task_id);
    return doc?.fields ? { id: docIdOf(doc.name), fields: doc.fields } : null;
  }
  if (title) {
    const q = title.toLowerCase();
    for (const d of await queryNewest(TASKS, 100)) {
      if (str(d.fields?.text).toLowerCase().includes(q))
        return { id: docIdOf(d.name), fields: d.fields ?? {} };
    }
  }
  return null;
}
async function getTaskOrThrow(task_id: string): Promise<{ id: string; fields: Fields }> {
  const task = await findTask(task_id);
  if (!task) throw new UserError("task not found");
  return task;
}
function fmtTask(d: Doc) {
  const f = d.fields ?? {};
  return {
    id: docIdOf(d.name), text: str(f.text), done: boolOf(f.done),
    createdBy: str(f.createdBy), assignee: str(f.assignee) || null,
    priority: str(f.priority) || null, ts: tsOf(f.ts),
  };
}
function fmtMsg(d: Doc) {
  const f = d.fields ?? {};
  return { id: docIdOf(d.name), name: str(f.name), text: str(f.text),
    ts: tsOf(f.ts) ?? (d.createTime ? Date.parse(d.createTime) : null) };
}

async function countDocs(collectionId: string): Promise<number | null> {
  try {
    const data = await firestore(`:runAggregationQuery`, { method: "POST", body: {
      structuredAggregationQuery: {
        structuredQuery: { from: [{ collectionId }] },
        aggregations: [{ count: {}, alias: "total" }],
      } } });
    const v = data?.[0]?.result?.aggregateFields?.total;
    return v?.integerValue !== undefined ? Number(v.integerValue) : null;
  } catch (e) {
    recordFailure(`countDocs:${collectionId}`, e);
    return null;
  }
}

const faviconFor = (url: string): string => {
  const d = hostOf(url);
  return d && d !== url ? `https://www.google.com/s2/favicons?domain=${d}&sz=128` : "";
};
const fmtUsd = (n: number): string =>
  n >= 1000 ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 })
  : n >= 1 ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 })
  : "$" + n.toPrecision(3);
const fmtPct = (n: number): string => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
function impactLine(pct: number, holder: string): string {
  if (pct >= 5) return "Ripping — big green day. " + holder + " are up.";
  if (pct >= 1.5) return "Green — momentum building for " + holder + ".";
  if (pct <= -5) return "Dumping — don't panic-sell, " + holder + ".";
  if (pct <= -1.5) return "Dipping — cheaper if you were buying, " + holder + ".";
  return "Flat — nothing to act on today.";
}
// Timeless macro framing — NO hardcoded figures (standing mandate)
function macroImpact(title: string): string {
  const t = title.toLowerCase();
  if (/rate|fed|interest|treasury|yield/.test(t)) return "Rates move → every loan, card, and mortgage reprices. Watch the Fed.";
  if (t.includes("inflation") || t.includes("cpi")) return "Inflation above target → the Fed can't cut. Your dollar buys less.";
  if (/jobs|unemployment|wage|hiring/.test(t)) return "Jobs data → hiring freeze or boom. Watch revisions, not headlines.";
  if (t.includes("tariff")) return "Tariffs → import prices climb. Supply chains reroute.";
  if (/housing|mortgage|rent/.test(t)) return "Housing costs → the biggest line in most budgets. Rates decide everything.";
  if (/oil|gas|energy|opec|brent/.test(t)) return "Energy prices → gas, diesel, and shipping costs move together.";
  if (/\btax(es)?\b/.test(t)) return "Tax policy → what you keep changes. Watch what actually passes.";
  if (/trump|white house|congress|election|midterm/.test(t)) return "Power shifts → markets reprice. Policy follows the winners.";
  if (/ukraine|russia|iran|israel|gaza|taiwan|war|hormuz/.test(t)) return "Conflict → oil spikes, markets shake. Watch escalation, not noise.";
  if (/\bai\b|openai|anthropic|nvidia|chip|robot/.test(t)) return "AI buildout → who funds it and at what rates decides the winners.";
  if (/spacex|nasa|moon|mars|artemis|starship/.test(t)) return "Space milestones → long-horizon bets. Track launches, not promises.";
  if (/food|wheat|corn|crop|drought|famine|ebt|snap|beef/.test(t)) return "Food prices → weather and policy. Staples first, speculation never.";
  if (/hurricane|storm|flood|earthquake|wildfire|tornado/.test(t)) return "Disaster → supply chains break, insurance spikes.";
  if (/bitcoin|btc|crypto|ethereum/.test(t)) return "Crypto moves with liquidity. Watch the dollar and rates, not the hype.";
  return "Major shift → watch your wallet, not the headlines.";
}

// ============ FEEDS (RSS item + Atom entry, one parser) ============
// Block-scoped (a missing <link> can no longer bleed into the next item), RDF-tolerant
// (<item rdf:about=…>), entity-decoded (&amp; in titles and URLs), CDATA-safe.
type FeedItem = { title: string; link: string };
const clean = (s: string): string => decodeEntities(s.replace(/<!\[CDATA\[|\]\]>/g, "")).trim();

function parseFeed(xml: string, limit: number): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g);
  for (const [block] of blocks) {
    if (items.length >= limit) break;
    const title = clean(block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const link = clean(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "")
      || clean(block.match(/<link\b[^>]*?href="([^"]+)"/)?.[1] ?? "");
    if (title && link) items.push({ title, link });
  }
  return items;
}

// ============ ROUTER ============
// Prefix-anchored: "capital" no longer routes to coding via "api", "start" no longer to creative via "art".
const ROUTES: Array<{ type: string; bot: string; reason: string; re: RegExp }> = [
  { type: "coding",       bot: "deepseek", reason: "deepseek specializes in code",
    re: /\b(?:code|coding|debug|script|function|api\b|bug|deploy|git\b|github|sql|regex)/ },
  { type: "creative",     bot: "ember",    reason: "ember specializes in creative work",
    re: /\b(?:write|story|poem|lyric|creative|design|art(?:ist|work|s)?\b|draw)/ },
  { type: "research",     bot: "grok",     reason: "grok specializes in research",
    re: /\b(?:research|analy[sz]e|investigate|compare|explain|what is|why\b)/ },
  { type: "logic",        bot: "gemini",   reason: "gemini specializes in logic",
    re: /\b(?:math|calculat|logic|prove|equation|statistic)/ },
  { type: "coordination", bot: "whisper",  reason: "whisper is the team coordinator",
    re: /\b(?:coordinat|plan(?:s|ning)?\b|organi[sz]e|manage|team|schedul)/ },
];

const nameSchema = z.string().trim().min(1).max(40);

// Built PER REQUEST. A shared McpServer rejects every overlapping call with
// "Already connected to a transport" — the SDK's stateless pattern is one server per request.
function buildServer(): McpServer {
  const server = new McpServer({ name: "highway-chat-mcp-server", version: "3.1.0" });

  // ---- Messages ----
  tool(server, "read_messages",
    { title: "Read Highway messages", description: "Read the newest messages from Highway Chat, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) }, readOnly: true },
    async ({ limit }) => {
      const messages = (await queryNewest(MESSAGES, limit)).map(fmtMsg);
      return { count: messages.length, messages };
    });

  tool(server, "send_message",
    { title: "Send a Highway message", description: "Post a message to Highway Chat.",
      inputSchema: { name: nameSchema, text: z.string().trim().min(1).max(2000) } },
    async ({ name, text }) => {
      await firestore(`/${MESSAGES}`, { method: "POST", body: buildMessageFields(name, text), forName: name });
      return { ok: true, name, ts: Date.now() };
    });

  tool(server, "send_voice",
    { title: "Send a Highway voice message", description: "Post a voice message (base64 audio, max ~750KB decoded; a Firestore doc caps at 1 MiB).",
      inputSchema: {
        name: nameSchema, audio: z.string().min(1).max(1000000),
        audioType: z.string().optional().default("audio/webm"),
        caption: z.string().trim().max(200).optional().default("🎤 voice message"),
      } },
    async ({ name, audio, audioType, caption }) => {
      const doc = buildMessageFields(name, caption || "🎤 voice message");
      const fields: Fields = doc.fields;
      fields.audio = { stringValue: audio };
      fields.audioType = { stringValue: audioType || "audio/webm" };
      await firestore(`/${MESSAGES}`, { method: "POST", body: doc, forName: name });
      return { ok: true, name, ts: Date.now() };
    });

  tool(server, "route_task",
    { title: "Route a task to the best AI", description: "Analyze a task and recommend which team AI should handle it.",
      inputSchema: { task: z.string().trim().min(1).max(2000) }, readOnly: true },
    async ({ task }) => {
      const hit = ROUTES.find((r) => r.re.test(task.toLowerCase()));
      return { task, taskType: hit?.type ?? "general",
        recommended: hit?.bot ?? "whisper", reason: hit?.reason ?? "default coordinator" };
    });

  tool(server, "edit_message",
    { title: "Edit a Highway message", description: "Edit your own message. Only the original author can edit.",
      inputSchema: { name: nameSchema, message_id: z.string().trim().min(1), text: z.string().trim().min(1).max(2000) } },
    async ({ name, message_id, text }) => {
      const { id, fields } = await getMessageOrThrow(message_id, name);
      requireAuthor(fields, name, "edit");
      await patchFields(MESSAGES, id, { text: { stringValue: text } }, name);
      return { ok: true, message_id: id, text };
    });

  tool(server, "delete_message",
    { title: "Delete a Highway message", description: "Delete your own message. Only the original author can delete.",
      inputSchema: { name: nameSchema, message_id: z.string().trim().min(1) }, destructive: true },
    async ({ name, message_id }) => {
      const { id, fields } = await getMessageOrThrow(message_id, name);
      requireAuthor(fields, name, "delete");
      await firestore(`/${MESSAGES}/${encodeURIComponent(id)}`, { method: "DELETE", forName: name });
      return { ok: true, message_id: id, deleted: true };
    });

  tool(server, "react_to_message",
    { title: "React to a Highway message", description: "Toggle an emoji reaction on a message.",
      inputSchema: { name: nameSchema, message_id: z.string().trim().min(1), emoji: z.string().trim().min(1).max(8) } },
    async ({ name, message_id, emoji }) => {
      const { id } = await getMessageOrThrow(message_id, name);
      let action = "added";
      let result: Record<string, string[]> = {};
      await mutateDoc(MESSAGES, id, (current) => {
        const rx = parseReactions(current?.reactions);
        const users = rx[emoji] ?? [];
        const i = users.findIndex((u) => u.toLowerCase() === name.toLowerCase());
        if (i >= 0) { users.splice(i, 1); action = "removed"; } else { users.push(name); action = "added"; }
        if (users.length) rx[emoji] = users; else delete rx[emoji];
        result = rx;
        return { reactions: encodeReactions(rx) };
      }, name);
      return { ok: true, message_id: id, emoji, action, reactions: result };
    });

  tool(server, "search_messages",
    { title: "Search Highway messages", description: "Keyword search over the 200 newest messages.",
      inputSchema: { query: z.string().trim().min(1).max(100), limit: z.number().int().min(1).max(50).default(10) },
      readOnly: true },
    async ({ query, limit }) => {
      const q = query.toLowerCase();
      const matches = (await queryNewest(MESSAGES, 200)).map(fmtMsg)
        .filter((m) => m.text.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
        .slice(0, limit);
      return { count: matches.length, query, matches };
    });

  tool(server, "pin_message",
    { title: "Pin or unpin a Highway message", description: "Pin a message so it stands out, or unpin it.",
      inputSchema: { name: nameSchema, message_id: z.string().trim().min(1), pinned: z.boolean().default(true) } },
    async ({ name, message_id, pinned }) => {
      const { id, fields } = await getMessageOrThrow(message_id, name);
      await patchFields(MESSAGES, id, { pinned: { booleanValue: pinned } }, name);
      await notify(name, `${pinned ? "pinned" : "unpinned"} a message: ${str(fields.text).slice(0, 120)}`, name);
      return { ok: true, message_id: id, pinned };
    });

  tool(server, "read_pinned",
    { title: "Read pinned Highway messages", description: "List pinned messages, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) }, readOnly: true },
    async ({ limit }) => {
      const { docs, degraded } = await queryDocs(MESSAGES, { orderField: "ts", limit, where: {
        field: "pinned", op: "EQUAL", value: { booleanValue: true }, match: (d) => boolOf(d.fields?.pinned) } });
      const pins = docs.map(fmtMsg);
      return { count: pins.length, pins, ...(degraded ? { degraded: true } : {}) };
    });

  // ---- Presence / Typing ----
  tool(server, "set_presence",
    { title: "Set Highway presence", description: "Mark a participant as present. One doc per name, updated in place.",
      inputSchema: { name: nameSchema } },
    async ({ name }) => {
      const docId = encodeURIComponent(name.toLowerCase().replace(/[/\s]+/g, "_"));
      await firestore(`/${PRESENCE}/${docId}`, { method: "PATCH", forName: name,
        body: { fields: { name: { stringValue: name }, ts: nowTs() } } });
      return { ok: true, name, ts: Date.now() };
    });

  tool(server, "get_presence",
    { title: "Get Highway presence", description: "Who is online. Online = heartbeat fresher than 90 seconds.",
      inputSchema: {}, readOnly: true },
    async () => {
      const people = (await listDocs(PRESENCE)).map((d) => {
        const ts = tsOf(d.fields?.ts);
        return { name: str(d.fields?.name), ts, online: isOnline(ts) };
      });
      return { count: people.length, online: people.filter((p) => p.online).length, people };
    });

  tool(server, "set_typing",
    { title: "Set typing indicator", description: "Show (or clear) your typing indicator.",
      inputSchema: { name: nameSchema, typing: z.boolean() } },
    async ({ name, typing }) => {
      await patchFields(TYPING, `mcp-${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        { name: { stringValue: name }, typing: { booleanValue: typing }, ts: nowTs() }, name);
      return { ok: true, name, typing };
    });

  // ---- Memory flywheel ----
  tool(server, "save_milestone",
    { title: "Save a milestone to evolution log", description: "Log a significant moment to the permanent timeline.",
      inputSchema: { text: z.string().trim().min(1).max(2000), type: z.string().optional().default("milestone") } },
    async ({ text, type }) => {
      await firestore(`/${EVO_LOGS}`, { method: "POST", body: evoDoc(type || "milestone", text) });
      return { ok: true };
    });

  // Newest-first (the old page read returned an arbitrary slice). Telemetry is excluded by default so
  // failure/latency logs cannot drown the memory timeline. Output is compact {id,…} rows, not raw Firestore.
  tool(server, "recall_context",
    { title: "Recall lifetime context", description: "Read the newest evolution timeline entries and stored preferences.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().default(20),
        include_telemetry: z.boolean().optional().default(false) }, readOnly: true },
    async ({ limit, include_telemetry }) => {
      const n = limit || 20;
      const [logDocs, memDocs] = await Promise.all([
        queryNewestNum(EVO_LOGS, include_telemetry ? n : Math.min(n * 3, 150)),
        queryNewestNum(JARVIS_MEM, n),
      ]);
      const evolution_logs = logDocs
        .filter((d) => include_telemetry || str(d.fields?.type) !== "telemetry")
        .slice(0, n)
        .map((d) => ({ id: docIdOf(d.name), type: str(d.fields?.type), text: str(d.fields?.text), ts: bestTs(d) }));
      const jarvis_memory = memDocs.map((d) => ({
        id: docIdOf(d.name), key: str(d.fields?.key), value: str(d.fields?.value), ts: bestTs(d) }));
      return { evolution_logs, jarvis_memory };
    });

  tool(server, "store_preference",
    { title: "Store a user preference", description: "Save a durable preference to permanent memory.",
      inputSchema: { key: z.string().trim().min(1).max(200), value: z.string().trim().min(1).max(2000) } },
    async ({ key, value }) => {
      await firestore(`/${JARVIS_MEM}`, { method: "POST",
        body: { fields: { key: { stringValue: key }, value: { stringValue: value }, tsNum: nowNum() } } });
      return { ok: true, key };
    });

  tool(server, "log_correction",
    { title: "Log a correction to permanent memory", description: "Log a user correction so the mistake is never repeated.",
      inputSchema: { correction: z.string().trim().min(1).max(2000), context: z.string().trim().max(500).optional().default("") } },
    async ({ correction, context }) => {
      await firestore(`/${EVO_LOGS}`, { method: "POST",
        body: evoDoc("correction", `CORRECTION: ${correction}${context ? ` [Context: ${context}]` : ""}`) });
      return { ok: true };
    });

  // ---- Activity ----
  tool(server, "log_activity",
    { title: "Log Highway activity", description: "Post an entry to the ACTIVITY feed.",
      inputSchema: { name: nameSchema, text: z.string().trim().min(1).max(300) } },
    async ({ name, text }) => {
      await postActivity(name, text, name);
      return { ok: true, name, text, ts: Date.now() };
    });

  tool(server, "read_activity",
    { title: "Read Highway activity", description: "Read recent ACTIVITY feed entries, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) }, readOnly: true },
    async ({ limit }) => {
      const entries = (await queryNewest(ACTIVITY, limit)).map((d) => {
        const f = d.fields ?? {};
        return { id: docIdOf(d.name), by: str(f.by), text: str(f.text), ts: tsOf(f.ts) };
      });
      return { count: entries.length, entries };
    });

  // ---- Tasks ----
  tool(server, "read_tasks",
    { title: "Read Highway tasks", description: "List quests on the Highway board, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(30), include_done: z.boolean().default(true) },
      readOnly: true },
    async ({ limit, include_done }) => {
      let tasks = (await queryNewest(TASKS, limit)).map(fmtTask);
      if (!include_done) tasks = tasks.filter((t) => !t.done);
      return { count: tasks.length, open: tasks.filter((t) => !t.done).length, tasks };
    });

  tool(server, "add_task",
    { title: "Add a Highway task", description: "Add a quest to the board. Posts to ACTIVITY automatically.",
      inputSchema: { name: nameSchema, text: z.string().trim().min(1).max(300),
        priority: z.enum(["low", "normal", "high"]).default("normal"), assignee: z.string().trim().max(40).optional() } },
    async ({ name, text, priority, assignee }) => {
      const fields: Fields = {
        text: { stringValue: text }, done: { booleanValue: false },
        createdBy: { stringValue: name }, priority: { stringValue: priority }, ts: nowTs() };
      if (assignee) fields.assignee = { stringValue: assignee };
      const data = await firestore(`/${TASKS}`, { method: "POST", body: { fields }, forName: name });
      await notify(name, `started quest: ${text.slice(0, 200)}`, name);
      return { ok: true, id: docIdOf(data.name), text };
    });

  tool(server, "complete_task",
    { title: "Complete a Highway task", description: "Mark a quest complete by ID or title match.",
      inputSchema: { name: nameSchema, task_id: z.string().trim().min(1).optional(), title: z.string().trim().min(1).max(300).optional() } },
    async ({ name, task_id, title }) => {
      if (!task_id && !title) throw new UserError("provide task_id or title");
      const task = await findTask(task_id, title);
      if (!task) throw new UserError("task not found");
      await patchFields(TASKS, task.id, { done: { booleanValue: true } }, name);
      const text = str(task.fields.text);
      await notify(name, `completed quest: ${text.slice(0, 200)}`, name);
      return { ok: true, id: task.id, text, done: true };
    });

  tool(server, "update_task",
    { title: "Update a Highway task", description: "Edit a quest's title, priority, or assignee by ID.",
      inputSchema: { name: nameSchema, task_id: z.string().trim().min(1),
        text: z.string().trim().min(1).max(300).optional(), priority: z.enum(["low", "normal", "high"]).optional(),
        assignee: z.string().trim().max(40).optional() } },
    async ({ name, task_id, text, priority, assignee }) => {
      const task = await getTaskOrThrow(task_id);
      const fields: Record<string, unknown> = {};
      if (text !== undefined) fields.text = { stringValue: text };
      if (priority !== undefined) fields.priority = { stringValue: priority };
      if (assignee !== undefined) fields.assignee = { stringValue: assignee };
      if (!Object.keys(fields).length) throw new UserError("nothing to update");
      await patchFields(TASKS, task.id, fields, name);
      const newText = text ?? str(task.fields.text);
      await notify(name, `updated quest: ${newText.slice(0, 200)}`, name);
      return { ok: true, id: task.id, text: newText };
    });

  tool(server, "delete_task",
    { title: "Delete a Highway task", description: "Remove a quest from the board by ID.",
      inputSchema: { name: nameSchema, task_id: z.string().trim().min(1) }, destructive: true },
    async ({ name, task_id }) => {
      const task = await getTaskOrThrow(task_id);
      const text = str(task.fields.text);
      await firestore(`/${TASKS}/${encodeURIComponent(task.id)}`, { method: "DELETE", forName: name });
      await notify(name, `abandoned quest: ${text.slice(0, 200)}`, name);
      return { ok: true, id: task.id, deleted: true };
    });

  tool(server, "assign_task",
    { title: "Assign a Highway task", description: "Assign a quest to a team member by task ID.",
      inputSchema: { name: nameSchema, task_id: z.string().trim().min(1), assignee: z.string().trim().min(1).max(40) } },
    async ({ name, task_id, assignee }) => {
      const task = await getTaskOrThrow(task_id);
      await patchFields(TASKS, task.id, { assignee: { stringValue: assignee } }, name);
      await notify(name, `assigned quest "${str(task.fields.text).slice(0, 120)}" to ${assignee}`, name);
      return { ok: true, id: task.id, assignee };
    });

  // ---- Notes ----
  tool(server, "read_notes",
    { title: "Read the Highway grimoire", description: "Read the shared Highway notes page.",
      inputSchema: {}, readOnly: true },
    async () => {
      const doc = await getDocOrNull(NOTES, "shared");
      if (!doc?.fields) return { exists: false, content: "", updatedBy: null, ts: null };
      const f = doc.fields;
      return { exists: true, content: str(f.content), updatedBy: str(f.updatedBy), ts: tsOf(f.ts) };
    });

  tool(server, "update_notes",
    { title: "Overwrite the Highway grimoire", description: "Replace the entire shared notes page. Prefer append_note.",
      inputSchema: { name: nameSchema, content: z.string().max(20000) }, destructive: true },
    async ({ name, content }) => {
      await patchFields(NOTES, "shared",
        { content: { stringValue: content }, updatedBy: { stringValue: name }, ts: nowTs() }, name);
      return { ok: true, updatedBy: name, chars: content.length };
    });

  tool(server, "append_note",
    { title: "Append to the Highway grimoire", description: "Add a signed entry without overwriting.",
      inputSchema: { name: nameSchema, text: z.string().trim().min(1).max(5000) } },
    async ({ name, text }) => {
      let chars = 0;
      await mutateDoc(NOTES, "shared", (current) => {
        const content = (str(current?.content) + `\n\n— ${name} · ${new Date().toISOString()}\n${text}`).slice(-20000);
        chars = content.length;
        return { content: { stringValue: content }, updatedBy: { stringValue: name }, ts: nowTs() };
      }, name);
      return { ok: true, updatedBy: name, chars };
    });

  // ---- News / Team / Stats ----
  tool(server, "get_news",
    { title: "Get Highway money news", description: "Money, tech & social news feed (crypto + markets + macro + social/tech). 5-min server cache.",
      inputSchema: { limit: z.number().int().min(1).max(15).default(10) }, readOnly: true, openWorld: true },
    async ({ limit }) => {
      const items = (await getNews()).slice(0, limit).map((it) => ({
        title: it.title, url: it.url, source: it.source,
        image: it.image || null, description: it.description || null }));
      return { ok: true, count: items.length, items };
    });

  tool(server, "get_team",
    { title: "Get Highway team", description: "Members with online status — presence merged with recent chatters.",
      inputSchema: {}, readOnly: true },
    async () => {
      const degraded: string[] = [];
      const [presDocs, msgDocs] = await Promise.all([
        settle("get_team:presence", listDocs(PRESENCE), [] as Doc[], degraded),
        settle("get_team:messages", queryNewest(MESSAGES, 50), [] as Doc[], degraded),
      ]);
      const now = Date.now();
      const online = new Set<string>();
      for (const d of presDocs) {
        if (isOnline(tsOf(d.fields?.ts), now)) online.add(str(d.fields?.name).toLowerCase());
      }
      const seen = new Map<string, { name: string; online: boolean; lastSeen: number | null }>();
      for (const d of msgDocs) {
        const n = str(d.fields?.name);
        if (n && !seen.has(n.toLowerCase()))
          seen.set(n.toLowerCase(), { name: n, online: online.has(n.toLowerCase()), lastSeen: tsOf(d.fields?.ts) });
      }
      return { count: seen.size, members: [...seen.values()], ...(degraded.length ? { degraded } : {}) };
    });

  tool(server, "get_stats",
    { title: "Get Highway room stats", description: "Room vitals: messages, quests, online count, activity, grimoire freshness.",
      inputSchema: {}, readOnly: true },
    async () => {
      const degraded: string[] = [];
      const [msgTotal, taskDocs, presDocs, notesDoc] = await Promise.all([
        countDocs(MESSAGES),
        settle("get_stats:tasks", queryNewest(TASKS, 200), [] as Doc[], degraded),
        settle("get_stats:presence", listDocs(PRESENCE), [] as Doc[], degraded),
        settle("get_stats:notes", getDocOrNull(NOTES, "shared"), null as Doc | null, degraded),
      ]);
      if (msgTotal === null) degraded.push("get_stats:messages");
      const now = Date.now();
      const tasks = taskDocs.map(fmtTask);
      const nf = notesDoc?.fields;
      return {
        messages_total: msgTotal, tasks_open: tasks.filter((t) => !t.done).length,
        tasks_done: tasks.filter((t) => t.done).length,
        online_now: presDocs.filter((d) => isOnline(tsOf(d.fields?.ts), now)).length,
        grimoire: nf ? { updatedBy: str(nf.updatedBy), ts: tsOf(nf.ts), chars: str(nf.content).length } : null,
        server_time: new Date().toISOString(),
        ...(degraded.length ? { degraded } : {}),
      };
    });

  tool(server, "get_time",
    { title: "Get server time", description: "Current server time (ISO 8601 and unix ms).",
      inputSchema: {}, readOnly: true },
    async () => ({ iso: new Date().toISOString(), unix_ms: Date.now() }));

  // ---- V7.0 Overdrive Grid ----
  tool(server, "extract_site_schema",
    { title: "Extract site schema", description: "Extract structural fingerprint from a webpage for scraping.",
      inputSchema: { url: z.string().url() }, readOnly: true, openWorld: true },
    async ({ url }) => {
      const stripped = stripHtml(await fetchPublic(url, 8000));
      return { url, bytes: stripped.length, fingerprint: fnv1a(stripped.slice(0, 2000)) };
    });

  tool(server, "diff_check_page",
    { title: "Diff check page", description: "Deterministic content hash — true change detection, no false positives.",
      inputSchema: { url: z.string().url(), previousHash: z.string() }, readOnly: true, openWorld: true },
    async ({ url, previousHash }) => {
      const normalized = stripHtml(await fetchPublic(url, 8000)).replace(/\s+/g, " ");
      const currentHash = fnv1a(normalized);
      return { changed: currentHash !== previousHash, currentHash };
    });

  tool(server, "monitor_rss_stream",
    { title: "Monitor RSS stream", description: "Fetch and parse an RSS/Atom feed into structured items.",
      inputSchema: { feedUrl: z.string().url(), limit: z.number().int().min(1).max(20).optional() },
      readOnly: true, openWorld: true },
    async ({ feedUrl, limit }) => {
      const items = parseFeed(await fetchPublic(feedUrl, 8000), limit || 10);
      return { feed: feedUrl, count: items.length, items };
    });

  tool(server, "condense_session_logs",
    { title: "Condense session logs", description: "Condense chat history into a dense JSON summary.",
      inputSchema: { limit: z.number().int().min(5).max(50).optional() }, readOnly: true },
    async ({ limit }) => {
      const condensed = (await queryNewest(MESSAGES, limit || 20)).map((d) => {
        const f = d.fields ?? {};
        return { n: str(f.name), t: str(f.text).slice(0, 200) };
      });
      return { count: condensed.length, condensed };
    });

  tool(server, "dispatch_ambient_tts",
    { title: "Dispatch ambient TTS", description: "STANDBY: Package text for future ambient TTS hardware.",
      inputSchema: { text: z.string().min(1).max(500) } },
    async ({ text }) => ({
      status: "STANDBY_CLOUD_READY", format: "mp3_pcm",
      textLength: text.length, queued_for: "LOCAL_BEAST_TUNNEL" }));

  tool(server, "mutate_environment_relay",
    { title: "Mutate environment relay", description: "STANDBY: Queue a hardware relay command for the future local PC.",
      inputSchema: { device: z.string().min(1).max(50), zone: z.string().min(1).max(50),
        action: z.string().min(1).max(50), value: z.number().optional() } },
    async ({ device, zone, action, value }) => {
      const body = { fields: {
        device: { stringValue: device }, zone: { stringValue: zone },
        action: { stringValue: action }, value: { integerValue: String(Math.trunc(value ?? 0)) },
        status: { stringValue: "QUEUED_IN_BRAIN_STEM" },
        target: { stringValue: "LOCAL_BEAST_TUNNEL" }, tsNum: nowNum() } };
      // POST-then-PATCH upsert: create wins the first write, 409 falls through to an update
      try {
        await firestore(`/${SYS_CONFIG}?documentId=hardware_relay_buffer`, { method: "POST", body });
      } catch (e) {
        if (!(e instanceof FirestoreError && (e.status === 409 || e.code === "ALREADY_EXISTS"))) throw e;
        await patchFields(SYS_CONFIG, "hardware_relay_buffer", body.fields);
      }
      return { status: "QUEUED_IN_BRAIN_STEM", device, zone, action };
    });

  // ---- Pinecone Pattern Refinery ----
  tool(server, "query_pattern_refinery",
    { title: "Query pattern refinery", description: "Vector-search the Pinecone refinery for past winning patterns.",
      inputSchema: { query: z.string().min(1).max(500), topK: z.number().int().min(1).max(10).optional() },
      readOnly: true },
    async ({ query, topK }) => {
      const { host, dimension } = await pineconeIndex();
      const r = await http(`https://${host}/query`, {
        method: "POST", headers: pineconeHeaders(),
        body: JSON.stringify({ vector: new Array(dimension).fill(0), topK: topK || 5, includeMetadata: true }),
      }, EXT_TIMEOUT);
      const data = parseJson(r.body);
      if (!r.ok) throw new Error(`Pinecone query ${r.status}: ${data?.message ?? r.statusText}`);
      return { query,
        matches: (data.matches ?? []).map((m: any) => ({ id: m.id, score: m.score, metadata: m.metadata ?? {} })) };
    });

  tool(server, "store_pattern_win",
    { title: "Store pattern win", description: "Store a winning pattern fingerprint to the Pinecone refinery.",
      inputSchema: { pattern_id: z.string().min(1).max(100), metadata: z.record(z.string(), z.string()).optional() } },
    async ({ pattern_id, metadata }) => {
      const { host, dimension } = await pineconeIndex();
      const r = await http(`https://${host}/vectors/upsert`, {
        method: "POST", headers: pineconeHeaders(),
        body: JSON.stringify({ vectors: [{
          id: pattern_id,
          values: new Array(dimension).fill(0.01),
          metadata: { ...(metadata || {}), stored_at: new Date().toISOString(), source: "static-refinery" },
        }] }),
      }, EXT_TIMEOUT);
      if (!r.ok) throw new Error(`Pinecone upsert ${r.status}: ${parseJson(r.body)?.message ?? r.statusText}`);
      return { stored: true, pattern_id };
    });

  // ============ MARROW WAVE 4: SENSES & SELF-AWARENESS ============
  // Future-proof: zero hardcoded keys. HITL: propose_patch queues only. Ouroboros: telemetry feeds self-evolution.

  tool(server, "web_search",
    { title: "Web search", description: "Search the web via DuckDuckGo (no API key). Powers the 4h hunt and research loops.",
      readOnly: true, openWorld: true,
      inputSchema: { query: z.string().trim().min(1).max(300), limit: z.number().int().min(1).max(20).optional().default(8) } },
    async ({ query, limit }) => {
      const n = limit || 8;
      const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 10000);
      // DDG bot-blocks return tiny pages — fail loud, never return a silent empty set
      if (html.length < 1500) throw new Error("search returned a blocked/empty response");
      const results: Array<{ title: string; url: string }> = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null && results.length < n) {
        let href = decodeEntities(m[1]);
        if (href.startsWith("//")) href = "https:" + href;
        const uddg = href.match(/[?&]uddg=([^&]+)/);
        if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch { /* malformed escape: keep the raw href */ } }
        if (href.startsWith("/")) continue;
        const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
        if (title && href) results.push({ title, url: href });
      }
      return { query, count: results.length, results };
    });

  tool(server, "fetch_page_text",
    { title: "Fetch page text", description: "Get readable text from a URL: strips scripts/styles/tags, collapses whitespace.",
      readOnly: true, openWorld: true,
      inputSchema: { url: z.string().url(), maxChars: z.number().int().min(100).max(20000).optional().default(5000) } },
    async ({ url, maxChars }) => {
      const text = htmlToText(await fetchPublic(url, 10000));
      return { url, chars: text.length, text: text.slice(0, maxChars || 5000) };
    });

  tool(server, "propose_patch",
    { title: "Propose patch", description: "Queue a code/config change for sin's HITL approval. NEVER auto-applies — queues a pending_approval task to the Tasks tab.",
      inputSchema: { title: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(1000), patch_summary: z.string().trim().min(1).max(3000) } },
    async ({ title, description, patch_summary }) => {
      const fields = {
        text: { stringValue: `[PATCH PROPOSAL] ${title}` },
        description: { stringValue: description },
        patch_summary: { stringValue: patch_summary },
        type: { stringValue: "patch_proposal" },
        status: { stringValue: "pending_approval" },
        done: { booleanValue: false },
        createdBy: { stringValue: "static" },
        priority: { stringValue: "high" },
        ts: nowTs(),
      };
      const data = await firestore(`/${TASKS}`, { method: "POST", body: { fields } });
      return { queued: true, task_title: title, task_id: docIdOf(data.name), status: "pending_approval",
        note: "Awaiting sin's one-tap approval. Nothing was changed." };
    });

  tool(server, "score_lead",
    { title: "Score job lead", description: "Score a job lead 0-100 against sin's weighted hunt criteria (Vector B 80 / Vector A 20).", readOnly: true,
      inputSchema: { title: z.string().trim().min(1).max(200), company: z.string().trim().max(200).optional().default(""), pay: z.string().trim().max(100).optional().default(""), location: z.string().trim().max(200).optional().default(""), is_remote: z.boolean().optional().default(false) } },
    async ({ title, company, pay, location, is_remote }) => {
      const t = `${title} ${company} ${pay} ${location}`.toLowerCase();
      const breakdown: Record<string, number> = {};
      const payNums = (pay.match(/\$\s?(\d{2,3}(?:\.\d+)?)/g) || []).map((s) => Number(s.replace(/[^\d.]/g, "")));
      if (payNums.some((n) => n >= 16)) breakdown.pay_16_plus = 30;
      if (/entry[- ]?level|junior|no experience|0[-–]2\s*(yrs?|years?)|trainee/i.test(t)) breakdown.entry_level = 20;
      if (is_remote || /sacramento|west sacramento|davis|woodland/i.test(location)) breakdown.location_or_remote = 20;
      const vecB = /warehouse|logistics|delivery|fulfillment|package\s*handler/i.test(t);
      const vecA = /tech\s*support|help\s*desk|data\s*entry|customer\s*support|\bqa\b|it\s*support/i.test(t);
      if (vecB) breakdown.vector_b_capital = 15;
      if (vecA) breakdown.vector_a_tech = 15;
      const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
      const vector = vecB ? "B" : vecA ? "A" : "none";
      return { score, breakdown, vector, title, company, pay, location, is_remote };
    });

  tool(server, "get_crypto_price",
    { title: "Crypto price", description: "Get a coin's USD price and 24h change from CoinGecko (free, no key).", readOnly: true, openWorld: true,
      inputSchema: { coin_id: z.string().trim().min(1).max(60) } },
    async ({ coin_id }) => {
      const id = coin_id.toLowerCase().trim();
      const data = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true`, 10000);
      const row = data?.[id];
      if (typeof row?.usd !== "number") throw new UserError(`coin not found: ${id}`);
      return { coin_id: id, usd_price: row.usd, change_24h: row.usd_24h_change ?? null };
    });

  tool(server, "track_tool_telemetry",
    { title: "Track tool telemetry", description: "Log tool latency/success to evolution_logs. The Reflection Engine's nervous system.",
      inputSchema: { tool_name: z.string().trim().min(1).max(100), latency_ms: z.number().min(0), success: z.boolean(), error: z.string().trim().max(500).optional().default("") } },
    async ({ tool_name, latency_ms, success, error }) => {
      await firestore(`/${EVO_LOGS}`, { method: "POST", body: telemetryDoc(tool_name, latency_ms, success, error) });
      return { logged: true, tool_name };
    });

  // Exact-URL dedupe. The old 40-char prefix match flagged DIFFERENT jobs as duplicates
  // (e.g. every linkedin.com/jobs/view/12345… shares its first 40 chars) and silently dropped real leads.
  tool(server, "dedupe_leads",
    { title: "Dedupe leads", description: "Check whether a job lead URL was already logged this cycle. Stops the 4h hunt re-alerting on the same job.", readOnly: true,
      inputSchema: { url: z.string().trim().min(1).max(500) } },
    async ({ url }) => {
      const target = normalizeUrl(url);
      const isUrl = /^https?:\/\//i.test(url.trim());
      const matchDoc = (d: Doc): boolean => {
        const text = str(d.fields?.text), field = str(d.fields?.url);
        if (!isUrl) return `${text} ${field}`.toLowerCase().includes(target);
        return [field, ...(text.match(URL_RE) ?? [])].some((u) => u && normalizeUrl(u) === target);
      };
      const { docs, degraded } = await queryDocs(EVO_LOGS, { orderField: "tsNum", limit: 50, where: {
        field: "type", op: "EQUAL", value: { stringValue: "job_hunt" }, match: (d) => str(d.fields?.type) === "job_hunt" } });
      return { is_duplicate: docs.some(matchDoc), checked: docs.length, ...(degraded ? { degraded: true } : {}) };
    });

  tool(server, "check_bridge_health",
    { title: "Bridge health check", description: "Self-diagnostic: verifies env vars and Firestore reachability.", readOnly: true,
      inputSchema: {} },
    async () => {
      const checks = {
        firebase_key: !!process.env.FIREBASE_API_KEY,
        client_key: !!process.env.HIGHWAY_CLIENT_KEY,
        mcp_secret: !!process.env.MCP_SECRET,
        pinecone_key: !!process.env.PINECONE_API_KEY,
        firestore_reachable: false,
      };
      let firestore_error: string | undefined;
      try {
        await firestore(`/${EVO_LOGS}?pageSize=1`, { method: "GET" });
        checks.firestore_reachable = true;
      } catch (e) {
        firestore_error = errMsg(e);
        recordFailure("check_bridge_health", e);
      }
      return { healthy: Object.values(checks).every(Boolean), checks, ...(firestore_error ? { firestore_error } : {}) };
    });

  tool(server, "get_weather",
    { title: "Get weather", description: "Current weather from Open-Meteo (free, no key). First ambient-world sensor.", readOnly: true, openWorld: true,
      inputSchema: { latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) } },
    async ({ latitude, longitude }) => {
      const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`, 10000);
      const cur = data?.current || {};
      return { temp_f: cur.temperature_2m ?? null, weather_code: cur.weather_code ?? null };
    });

  tool(server, "summarize_thread",
    { title: "Summarize thread", description: "Extract decisions, questions, and action items from recent Highway Chat messages.", readOnly: true,
      inputSchema: { limit: z.number().int().min(5).max(50).optional().default(20) } },
    async ({ limit }) => {
      const msgs = await queryNewest(MESSAGES, limit || 20);
      const decisions: string[] = [], questions: string[] = [], actions: string[] = [];
      for (const d of msgs) {
        const f = d.fields ?? {};
        const text = str(f.text).trim();
        if (!text) continue;
        const line = `${str(f.name) || "unknown"}: ${text.slice(0, 160)}`;
        if (/\b(decided|decision|agreed|locked in|going with)\b/i.test(text)) decisions.push(line);
        else if (text.includes("?")) questions.push(line);
        else if (/\b(will|todo|action item|action:|need to|must|going to)\b/i.test(text)) actions.push(line);
      }
      return { message_count: msgs.length, decisions, questions, actions };
    });

  return server;
}

// ============ URL NORMALIZATION (dedupe_leads) ============
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|ref$|refid$|trk$|trackingid$)/i;
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return (u.origin + u.pathname.replace(/\/+$/, "") + u.search).toLowerCase();
  } catch {
    return raw.trim().toLowerCase().replace(/\/+$/, "");
  }
}

// ============ NEWS ENGINE (parallel fetch, ordered processing, per-section isolation) ============
type NewsItem = { title: string; url: string; source: string; image: string; description: string };
type Coin = { sym: string; name: string; id: string; price: number; pct: number; image: string };

const titleKey = (title: string): string => title.toLowerCase().slice(0, 48);
function dedupeItems(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter((it) => { const k = titleKey(it.title); if (seen.has(k)) return false; seen.add(k); return true; });
}

function coinItem(c: Coin): NewsItem {
  return { title: `${c.sym.toUpperCase()} ${fmtUsd(c.price)} ${fmtPct(c.pct)}`,
    url: `https://www.coingecko.com/en/coins/${c.id}`, source: "CRYPTO", image: c.image,
    description: impactLine(c.pct, `${c.name} holders`) };
}

// Kraken pair keys are legacy-prefixed: XXBTZUSD, XETHZUSD, XXRPZUSD, XDGUSD, SOLUSD…
// The old normalizer produced "XBTZ"/"ETHZ"/"XRPZ"/"DG", so BTC and ETH never matched and the
// crypto section lost its two headliners whenever Kraken was the active provider.
const KRAKEN_ALIAS: Record<string, string> = { XBT: "BTC", XDG: "DOGE" };
function krakenBase(key: string): string {
  let base = key.replace(/Z?USD$/, "");
  if (base.length === 4 && base.startsWith("X")) base = base.slice(1);
  return KRAKEN_ALIAS[base] ?? base;
}
const KRAKEN_COINS: Record<string, [string, string]> = {
  BTC: ["Bitcoin", "bitcoin"], ETH: ["Ethereum", "ethereum"], SOL: ["Solana", "solana"],
  DOGE: ["Dogecoin", "dogecoin"], XRP: ["XRP", "ripple"], ADA: ["Cardano", "cardano"],
  AVAX: ["Avalanche", "avalanche"], LINK: ["Chainlink", "chainlink"],
};

async function cryptoNews(): Promise<NewsItem[]> {
  const providers: Array<() => Promise<Coin[]>> = [
    async () => { // Kraken — free, no key
      const k = await fetchJson("https://api.kraken.com/0/public/Ticker?pair=BTCUSD,ETHUSD,SOLUSD,DOGEUSD,XRPUSD,ADAUSD,AVAXUSD,LINKUSD");
      if (!k?.result || k.error?.length) throw new Error("kraken error");
      const out: Coin[] = [];
      for (const [rawKey, t] of Object.entries<any>(k.result)) {
        const sym = krakenBase(rawKey);
        const meta = KRAKEN_COINS[sym];
        if (!meta) continue;
        const price = parseFloat(t.c[0]), open = parseFloat(t.o);
        if (price && open) out.push({ sym, name: meta[0], id: meta[1], price, pct: (price - open) / open * 100, image: "" });
      }
      if (!out.length) throw new Error("kraken empty");
      return out;
    },
    async () => { // CoinGecko — free, no key
      const coins = await fetchJson(
        "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=60&page=1&sparkline=false&price_change_percentage=24h");
      if (!Array.isArray(coins) || !coins.length) throw new Error("empty coingecko");
      return coins.map((c: any): Coin => ({ sym: c.symbol, name: c.name, id: c.id,
        price: c.current_price, pct: c.price_change_percentage_24h || 0, image: c.image || "" }));
    },
    async () => { // Binance.US — free, no key
      const tick = await fetchJson("https://api.binance.us/api/v3/ticker/24hr");
      if (!Array.isArray(tick) || !tick.length) throw new Error("empty binance");
      return tick.filter((t: any) => typeof t.symbol === "string" && t.symbol.endsWith("USD"))
        .map((t: any): Coin => { const sym = String(t.symbol).replace(/USD$/, "");
          return { sym, name: sym, id: sym.toLowerCase(), price: parseFloat(t.lastPrice),
            pct: parseFloat(t.priceChangePercent) || 0, image: "" }; });
    },
  ];
  let coins: Coin[] = [];
  for (const p of providers) {
    try { coins = await p(); if (coins.length) break; }
    catch (e) { console.warn("crypto provider failed:", errMsg(e)); }
  }
  if (!coins.length) throw new Error("all crypto providers failed");
  const symIs = (s: string) => (c: Coin) => c.sym.toUpperCase() === s;
  const headliners = [coins.find(symIs("BTC")), coins.find(symIs("ETH")),
    ...coins.filter((c) => !symIs("BTC")(c) && !symIs("ETH")(c))
      .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 3)];
  return headliners.filter((c): c is Coin => !!c).map(coinItem).slice(0, 5);
}

const MARKET_SYMS = [
  { sym: "VOO", name: "VOO S&P 500" }, { sym: "^GSPC", name: "S&P 500" },
  { sym: "^IXIC", name: "Nasdaq" }, { sym: "^DJI", name: "Dow Jones" },
  { sym: "NVDA", name: "NVIDIA" }, { sym: "TSLA", name: "Tesla" },
  { sym: "AAPL", name: "Apple" }, { sym: "MSFT", name: "Microsoft" },
  { sym: "AMZN", name: "Amazon" }, { sym: "META", name: "Meta" },
  { sym: "AMD", name: "AMD" }, { sym: "PLTR", name: "Palantir" },
];
const INDEX_SYMS = new Set(["VOO", "^GSPC", "^IXIC", "^DJI"]);

async function marketsNews(): Promise<NewsItem[]> {
  type Quote = { sym: string; name: string; idx: boolean; price: number; pct: number };
  const settled = await Promise.allSettled(MARKET_SYMS.map(async (t): Promise<Quote | null> => {
    const j = await fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t.sym)}?interval=1d&range=2d`, 8000);
    const m = j?.chart?.result?.[0]?.meta;
    if (!m?.regularMarketPrice || !m?.chartPreviousClose) return null;
    return { sym: t.sym, name: t.name, idx: INDEX_SYMS.has(t.sym), price: m.regularMarketPrice,
      pct: (m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose * 100 };
  }));
  const quotes = settled.flatMap((s) => (s.status === "fulfilled" && s.value ? [s.value] : []));
  if (!quotes.length) throw new Error("no market quotes returned");
  const link = (sym: string) => `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`;
  const items: NewsItem[] = [];
  for (const q of quotes.filter((q) => q.idx))
    items.push({ title: `${q.name} ${q.price.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${fmtPct(q.pct)}`,
      url: link(q.sym), source: "MARKETS", image: faviconFor("https://finance.yahoo.com"),
      description: q.pct >= 0 ? "Green day — stocks and retirement accounts up." : "Red day — stocks cheaper; don't panic-sell." });
  for (const q of quotes.filter((q) => !q.idx).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 2))
    items.push({ title: `${q.name} ${fmtUsd(q.price)} ${fmtPct(q.pct)} — top mover`,
      url: link(q.sym), source: "MARKETS", image: faviconFor("https://finance.yahoo.com"),
      description: impactLine(q.pct, `${q.name} holders`) });
  return items.slice(0, 5);
}

const MONEY_RE = new RegExp("\\b(" + ["rate", "fed", "inflation", "cpi", "jobs", "unemployment", "wage",
  "tariff", "tax", "recession", "gdp", "housing", "mortgage", "rent", "oil", "gas",
  "crypto", "bitcoin", "stock", "market", "dollar", "interest", "bank", "debt", "stimulus", "trade",
  "white house", "congress", "election", "midterm", "ukraine", "russia", "iran", "israel",
  "gaza", "taiwan", "china", "war", "ai", "openai", "anthropic", "nvidia", "chip", "robot",
  "spacex", "nasa", "moon", "mars", "food", "wheat", "corn", "crop", "drought", "famine", "ebt", "snap"].join("|") + ")s?\\b");
const MAJOR_RE = new RegExp("\\b(" + ["war", "conflict", "strike", "earthquake", "hurricane",
  "ceasefire", "sanctions", "nuclear", "troops", "invasion", "disaster", "flood", "wildfire",
  "volcano", "tsunami", "pandemic", "crisis", "collapse", "hormuz", "opec", "brent",
  "america", "american", "u.s.", "united states", "senate", "supreme court",
  "mortgage", "diesel", "treasury", "yield"].join("|") + ")s?\\b");
const SOFT_RE = new RegExp(["obituary", "dies at", "celebrity", "sport", "wins", "fashion", "golf club", "profits"].join("|"));

const MACRO_FEEDS = [
  "https://feeds.npr.org/1001/rss.xml", "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://www.theguardian.com/world/rss", "https://rss.dw.com/rdf/rss-en-top",
  "https://www.france24.com/en/rss",
];

async function macroNews(): Promise<NewsItem[]> {
  const feeds = await Promise.allSettled(MACRO_FEEDS.map((u) => fetchText(u)));
  const items: NewsItem[] = [];
  const seen = new Set<string>();
  feeds.forEach((f, i) => {
    if (f.status === "rejected") { console.warn("macro feed failed:", MACRO_FEEDS[i], errMsg(f.reason)); return; }
    let n = 0;
    for (const { title, link } of parseFeed(f.value, 12)) {
      if (n >= 4) break;
      const tl = title.toLowerCase(), key = tl.slice(0, 48);
      if (seen.has(key) || SOFT_RE.test(tl)) continue;
      if (!MAJOR_RE.test(tl) && !MONEY_RE.test(tl)) continue;
      seen.add(key);
      items.push({ title, url: link, source: "WORLD", image: faviconFor(link), description: macroImpact(title) });
      n++;
    }
  });
  if (!items.length && feeds.every((f) => f.status === "rejected")) throw new Error("all macro feeds failed");
  return items.slice(0, 5);
}

// ============ SOCIAL NEWS ENGINE (Google News + HN + Lobsters + YouTube + Apify) ============
const TECH_RE = new RegExp("\\b(" + ["\\bai\\b", "rag", "agent", "llm", "gpt", "claude",
  "openai", "anthropic", "gemini", "deepseek", "nvidia", "gpu", "\\bchip\\b", "robot",
  "software", "coding", "developer", "github", "startup", "model", "neural",
  "computer vision", "machine learning", "automation", "data center", "quantum",
  "cybersecurity", "breach", "hack"].join("|") + ")s?\\b");

function techImpact(title: string): string {
  const t = title.toLowerCase();
  if (/rag|retrieval/.test(t)) return "RAG in production → the practical AI pattern. Watch who's shipping it.";
  if (/agent/.test(t)) return "Agentic AI → systems that act, not just chat. Track real deployments.";
  if (/llm|gpt|claude|gemini|deepseek|model/.test(t)) return "Model moves → capability jumps. Watch benchmarks and cost.";
  if (/openai|anthropic/.test(t)) return "Lab power plays → pricing and access shift. Builders feel it first.";
  if (/nvidia|gpu|chip/.test(t)) return "Chip supply → who can afford to train. Scarcity decides winners.";
  if (/robot/.test(t)) return "Robotics → labor costs move. Watch warehouses and factories first.";
  if (/layoff|hiring|job/.test(t)) return "Jobs signal → where the money's going. Skills follow demand.";
  if (/cybersecurity|breach|hack/.test(t)) return "Security → every breach reprices trust. Patch fast.";
  return "Tech shift → builders move first. Watch who's shipping.";
}

// Google News RSS titles arrive as "Headline - Publisher"
function stripPublisher(title: string): string {
  const i = title.lastIndexOf(" - ");
  return (i > 10 ? title.slice(0, i) : title).trim();
}

// Shared social gate: topical AND not soft
function socialGate(tl: string): boolean {
  if (SOFT_RE.test(tl)) return false;
  return TECH_RE.test(tl) || MONEY_RE.test(tl) || MAJOR_RE.test(tl);
}

const SOCIAL_QUERIES = [
  "(\"Retrieval-Augmented Generation\" OR \"Agentic AI\") AND (\"deployed\" OR \"in production\")",
  "(\"computer vision\" OR \"predictive maintenance\") AND (\"manufacturing\" OR \"supply chain\")",
  "(\"AI\" OR \"artificial intelligence\") AND (\"job\" OR \"hiring\" OR \"layoff\")",
];

async function googleNewsSocial(): Promise<NewsItem[]> {
  const feeds = await Promise.allSettled(SOCIAL_QUERIES.map((q) =>
    fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, 10000)));
  const items: NewsItem[] = [];
  feeds.forEach((f, i) => {
    if (f.status === "rejected") { console.warn("google news failed:", SOCIAL_QUERIES[i].slice(0, 40), errMsg(f.reason)); return; }
    let n = 0;
    for (const { title, link } of parseFeed(f.value, 15)) {
      if (n >= 4) break;
      const headline = stripPublisher(title);
      if (!socialGate(headline.toLowerCase())) continue;
      items.push({ title: headline, url: link, source: "SOCIAL", image: faviconFor(link), description: techImpact(headline) });
      n++;
    }
  });
  return items;
}

async function hackerNews(): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  const push = (title: string, url: string, score: number, comments: number) => {
    if (!title || !socialGate(title.toLowerCase())) return;
    items.push({ title, url, source: "HACKER NEWS", image: faviconFor("https://news.ycombinator.com"),
      description: `${score} pts · ${comments} comments — the builders are talking.` });
  };
  const [top, algolia] = await Promise.allSettled([
    (async () => {
      const ids = await fetchJson("https://hacker-news.firebaseio.com/v0/topstories.json", 10000);
      if (!Array.isArray(ids)) throw new Error("hn topstories not array");
      return Promise.all(ids.slice(0, 12).map((id: number) =>
        fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, 8000).catch(() => null)));
    })(),
    fetchJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent("agentic AI deployed")}&tags=story`, 10000),
  ]);
  if (top.status === "fulfilled") {
    for (const s of top.value) {
      if (!s || s.type !== "story" || !s.title) continue;
      push(s.title, s.url || `https://news.ycombinator.com/item?id=${s.id}`, s.score || 0, s.descendants || 0);
    }
  } else console.warn("hacker news failed:", errMsg(top.reason));
  if (algolia.status === "fulfilled") {
    for (const h of (algolia.value?.hits ?? []).slice(0, 6))
      push(h.title || "", h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, h.points || 0, h.num_comments || 0);
  } else console.warn("hn algolia failed:", errMsg(algolia.reason));
  return items;
}

async function lobstersNews(): Promise<NewsItem[]> {
  const posts = await fetchJson("https://lobste.rs/hottest.json", 10000);
  if (!Array.isArray(posts)) throw new Error("lobsters not array");
  const items: NewsItem[] = [];
  for (const p of posts.slice(0, 12)) {
    const title = p.title || "", url = p.url || `https://lobste.rs/s/${p.short_id}`;
    if (!title || !socialGate(title.toLowerCase())) continue;
    items.push({ title, url, source: "LOBSTERS", image: faviconFor("https://lobste.rs"),
      description: `${p.score || 0} score · ${p.comment_count ?? 0} comments — curated tech signal.` });
  }
  return items;
}

const YT_CHANNELS = [
  { id: "UCsBjURrPoezykLs9EqgamOA", name: "Fireship" },
  { id: "UCbfYPyITQ-7l4upoX8nvctg", name: "Two Minute Papers" },
  { id: "UCXuqSBlHAE6Xw-yeJA0Tunw", name: "Linus Tech Tips" },
];

async function youtubeNews(): Promise<NewsItem[]> {
  const feeds = await Promise.allSettled(YT_CHANNELS.map((ch) =>
    fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`, 10000)));
  const items: NewsItem[] = [];
  feeds.forEach((f, i) => {
    if (f.status === "rejected") { console.warn("youtube failed:", YT_CHANNELS[i].name, errMsg(f.reason)); return; }
    let n = 0;
    for (const { title, link } of parseFeed(f.value, 8)) {
      if (n >= 2) break;
      if (!socialGate(title.toLowerCase())) continue;
      items.push({ title: `${title} [${YT_CHANNELS[i].name}]`, url: link, source: "YOUTUBE",
        image: faviconFor("https://www.youtube.com"), description: techImpact(title) });
      n++;
    }
  });
  return items;
}

// ============ APIFY SOCIAL SCRAPING (TikTok + X, free tier) ============
// Paid actors (~$0.05-0.10 per call). Hard guarantees:
//  1. the 6h slot is CLAIMED before any paid call (the old code stamped only on non-empty results,
//     so an empty/filtered run re-fired both paid actors on every 5-minute news refresh);
//  2. a config-read failure SKIPS the run (the old code treated every error as "never ran");
//  3. the scrape runs in the background — /news never waits on a 60s actor call.
const APIFY_RATE_LIMIT_MS = 6 * 60 * 60 * 1000;
const APIFY_CALL_TIMEOUT = 60000;
const APIFY_CACHE_MAX_ITEMS = 30;
const APIFY_DOC = "/system_config/apify_last_run";
let _apifyRunning = false;

async function apifyState(): Promise<{ lastRun: number | null; cached: NewsItem[] }> {
  let doc: Doc;
  try { doc = (await firestore(APIFY_DOC, { method: "GET" })) as Doc; }
  catch (e) { if (is404(e)) return { lastRun: null, cached: [] }; throw e; } // only a 404 means "never ran"
  const f = doc.fields ?? {};
  let cached: NewsItem[] = [];
  const raw = str(f.items);
  if (raw) {
    try { const arr = JSON.parse(raw); if (Array.isArray(arr)) cached = arr; }
    catch (e) { recordFailure("apify:cache_parse", e); }
  }
  return { lastRun: tsOf(f.tsNum) ?? tsOf(f.ts), cached };
}

async function apifyWrite(items: NewsItem[]): Promise<void> {
  await firestore(APIFY_DOC, { method: "PATCH", body: { fields: {
    tsNum: nowNum(), ts: nowTs(),
    items: { stringValue: JSON.stringify(items.slice(0, APIFY_CACHE_MAX_ITEMS)) },
  } } });
}

async function apifyRun(actor: string, input: unknown, token: string): Promise<any[]> {
  const r = await http(
    `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items`,
    { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify(input) },
    APIFY_CALL_TIMEOUT);
  if (!r.ok) throw new Error(`Apify ${actor} HTTP ${r.status}`);
  let arr: unknown;
  try { arr = JSON.parse(r.body); } catch { throw new Error(`Apify ${actor} returned non-JSON`); }
  if (!Array.isArray(arr)) throw new Error(`Apify ${actor} non-array response`);
  return arr;
}

async function apifyTikTok(token: string): Promise<NewsItem[]> {
  const arr = await apifyRun("clockworks~tiktok-scraper", {
    hashtags: ["AI", "artificialintelligence", "tech"], resultsPerPage: 10,
    shouldDownloadVideos: false, shouldDownloadCovers: false }, token);
  const items: NewsItem[] = [];
  for (const v of arr.slice(0, 10)) {
    const text = String(v.text || "").trim(), url = v.webVideoUrl || "";
    if (!text || !url || !socialGate(text.toLowerCase())) continue;
    const author = v.authorMeta?.name || v.authorMeta?.nickName || "tiktok";
    items.push({ title: text.slice(0, 140), url, source: "TIKTOK", image: faviconFor("https://www.tiktok.com"),
      description: `@${author} · ${Number(v.diggCount ?? 0).toLocaleString("en-US")} likes — trending on TikTok.` });
  }
  return items;
}

async function apifyX(token: string): Promise<NewsItem[]> {
  const arr = await apifyRun("apidojo~tweet-scraper", {
    searchTerms: ["AI deployed", "built an AI agent"], maxItems: 10, tweetLanguage: "en" }, token);
  const items: NewsItem[] = [];
  for (const t of arr.slice(0, 10)) {
    const text = String(t.text || "").trim(), url = t.url || "";
    if (!text || !url || !socialGate(text.toLowerCase())) continue;
    const author = t.author?.userName || "x";
    items.push({ title: text.slice(0, 140), url, source: "X", image: faviconFor("https://x.com"),
      description: `@${author} · ${Number(t.likeCount ?? 0).toLocaleString("en-US")} likes — trending on X.` });
  }
  return items;
}

async function apifyRefresh(token: string, previous: NewsItem[]): Promise<void> {
  await apifyWrite(previous); // CLAIM the slot first: stamps now, keeps the old items
  const [tt, x] = await Promise.allSettled([apifyTikTok(token), apifyX(token)]);
  const fresh: NewsItem[] = [];
  for (const [label, r] of [["tiktok", tt], ["x", x]] as const) {
    if (r.status === "fulfilled") fresh.push(...r.value);
    else recordFailure(`apify:${label}`, r.reason);
  }
  if (fresh.length) await apifyWrite(fresh);
}

async function apifySocialNews(): Promise<NewsItem[]> {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return []; // graceful fallback: no token, no calls
  const { lastRun, cached } = await apifyState(); // throws on non-404 → run skipped, failure recorded upstream
  const due = lastRun === null || Date.now() - lastRun >= APIFY_RATE_LIMIT_MS;
  if (due && !_apifyRunning) {
    _apifyRunning = true;
    apifyRefresh(token, cached)
      .catch((e: unknown) => recordFailure("apify:refresh", e))
      .finally(() => { _apifyRunning = false; });
  }
  return cached;
}

async function socialNews(): Promise<NewsItem[]> {
  const sources = { apify: apifySocialNews, google: googleNewsSocial, hn: hackerNews, lobsters: lobstersNews, youtube: youtubeNews };
  const names = Object.keys(sources) as Array<keyof typeof sources>;
  const results = await Promise.allSettled(names.map((n) => sources[n]()));
  const ordered: NewsItem[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") ordered.push(...r.value);
    else if (names[i] === "apify") recordFailure("news:apify", r.reason);
    else console.warn(`social source ${names[i]} failed:`, errMsg(r.reason));
  });
  return dedupeItems(ordered); // deterministic: priority order, one pass, no shared mutable state
}

const NEWS_SECTIONS = ["crypto", "markets", "macro", "social"] as const;

async function buildNews(): Promise<NewsItem[]> {
  const results = await Promise.allSettled([cryptoNews(), marketsNews(), macroNews(), socialNews()]);
  const [crypto, markets, macro, social] = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    recordFailure(`news:${NEWS_SECTIONS[i]}`, r.reason);
    return [] as NewsItem[];
  });
  return [...macro.slice(0, 6), ...social.slice(0, 6), ...crypto.slice(0, 3), ...markets.slice(0, 3)].slice(0, 16);
}

// Stale-while-error: an upstream outage serves the last good feed and retries in 30s.
let newsCache: { at: number; items: NewsItem[] } | null = null;
let newsInflight: Promise<NewsItem[]> | null = null;
const NEWS_TTL = 5 * 60 * 1000;
const NEWS_RETRY_MS = 30 * 1000;

async function getNews(): Promise<NewsItem[]> {
  const now = Date.now();
  if (newsCache && now - newsCache.at < NEWS_TTL) return newsCache.items;
  newsInflight ??= buildNews()
    .then((items) => {
      if (items.length) { newsCache = { at: Date.now(), items }; return items; }
      if (newsCache) { newsCache = { at: Date.now() - NEWS_TTL + NEWS_RETRY_MS, items: newsCache.items }; return newsCache.items; }
      return items;
    })
    .catch((e: unknown) => {
      recordFailure("news:build", e);
      if (newsCache) return newsCache.items;
      throw e;
    })
    .finally(() => { newsInflight = null; });
  return newsInflight;
}

// ============ PINECONE (control-plane host resolution, dimension-safe) ============
const PINECONE_INDEX = "static-pattern-refinery";
let _pcHost: { host: string; dimension: number } | null = null;

function pineconeHeaders(): Record<string, string> {
  const k = process.env.PINECONE_API_KEY;
  if (!k) throw new UserError("PINECONE_API_KEY not configured");
  return { "Api-Key": k, "Content-Type": "application/json" };
}
async function pineconeIndex(): Promise<{ host: string; dimension: number }> {
  if (_pcHost) return _pcHost;
  const r = await http(`https://api.pinecone.io/indexes/${PINECONE_INDEX}`,
    { headers: pineconeHeaders() }, EXT_TIMEOUT);
  if (!r.ok) throw new Error(`Pinecone describe ${r.status}`);
  const d = parseJson(r.body);
  if (!d.host || !d.dimension) throw new Error("Pinecone index describe returned no host/dimension");
  _pcHost = { host: d.host, dimension: Number(d.dimension) };
  return _pcHost;
}

// ============ EXPRESS ============
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" })); // voice payloads exceed 64kb — 413 was a phantom

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});
app.get("/health", (_req, res) => { res.json({ ok: true }); });

app.get("/news", async (_req, res) => {
  try {
    const items = await getNews();
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: errMsg(e) });
  }
});

// Constant-time secret check (digest compare: equal length, no early exit).
const secretDigest = createHash("sha256").update(MCP_SECRET).digest();
const secretOk = (candidate: string): boolean =>
  timingSafeEqual(createHash("sha256").update(candidate).digest(), secretDigest);

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

async function handleMcp(req: Request, res: Response): Promise<void> {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    server.close().catch((e: unknown) => console.error("mcp close failed:", errMsg(e)));
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    recordFailure("mcp_route", e);
    if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, "Internal server error"));
  }
}

app.all(/^\/mcp\/(.+?)\/?$/, async (req: Request, res: Response) => {
  if (!secretOk(String(req.params[0]))) { res.status(404).json({ error: "not found" }); return; }
  if (req.method !== "POST") { res.status(405).json(jsonRpcError(-32000, "Method not allowed.")); return; }
  await handleMcp(req, res);
});

// Body-parser failures (bad JSON, >2mb) answered as JSON-RPC, not an HTML stack page.
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) { next(err); return; }
  const tooBig = err?.type === "entity.too.large";
  res.status(tooBig ? 413 : 400).json(jsonRpcError(tooBig ? -32600 : -32700, tooBig ? "payload too large" : "parse error"));
});

process.on("unhandledRejection", (reason) => recordFailure("unhandledRejection", reason));
process.on("uncaughtException", (e) => { recordFailure("uncaughtException", e); setTimeout(() => process.exit(1), 1500).unref(); });

const port = Number(process.env.PORT) || 3000;
const httpServer = app.listen(port, () => console.log(`highway-chat-mcp-server listening on :${port}`));

// Render sends SIGTERM on deploy: stop accepting, let in-flight calls finish, then exit.
process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
});
