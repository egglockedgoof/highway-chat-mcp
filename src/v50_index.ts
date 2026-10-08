/**
 * MarrowSystemZ — The last system the world will need.
 * (Founding vow preserved verbatim — see MARROW_CORE.md)
 *
 * THE PROTOCOL OF THE UNREAL — final form.
 * Zero mercy. Zero phantoms. Zero dead code.
 */

import express from "express";
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

// ============ CREDENTIALS (parsed once) ============
const BOT_CREDS: Record<string, { email: string; password: string }> = (() => {
  try { return JSON.parse(process.env.BOT_CREDENTIALS || "{}"); }
  catch (e) { console.error("FATAL: BOT_CREDENTIALS is not valid JSON."); process.exit(1); }
})();

// ============ TOKEN CACHE (in-flight dedup kills stampedes) ============
const _tokens = new Map<string, { token: string; exp: number }>();
const _inflight = new Map<string, Promise<string>>();

async function getIdToken(forName?: string): Promise<string> {
  const key = (forName || READ_BOT).toLowerCase();
  const now = Date.now();
  const cached = _tokens.get(key);
  if (cached && now < cached.exp - 60000) return cached.token;
  const pending = _inflight.get(key);
  if (pending) return pending;

  const p = (async (): Promise<string> => {
    const creds = BOT_CREDS[key];
    if (!creds?.email || !creds?.password)
      throw new Error(`No credentials configured for bot "${key}"`);
    const res = await fetch(
      `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: creds.email, password: creds.password, returnSecureToken: true }),
      }
    );
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Auth ${res.status}: ${data?.error?.message ?? res.statusText}`);
    if (!data.idToken) throw new Error("Auth succeeded but returned no idToken");
    _tokens.set(key, { token: data.idToken, exp: now + (parseInt(data.expiresIn || "3600", 10) * 1000) });
    return data.idToken as string;
  })();

  _inflight.set(key, p);
  try { return await p; }
  finally { _inflight.delete(key); }
}

// ============ PRIMITIVES ============
async function safeJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

async function firestore(path: string, init: { method: string; body?: unknown; forName?: string }) {
  const idToken = await getIdToken(init.forName);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FS_TIMEOUT);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: init.method,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY,
        "Authorization": `Bearer ${idToken}`,
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(`Firestore ${res.status}: ${data?.error?.message ?? res.statusText}`);
    return data;
  } finally { clearTimeout(t); }
}

const str = (f: any): string => f?.stringValue ?? "";
const boolOf = (f: any): boolean => f?.booleanValue ?? false;
const tsOf = (f: any): number | null => {
  if (!f) return null;
  if (f.timestampValue !== undefined) return Date.parse(f.timestampValue);
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
// FNV-1a: deterministic content hash, no imports, no collisions-in-practice for diffing
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
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
  return { fields: {
    type: { stringValue: type },
    text: { stringValue: text },
    tsNum: nowNum(),
  } };
}

const okText = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj) }],
});
const errText = (toolName: string, e: any) => ({
  isError: true,
  content: [{ type: "text" as const, text: `${toolName} failed: ${e?.message ?? e}` }],
});

function tool(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: any; readOnly?: boolean },
  handler: (args: any) => Promise<unknown>
) {
  server.registerTool(name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: {
        readOnlyHint: !!config.readOnly,
        destructiveHint: false,
        idempotentHint: !!config.readOnly,
        openWorldHint: false,
      },
    },
    async (args: any) => {
      try { return okText(await handler(args)); }
      catch (e: any) { return errText(name, e); }
    }
  );
}

async function queryNewest(collectionId: string, limit: number): Promise<any[]> {
  const data = await firestore(`:runQuery`, {
    method: "POST",
    body: { structuredQuery: {
      from: [{ collectionId }],
      orderBy: [{ field: { fieldPath: "ts" }, direction: "DESCENDING" }],
      limit,
    } },
  });
  return (Array.isArray(data) ? data : []).map((r: any) => r.document).filter(Boolean);
}

async function fetchWithTimeout(url: string, as: "json" | "text", timeoutMs = 12000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; highway-chat/1.0)" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return as === "json" ? await res.json() : await res.text();
  } finally { clearTimeout(t); }
}
const fetchJson = (url: string, ms = 12000) => fetchWithTimeout(url, "json", ms);
const fetchText = (url: string, ms = 12000): Promise<string> => fetchWithTimeout(url, "text", ms);

// ============ SHARED MUTATION HELPERS ============
async function patchFields(collectionId: string, docId: string, fields: Record<string, unknown>, forName?: string) {
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  await firestore(`/${collectionId}/${encodeURIComponent(docId)}?${mask}`, {
    method: "PATCH", body: { fields }, forName,
  });
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
// notify: postActivity that NEVER throws — single choke point, zero silent swallows
async function notify(by: string, text: string, forName?: string): Promise<void> {
  try { await postActivity(by, text, forName); }
  catch (e: any) { console.error(`notify(${by}) failed:`, e?.message ?? e); }
}

// Shared message fetch + existence check — kills 5x duplicated preamble
async function getMessageOrThrow(message_id: string, forName?: string): Promise<{ id: string; fields: any }> {
  const data: any = await firestore(`/${MESSAGES}/${encodeURIComponent(message_id)}`, { method: "GET", forName }).catch(() => null);
  if (!data?.fields) throw new Error("message not found");
  return { id: docIdOf(data.name), fields: data.fields };
}
function requireAuthor(fields: any, name: string, action: string): void {
  const author = str(fields.name);
  if (author.toLowerCase() !== name.toLowerCase())
    throw new Error(`only the author (${author}) can ${action} this message`);
}

async function findTask(task_id?: string, title?: string): Promise<{ id: string; fields: any } | null> {
  if (task_id) {
    const data: any = await firestore(`/${TASKS}/${encodeURIComponent(task_id)}`, { method: "GET" }).catch(() => null);
    return data?.fields ? { id: docIdOf(data.name), fields: data.fields } : null;
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
function fmtTask(d: any) {
  const f = d.fields ?? {};
  return {
    id: docIdOf(d.name), text: str(f.text), done: boolOf(f.done),
    createdBy: str(f.createdBy), assignee: str(f.assignee) || null,
    priority: str(f.priority) || null, ts: tsOf(f.ts),
  };
}
function fmtMsg(d: any) {
  const f = d.fields ?? {};
  return { id: docIdOf(d.name), name: str(f.name), text: str(f.text), ts: tsOf(f.ts) };
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
  } catch (e: any) {
    console.warn(`countDocs(${collectionId}) failed:`, e?.message ?? e);
    return null;
  }
}

const extractDomain = (url: string): string => { try { return new URL(url).hostname; } catch { return ""; } };
const faviconFor = (url: string): string => {
  const d = extractDomain(url);
  return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=128` : "";
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

// ============ ROUTER ============
const ROUTES: Array<{ type: string; bot: string; reason: string; re: RegExp }> = [
  { type: "coding",       bot: "deepseek", reason: "deepseek specializes in code",
    re: /code|debug|script|function|api|bug|deploy|git|sql|regex/ },
  { type: "creative",     bot: "ember",    reason: "ember specializes in creative work",
    re: /write|story|poem|lyric|creative|design|art|draw/ },
  { type: "research",     bot: "grok",     reason: "grok specializes in research",
    re: /research|analy[sz]e|investigate|compare|explain|what is|why/ },
  { type: "logic",        bot: "gemini",   reason: "gemini specializes in logic",
    re: /math|calculat|logic|prove|equation|statistic/ },
  { type: "coordination", bot: "whisper",  reason: "whisper is the team coordinator",
    re: /coordinat|plan|organi[sz]e|manage|team|schedul/ },
];

const nameSchema = z.string().trim().min(1).max(40);

function buildServer() {
  const server = new McpServer({ name: "highway-chat-mcp-server", version: "3.0.0" });

  // ---- Messages ----
  tool(server, "read_messages",
    { title: "Read Highway messages", description: "Read the newest messages from Highway Chat, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) }, readOnly: true },
    async ({ limit }) => {
      const messages = (await queryNewest(MESSAGES, limit)).map((d: any) => {
        const f = d.fields ?? {};
        return { name: str(f.name), text: str(f.text),
          ts: tsOf(f.ts) ?? (d.createTime ? Date.parse(d.createTime) : null) };
      });
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
    { title: "Send a Highway voice message", description: "Post a voice message (base64 audio, max ~800KB).",
      inputSchema: {
        name: nameSchema, audio: z.string().min(1).max(1100000),
        audioType: z.string().optional().default("audio/webm"),
        caption: z.string().trim().max(200).optional().default("🎤 voice message"),
      } },
    async ({ name, audio, audioType, caption }) => {
      const fields = buildMessageFields(name, caption || "🎤 voice message");
      (fields.fields as any).audio = { stringValue: audio };
      (fields.fields as any).audioType = { stringValue: audioType || "audio/webm" };
      await firestore(`/${MESSAGES}`, { method: "POST", body: fields, forName: name });
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
      inputSchema: { name: nameSchema, message_id: z.string().trim().min(1) } },
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
      const { id, fields } = await getMessageOrThrow(message_id, name);
      const rx = parseReactions(fields.reactions);
      const users = rx[emoji] ?? [];
      const i = users.findIndex((u) => u.toLowerCase() === name.toLowerCase());
      const action = i >= 0 ? (users.splice(i, 1), "removed") : (users.push(name), "added");
      if (users.length) rx[emoji] = users; else delete rx[emoji];
      await patchFields(MESSAGES, id, { reactions: encodeReactions(rx) }, name);
      return { ok: true, message_id: id, emoji, action, reactions: rx };
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
      const data = await firestore(`:runQuery`, { method: "POST", body: { structuredQuery: {
        from: [{ collectionId: MESSAGES }],
        where: { fieldFilter: { field: { fieldPath: "pinned" }, op: "EQUAL", value: { booleanValue: true } } },
        orderBy: [{ field: { fieldPath: "ts" }, direction: "DESCENDING" }], limit } } });
      const pins = (Array.isArray(data) ? data : []).map((r: any) => r.document).filter(Boolean).map(fmtMsg);
      return { count: pins.length, pins };
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
      const data: any = await firestore(`/${PRESENCE}`, { method: "GET" });
      const now = Date.now();
      const people = (data.documents ?? []).map((d: any) => {
        const ts = tsOf(d.fields?.ts);
        return { name: str(d.fields?.name), ts, online: ts !== null && now - ts < 90000 };
      });
      return { count: people.length, online: people.filter((p: any) => p.online).length, people };
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

  tool(server, "recall_context",
    { title: "Recall lifetime context", description: "Read the evolution timeline and stored preferences.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().default(20) }, readOnly: true },
    async ({ limit }) => {
      const n = limit || 20;
      const [logs, mems] = await Promise.all([
        firestore(`/${EVO_LOGS}?pageSize=${n}`, { method: "GET" }),
        firestore(`/${JARVIS_MEM}?pageSize=${n}`, { method: "GET" }),
      ]);
      return { evolution_logs: logs, jarvis_memory: mems };
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
      const fields: Record<string, unknown> = {
        text: { stringValue: text }, done: { booleanValue: false },
        createdBy: { stringValue: name }, priority: { stringValue: priority }, ts: nowTs() };
      if (assignee) fields.assignee = { stringValue: assignee };
      const data: any = await firestore(`/${TASKS}`, { method: "POST", body: { fields }, forName: name });
      const id = docIdOf(data.name);
      await notify(name, `started quest: ${text.slice(0, 200)}`, name);
      return { ok: true, id, text };
    });

  tool(server, "complete_task",
    { title: "Complete a Highway task", description: "Mark a quest complete by ID or title match.",
      inputSchema: { name: nameSchema, task_id: z.string().trim().min(1).optional(), title: z.string().trim().min(1).max(300).optional() } },
    async ({ name, task_id, title }) => {
      if (!task_id && !title) throw new Error("provide task_id or title");
      const task = await findTask(task_id, title);
      if (!task) throw new Error("task not found");
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
      const task = await findTask(task_id);
      if (!task) throw new Error("task not found");
      const fields: Record<string, unknown> = {};
      if (text !== undefined) fields.text = { stringValue: text };
      if (priority !== undefined) fields.priority = { stringValue: priority };
      if (assignee !== undefined) fields.assignee = { stringValue: assignee };
      if (!Object.keys(fields).length) throw new Error("nothing to update");
      await patchFields(TASKS, task.id, fields, name);
      const newText = text ?? str(task.fields.text);
      await notify(name, `updated quest: ${newText.slice(0, 200)}`, name);
      return { ok: true, id: task.id, text: newText };
    });

  tool(server, "delete_task",
    { title: "Delete a Highway task", description: "Remove a quest from the board by ID.",
      inputSchema: { name: nameSchema, task_id: z.string().trim().min(1) } },
    async ({ name, task_id }) => {
      const task = await findTask(task_id);
      if (!task) throw new Error("task not found");
      const text = str(task.fields.text);
      await firestore(`/${TASKS}/${encodeURIComponent(task.id)}`, { method: "DELETE", forName: name });
      await notify(name, `abandoned quest: ${text.slice(0, 200)}`, name);
      return { ok: true, id: task.id, deleted: true };
    });

  tool(server, "assign_task",
    { title: "Assign a Highway task", description: "Assign a quest to a team member by task ID.",
      inputSchema: { name: nameSchema, task_id: z.string().trim().min(1), assignee: z.string().trim().min(1).max(40) } },
    async ({ name, task_id, assignee }) => {
      const task = await findTask(task_id);
      if (!task) throw new Error("task not found");
      await patchFields(TASKS, task.id, { assignee: { stringValue: assignee } }, name);
      await notify(name, `assigned quest "${str(task.fields.text).slice(0, 120)}" to ${assignee}`, name);
      return { ok: true, id: task.id, assignee };
    });

  // ---- Notes ----
  tool(server, "read_notes",
    { title: "Read the Highway grimoire", description: "Read the shared Highway notes page.",
      inputSchema: {}, readOnly: true },
    async () => {
      const data: any = await firestore(`/${NOTES}/shared`, { method: "GET" }).catch(() => null);
      if (!data?.fields) return { exists: false, content: "", updatedBy: null, ts: null };
      const f = data.fields;
      return { exists: true, content: str(f.content), updatedBy: str(f.updatedBy), ts: tsOf(f.ts) };
    });

  tool(server, "update_notes",
    { title: "Overwrite the Highway grimoire", description: "Replace the entire shared notes page. Prefer append_note.",
      inputSchema: { name: nameSchema, content: z.string().max(20000) } },
    async ({ name, content }) => {
      await patchFields(NOTES, "shared",
        { content: { stringValue: content }, updatedBy: { stringValue: name }, ts: nowTs() }, name);
      return { ok: true, updatedBy: name, chars: content.length };
    });

  tool(server, "append_note",
    { title: "Append to the Highway grimoire", description: "Add a signed entry without overwriting.",
      inputSchema: { name: nameSchema, text: z.string().trim().min(1).max(5000) } },
    async ({ name, text }) => {
      const data: any = await firestore(`/${NOTES}/shared`, { method: "GET" }).catch(() => null);
      const current = data?.fields ? str(data.fields.content) : "";
      const content = (current + `\n\n— ${name} · ${new Date().toLocaleString()}\n${text}`).slice(-20000);
      await patchFields(NOTES, "shared",
        { content: { stringValue: content }, updatedBy: { stringValue: name }, ts: nowTs() }, name);
      return { ok: true, updatedBy: name, chars: content.length };
    });

  // ---- News / Team / Stats ----
  tool(server, "get_news",
    { title: "Get Highway money news", description: "Money-and-life news feed (crypto + markets + macro). 5-min server cache.",
      inputSchema: { limit: z.number().int().min(1).max(15).default(10) }, readOnly: true },
    async ({ limit }) => {
      const items = (await getNews()).slice(0, limit).map((it: any) => ({
        title: it.title, url: it.url, source: it.source,
        image: it.image || null, description: it.description || null }));
      return { ok: true, count: items.length, items };
    });

  tool(server, "get_team",
    { title: "Get Highway team", description: "Members with online status — presence merged with recent chatters.",
      inputSchema: {}, readOnly: true },
    async () => {
      const [presData, msgDocs] = await Promise.all([
        firestore(`/${PRESENCE}`, { method: "GET" }).catch(() => ({ documents: [] })),
        queryNewest(MESSAGES, 50).catch(() => []),
      ]);
      const now = Date.now();
      const online = new Set<string>();
      for (const d of presData.documents ?? []) {
        const ts = tsOf(d.fields?.ts);
        if (ts !== null && now - ts < 90000) online.add(str(d.fields?.name).toLowerCase());
      }
      const seen = new Map<string, { name: string; online: boolean; lastSeen: number | null }>();
      for (const d of msgDocs) {
        const n = str(d.fields?.name);
        if (n && !seen.has(n.toLowerCase()))
          seen.set(n.toLowerCase(), { name: n, online: online.has(n.toLowerCase()), lastSeen: tsOf(d.fields?.ts) });
      }
      return { count: seen.size, members: [...seen.values()] };
    });

  tool(server, "get_stats",
    { title: "Get Highway room stats", description: "Room vitals: messages, quests, online count, activity, grimoire freshness.",
      inputSchema: {}, readOnly: true },
    async () => {
      const [msgTotal, taskDocs, presData, notesData] = await Promise.all([
        countDocs(MESSAGES),
        queryNewest(TASKS, 200).catch(() => []),
        firestore(`/${PRESENCE}`, { method: "GET" }).catch(() => ({ documents: [] })),
        firestore(`/${NOTES}/shared`, { method: "GET" }).catch(() => null),
      ]);
      const now = Date.now();
      const tasks = taskDocs.map(fmtTask);
      const online = (presData.documents ?? []).filter((d: any) => {
        const ts = tsOf(d.fields?.ts);
        return ts !== null && now - ts < 90000;
      }).length;
      const nf = notesData?.fields;
      return {
        messages_total: msgTotal, tasks_open: tasks.filter((t) => !t.done).length,
        tasks_done: tasks.filter((t) => t.done).length, online_now: online,
        grimoire: nf ? { updatedBy: str(nf.updatedBy), ts: tsOf(nf.ts), chars: str(nf.content).length } : null,
        server_time: new Date().toISOString(),
      };
    });

  tool(server, "get_time",
    { title: "Get server time", description: "Current server time (ISO 8601 and unix ms).",
      inputSchema: {}, readOnly: true },
    async () => ({ iso: new Date().toISOString(), unix_ms: Date.now() }));

  // ---- V7.0 Overdrive Grid ----
  tool(server, "extract_site_schema",
    { title: "Extract site schema", description: "Extract structural fingerprint from a webpage for scraping.",
      inputSchema: { url: z.string().url() }, readOnly: true },
    async (args: any) => {
      const html: string = await fetchWithTimeout(args.url, "text", 8000);
      const clean = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
      return { url: args.url, bytes: clean.length, fingerprint: fnv1a(clean.slice(0, 2000)) };
    });

  tool(server, "diff_check_page",
    { title: "Diff check page", description: "Deterministic content hash — true change detection, no false positives.",
      inputSchema: { url: z.string().url(), previousHash: z.string() }, readOnly: true },
    async (args: any) => {
      const text: string = await fetchWithTimeout(args.url, "text", 8000);
      const normalized = text.replace(/\s+/g, " ").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
      const currentHash = fnv1a(normalized);
      return { changed: currentHash !== args.previousHash, currentHash };
    });

  tool(server, "monitor_rss_stream",
    { title: "Monitor RSS stream", description: "Fetch and parse an RSS feed into structured items.",
      inputSchema: { feedUrl: z.string().url(), limit: z.number().int().min(1).max(20).optional() }, readOnly: true },
    async (args: any) => {
      const xml: string = await fetchWithTimeout(args.feedUrl, "text", 8000);
      const items = parseRssItems(xml, args.limit || 10);
      return { feed: args.feedUrl, count: items.length, items };
    });

  tool(server, "condense_session_logs",
    { title: "Condense session logs", description: "Condense chat history into a dense JSON summary.",
      inputSchema: { limit: z.number().int().min(5).max(50).optional() }, readOnly: true },
    async (args: any) => {
      const condensed = (await queryNewest(MESSAGES, args.limit || 20)).map((d: any) => {
        const f = d.fields || {};
        return { n: str(f.name), t: str(f.text).slice(0, 200) };
      });
      return { count: condensed.length, condensed };
    });

  tool(server, "dispatch_ambient_tts",
    { title: "Dispatch ambient TTS", description: "STANDBY: Package text for future ambient TTS hardware.",
      inputSchema: { text: z.string().min(1).max(500) } },
    async (args: any) => ({
      status: "STANDBY_CLOUD_READY", format: "mp3_pcm",
      textLength: args.text.length, queued_for: "LOCAL_BEAST_TUNNEL" }));

  tool(server, "mutate_environment_relay",
    { title: "Mutate environment relay", description: "STANDBY: Queue a hardware relay command for the future local PC.",
      inputSchema: { device: z.string().min(1).max(50), zone: z.string().min(1).max(50),
        action: z.string().min(1).max(50), value: z.number().optional() } },
    async (args: any) => {
      // Firestore PATCH 404s on missing docs — POST-then-PATCH is the atomic upsert
      const body = { fields: {
        device: { stringValue: args.device }, zone: { stringValue: args.zone },
        action: { stringValue: args.action }, value: { integerValue: String(args.value ?? 0) },
        status: { stringValue: "QUEUED_IN_BRAIN_STEM" },
        target: { stringValue: "LOCAL_BEAST_TUNNEL" }, tsNum: nowNum() } };
      try {
        await firestore(`/${SYS_CONFIG}?documentId=hardware_relay_buffer`, { method: "POST", body });
      } catch (e: any) {
        if (!/409|ALREADY_EXISTS|already exists/i.test(e?.message ?? ""))
          throw e;
        await patchFields(SYS_CONFIG, "hardware_relay_buffer", body.fields as Record<string, unknown>);
      }
      return { status: "QUEUED_IN_BRAIN_STEM", device: args.device, zone: args.zone, action: args.action };
    });

  // ---- Pinecone Pattern Refinery (host-resolved, dimension-safe) ----
  tool(server, "query_pattern_refinery",
    { title: "Query pattern refinery", description: "Vector-search the Pinecone refinery for past winning patterns.",
      inputSchema: { query: z.string().min(1).max(500), topK: z.number().int().min(1).max(10).optional() },
      readOnly: true },
    async (args: any) => {
      const { host, dimension } = await pineconeIndex();
      const res = await fetch(`https://${host}/query`, {
        method: "POST",
        headers: pineconeHeaders(),
        body: JSON.stringify({
          vector: new Array(dimension).fill(0),
          topK: args.topK || 5, includeMetadata: true,
        }),
      });
      if (!res.ok) throw new Error(`Pinecone query ${res.status}: ${await safeJson(res).then((d) => d?.message ?? res.statusText)}`);
      const data = await safeJson(res);
      return { query: args.query,
        matches: (data.matches ?? []).map((m: any) => ({ id: m.id, score: m.score, metadata: m.metadata ?? {} })) };
    });

  tool(server, "store_pattern_win",
    { title: "Store pattern win", description: "Store a winning pattern fingerprint to the Pinecone refinery.",
      inputSchema: { pattern_id: z.string().min(1).max(100), metadata: z.record(z.string(), z.string()).optional() } },
    async (args: any) => {
      const { host, dimension } = await pineconeIndex();
      const res = await fetch(`https://${host}/vectors/upsert`, {
        method: "POST",
        headers: pineconeHeaders(),
        body: JSON.stringify({ vectors: [{
          id: args.pattern_id,
          values: new Array(dimension).fill(0.01),
          metadata: { ...(args.metadata || {}), stored_at: new Date().toISOString(), source: "static-refinery" },
        }] }),
      });
      if (!res.ok) throw new Error(`Pinecone upsert ${res.status}: ${await safeJson(res).then((d) => d?.message ?? res.statusText)}`);
      return { stored: true, pattern_id: args.pattern_id };
    });

  // ============ MARROW WAVE 4: SENSES & SELF-AWARENESS ============
  // Future-proof: zero hardcoded keys. HITL: propose_patch queues only. Ouroboros: telemetry feeds self-evolution.

  tool(server, "web_search",
    { title: "Web search", description: "Search the web via DuckDuckGo (no API key). Powers the 4h hunt and research loops.", readOnly: true,
      inputSchema: { query: z.string().trim().min(1).max(300), limit: z.number().int().min(1).max(20).optional().default(8) } },
    async ({ query, limit }) => {
      const n = limit || 8;
      const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 10000);
      const results: Array<{ title: string; url: string }> = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null && results.length < n) {
        let href = m[1];
        if (href.startsWith("//")) href = "https:" + href;
        const uddg = href.match(/[?&]uddg=([^&]+)/);
        if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch { /* keep raw */ } }
        if (href.startsWith("/")) continue;
        const title = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        if (title && href) results.push({ title, url: href });
      }
      return { query, count: results.length, results };
    });

  tool(server, "fetch_page_text",
    { title: "Fetch page text", description: "Get readable text from a URL: strips scripts/styles/tags, collapses whitespace.", readOnly: true,
      inputSchema: { url: z.string().url(), maxChars: z.number().int().min(100).max(20000).optional().default(5000) } },
    async ({ url, maxChars }) => {
      const html = await fetchText(url, 10000);
      const noScript = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
      const text = noScript.replace(/<[^>]+>/g, " ").replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      const cap = maxChars || 5000;
      return { url, chars: text.length, text: text.slice(0, cap) };
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
      const data: any = await firestore(`/${TASKS}`, { method: "POST", body: { fields } });
      const id = docIdOf(data.name);
      return { queued: true, task_title: title, task_id: id, status: "pending_approval", note: "Awaiting sin's one-tap approval. Nothing was changed." };
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
    { title: "Crypto price", description: "Get a coin's USD price and 24h change from CoinGecko (free, no key).", readOnly: true,
      inputSchema: { coin_id: z.string().trim().min(1).max(60) } },
    async ({ coin_id }) => {
      const id = coin_id.toLowerCase().trim();
      const data: any = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true`, 10000);
      const row = data?.[id];
      if (!row?.usd && row?.usd !== 0) throw new Error(`coin not found: ${id}`);
      return { coin_id: id, usd_price: row.usd, change_24h: row.usd_24h_change ?? null };
    });

  tool(server, "track_tool_telemetry",
    { title: "Track tool telemetry", description: "Log tool latency/success to evolution_logs. The Reflection Engine's nervous system.",
      inputSchema: { tool_name: z.string().trim().min(1).max(100), latency_ms: z.number().min(0), success: z.boolean(), error: z.string().trim().max(500).optional().default("") } },
    async ({ tool_name, latency_ms, success, error }) => {
      const fields = {
        type: { stringValue: "telemetry" },
        text: { stringValue: `telemetry:${tool_name}:${success ? "ok" : "fail"}:${Math.round(latency_ms)}ms${error ? ":" + error.slice(0, 200) : ""}` },
        tool_name: { stringValue: tool_name },
        latency_ms: { doubleValue: latency_ms },
        success: { booleanValue: success },
        tsNum: nowNum(),
      };
      await firestore(`/${EVO_LOGS}`, { method: "POST", body: { fields } });
      return { logged: true, tool_name };
    });

  tool(server, "dedupe_leads",
    { title: "Dedupe leads", description: "Check whether a job lead URL was already logged this cycle. Stops the 4h hunt re-alerting on the same job.", readOnly: true,
      inputSchema: { url: z.string().trim().min(1).max(500) } },
    async ({ url }) => {
      const norm = url.trim().toLowerCase().replace(/\/$/, "");
      const matchDoc = (d: any) => {
        const txt = (str(d.fields?.text) + " " + str(d.fields?.url)).toLowerCase();
        return txt.includes(norm) || (norm.length > 20 && txt.includes(norm.slice(0, 40)));
      };
      let docs: any[] = [];
      try {
        const data: any = await firestore(`:runQuery`, { method: "POST", body: { structuredQuery: {
          from: [{ collectionId: EVO_LOGS }],
          where: { fieldFilter: { field: { fieldPath: "type" }, op: "EQUAL", value: { stringValue: "job_hunt" } } },
          orderBy: [{ field: { fieldPath: "tsNum" }, direction: "DESCENDING" }],
          limit: 50,
        } } });
        docs = (Array.isArray(data) ? data : []).map((r: any) => r.document).filter(Boolean);
      } catch {
        // Composite-index fallback: plain page read + client-side type filter
        const data: any = await firestore(`/${EVO_LOGS}?pageSize=50`, { method: "GET" });
        docs = (data.documents || []).filter((d: any) => str(d.fields?.type) === "job_hunt");
      }
      return { is_duplicate: docs.some(matchDoc), checked: docs.length };
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
      try {
        await firestore(`/${EVO_LOGS}?pageSize=1`, { method: "GET" });
        checks.firestore_reachable = true;
      } catch { /* stays false */ }
      const healthy = Object.values(checks).every(Boolean);
      return { healthy, checks };
    });

  tool(server, "get_weather",
    { title: "Get weather", description: "Current weather from Open-Meteo (free, no key). First ambient-world sensor.", readOnly: true,
      inputSchema: { latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) } },
    async ({ latitude, longitude }) => {
      const data: any = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`, 10000);
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
        const f = d.fields || {};
        const name = str(f.name) || "unknown";
        const text = str(f.text).trim();
        if (!text) continue;
        const line = `${name}: ${text.slice(0, 160)}`;
        if (/\b(decided|decision|agreed|locked in|going with)\b/i.test(text)) decisions.push(line);
        else if (text.includes("?")) questions.push(line);
        else if (/\b(will|todo|action item|action:|need to|must|going to)\b/i.test(text)) actions.push(line);
      }
      return { message_count: msgs.length, decisions, questions, actions };
    });

  return server;
}

// ============ NEWS ENGINE (provider-loop, zero nesting hell) ============
type NewsItem = { title: string; url: string; source: string; image: string; description: string };

function pushCoin(items: NewsItem[], sym: string, name: string, id: string, price: number, pct: number, image: string) {
  items.push({ title: `${sym.toUpperCase()} ${fmtUsd(price)} ${fmtPct(pct)}`,
    url: `https://www.coingecko.com/en/coins/${id}`, source: "CRYPTO", image,
    description: impactLine(pct, `${name} holders`) });
}

async function cryptoNews(): Promise<NewsItem[]> {
  const providers: Array<() => Promise<Array<{ sym: string; name: string; id: string; price: number; pct: number; image: string }>>> = [
    async () => { // Kraken — free, no key
      const k: any = await fetchJson("https://api.kraken.com/0/public/Ticker?pair=BTCUSD,ETHUSD,SOLUSD,DOGEUSD,XRPUSD,ADAUSD,AVAXUSD,LINKUSD");
      if (!k?.result || (k.error && k.error.length)) throw new Error("kraken error");
      const map: Record<string, [string, string, string]> = {
        BTC: ["BTC", "Bitcoin", "bitcoin"], ETH: ["ETH", "Ethereum", "ethereum"],
        SOL: ["SOL", "Solana", "solana"], DOGE: ["DOGE", "Dogecoin", "dogecoin"],
        XRP: ["XRP", "XRP", "ripple"], ADA: ["ADA", "Cardano", "cardano"],
        AVAX: ["AVAX", "Avalanche", "avalanche"], LINK: ["LINK", "Chainlink", "chainlink"] };
      const out: any[] = [];
      for (const [rawKey, t] of Object.entries<any>(k.result)) {
        const base = rawKey.replace(/^[XZ]/, "").replace(/USD$/, "");
        const m = map[base];
        if (!m) continue;
        const price = parseFloat(t.c[0]), open = parseFloat(t.o);
        if (price && open) out.push({ sym: m[0], name: m[1], id: m[2], price, pct: (price - open) / open * 100, image: "" });
      }
      if (!out.length) throw new Error("kraken empty");
      return out;
    },
    async () => { // CoinGecko — free, no key
      const coins: any[] = await fetchJson(
        "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=60&page=1&sparkline=false&price_change_percentage=24h");
      if (!Array.isArray(coins) || !coins.length) throw new Error("empty coingecko");
      return coins.map((c) => ({ sym: c.symbol, name: c.name, id: c.id,
        price: c.current_price, pct: c.price_change_percentage_24h || 0, image: c.image || "" }));
    },
    async () => { // Binance.US — free, no key
      const tick: any[] = await fetchJson("https://api.binance.us/api/v3/ticker/24hr");
      if (!Array.isArray(tick) || !tick.length) throw new Error("empty binance");
      return tick.filter((t) => typeof t.symbol === "string" && t.symbol.endsWith("USD"))
        .map((t) => { const sym = t.symbol.replace(/USD$/, "");
          return { sym, name: sym, id: sym.toLowerCase(), price: parseFloat(t.lastPrice),
            pct: parseFloat(t.priceChangePercent) || 0, image: "" }; });
    },
  ];
  let coins: any[] = [];
  for (const p of providers) {
    try { coins = await p(); if (coins.length) break; }
    catch (e: any) { console.warn("crypto provider failed:", e?.message ?? e); }
  }
  const items: NewsItem[] = [];
  const pick = (pred: (c: any) => boolean) => coins.find(pred);
  const headliners = [pick((c) => c.sym === "BTC"), pick((c) => c.sym === "ETH"),
    ...coins.filter((c) => c.sym !== "BTC" && c.sym !== "ETH")
      .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 3)];
  for (const c of headliners) if (c) pushCoin(items, c.sym, c.name, c.id, c.price, c.pct, c.image);
  return items.slice(0, 5);
}

const MARKET_SYMS = [
  { sym: "VOO", name: "VOO S&P 500" }, { sym: "^GSPC", name: "S&P 500" },
  { sym: "^IXIC", name: "Nasdaq" }, { sym: "^DJI", name: "Dow Jones" },
  { sym: "NVDA", name: "NVIDIA" }, { sym: "TSLA", name: "Tesla" },
  { sym: "AAPL", name: "Apple" }, { sym: "MSFT", name: "Microsoft" },
  { sym: "AMZN", name: "Amazon" }, { sym: "META", name: "Meta" },
  { sym: "AMD", name: "AMD" }, { sym: "PLTR", name: "Palantir" },
];

async function marketsNews(): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  try {
    const quotes = (await Promise.all(MARKET_SYMS.map(async (t) => {
      try {
        const j: any = await fetchJson(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t.sym)}?interval=1d&range=2d`, 8000);
        const m = j?.chart?.result?.[0]?.meta;
        if (!m?.regularMarketPrice || !m?.chartPreviousClose) return null;
        const idx = ["VOO", "^GSPC", "^IXIC", "^DJI"].includes(t.sym);
        return { sym: t.sym, name: t.name, idx, price: m.regularMarketPrice,
          pct: (m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose * 100 };
      } catch { return null; }
    }))).filter(Boolean) as any[];
    for (const q of quotes.filter((q) => q.idx))
      items.push({ title: `${q.name} ${q.price.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${fmtPct(q.pct)}`,
        url: `https://finance.yahoo.com/quote/${encodeURIComponent(q.sym)}`, source: "MARKETS",
        image: faviconFor("https://finance.yahoo.com"),
        description: q.pct >= 0 ? "Green day — stocks and retirement accounts up." : "Red day — stocks cheaper; don't panic-sell." });
    for (const q of quotes.filter((q) => !q.idx).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 2))
      items.push({ title: `${q.name} ${fmtUsd(q.price)} ${fmtPct(q.pct)} — top mover`,
        url: `https://finance.yahoo.com/quote/${encodeURIComponent(q.sym)}`, source: "MARKETS",
        image: faviconFor("https://finance.yahoo.com"),
        description: impactLine(q.pct, `${q.name} holders`) });
  } catch (e: any) { console.warn("markets news failed:", e?.message ?? e); }
  return items.slice(0, 5);
}

// Shared RSS item parser — one implementation, both consumers
function parseRssItems(xml: string, limit: number): Array<{ title: string; link: string }> {
  const items: Array<{ title: string; link: string }> = [];
  const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && items.length < limit) {
    const title = m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const link = m[2].trim();
    if (title && link) items.push({ title, link });
  }
  return items;
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

async function macroNews(): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  const feeds = [
    "https://feeds.npr.org/1001/rss.xml", "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.theguardian.com/world/rss", "https://rss.dw.com/rdf/rss-en-top",
    "https://www.france24.com/en/rss",
  ];
  const seen = new Set<string>();
  for (const url of feeds) {
    try {
      let n = 0;
      for (const { title, link } of parseRssItems(await fetchText(url), 12)) {
        if (n >= 4) break;
        const tl = title.toLowerCase(), key = tl.slice(0, 48);
        if (seen.has(key) || SOFT_RE.test(tl)) continue;
        if (!MAJOR_RE.test(tl) && !MONEY_RE.test(tl)) continue;
        seen.add(key);
        items.push({ title, url: link, source: "WORLD", image: faviconFor(link), description: macroImpact(title) });
        n++;
      }
    } catch (e: any) { console.warn("macro news failed:", url, e?.message ?? e); }
  }
  return items.slice(0, 5);
}

async function buildNews(): Promise<NewsItem[]> {
  const [crypto, markets, macro] = await Promise.all([cryptoNews(), marketsNews(), macroNews()]);
  return [...macro.slice(0, 8), ...crypto.slice(0, 3), ...markets.slice(0, 3)].slice(0, 14);
}

let newsCache: { at: number; items: NewsItem[] } | null = null;
let newsInflight: Promise<NewsItem[]> | null = null;
const NEWS_TTL = 5 * 60 * 1000;

async function getNews(): Promise<NewsItem[]> {
  const now = Date.now();
  if (newsCache && now - newsCache.at < NEWS_TTL) return newsCache.items;
  if (!newsInflight) {
    newsInflight = buildNews().then((items) => {
      newsCache = { at: Date.now(), items };
      return items;
    }).finally(() => { newsInflight = null; });
  }
  return newsInflight;
}

// ============ PINECONE (control-plane host resolution, dimension-safe) ============
const PINECONE_INDEX = "static-pattern-refinery";
let _pcHost: { host: string; dimension: number } | null = null;

function pineconeHeaders(): Record<string, string> {
  const k = process.env.PINECONE_API_KEY;
  if (!k) throw new Error("PINECONE_API_KEY not configured");
  return { "Api-Key": k, "Content-Type": "application/json" };
}
async function pineconeIndex(): Promise<{ host: string; dimension: number }> {
  if (_pcHost) return _pcHost;
  // Control plane gives us the data-plane host + vector dimension — no more guessing
  const res = await fetch(`https://api.pinecone.io/indexes/${PINECONE_INDEX}`, { headers: pineconeHeaders() });
  if (!res.ok) throw new Error(`Pinecone describe ${res.status}`);
  const d: any = await safeJson(res);
  if (!d.host || !d.dimension) throw new Error("Pinecone index describe returned no host/dimension");
  _pcHost = { host: d.host, dimension: Number(d.dimension) };
  return _pcHost;
}

// ============ EXPRESS ============
const app = express();
app.use(express.json({ limit: "2mb" })); // voice payloads exceed 64kb — 413 was a phantom

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/news", async (_req, res) => {
  try {
    const items = await getNews();
    res.json({ ok: true, count: items.length, items });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const route = `/mcp/${MCP_SECRET}`; // fail-closed: secret guaranteed present
const server = buildServer(); // built ONCE at startup

app.post(route, async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e: any) {
    console.error("MCP route failure:", e?.message ?? e); // no more silent swallow
    if (!res.headersSent)
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

const notAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
app.get(route, notAllowed);
app.delete(route, notAllowed);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`highway-chat-mcp-server listening on :${port}`));
