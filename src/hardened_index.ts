/**
 * MarrowSystemZ — The last system the world will need.
 * (Founding vow preserved verbatim — see MARROW_CORE.md)
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API_KEY = process.env.FIREBASE_API_KEY;
if (!API_KEY) {
  console.error("FATAL: FIREBASE_API_KEY environment variable is not set.");
  process.exit(1);
}

const MCP_SECRET = process.env.MCP_SECRET;
if (!MCP_SECRET) {
  console.error("FATAL: MCP_SECRET environment variable is not set.");
  process.exit(1);
}
const CLIENT_KEY = process.env.HIGHWAY_CLIENT_KEY;
if (!CLIENT_KEY) {
  console.error("FATAL: HIGHWAY_CLIENT_KEY environment variable is not set.");
  process.exit(1);
}

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

const DEVICE_ID = "mcp-bridge";
const READ_BOT = "whisper"; // Default identity for read operations (must exist in BOT_CREDENTIALS)

// ---- Parsed once at startup, not per-request ----
const BOT_CREDS: Record<string, { email: string; password: string }> = (() => {
  try { return JSON.parse(process.env.BOT_CREDENTIALS || "{}"); }
  catch { return {}; }
})();

// ---- Token cache with in-flight dedup (kills the refresh stampede) ----
const _tokens = new Map<string, { token: string; exp: number }>();
const _inflight = new Map<string, Promise<string>>();

async function getIdToken(forName?: string): Promise<string> {
  const key = (forName || READ_BOT).toLowerCase();
  const now = Date.now();
  const cached = _tokens.get(key);
  if (cached && now < cached.exp - 60000) return cached.token;

  // Deduplicate concurrent refreshes for the same identity
  const pending = _inflight.get(key);
  if (pending) return pending;

  const p = (async (): Promise<string> => {
    const creds = BOT_CREDS[key];
    if (!creds?.email || !creds?.password) {
      throw new Error(`No credentials configured for bot "${key}"`);
    }
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
    _tokens.set(key, {
      token: data.idToken,
      exp: now + (parseInt(data.expiresIn || "3600", 10) * 1000),
    });
    return data.idToken as string;
  })();

  _inflight.set(key, p);
  try { return await p; }
  finally { _inflight.delete(key); }
}

async function firestore(path: string, init: { method: string; body?: unknown; forName?: string }) {
  const idToken = await getIdToken(init.forName); // defaults to READ_BOT, never anonymous
  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": API_KEY as string,
      "Authorization": `Bearer ${idToken}`,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message ?? res.statusText;
    throw new Error(`Firestore ${res.status}: ${msg}`);
  }
  return data;
}

// ---- Field accessors (unchanged, they work) ----
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
const docIdOf = (name: string): string => {
  const i = name.lastIndexOf("/");
  return i >= 0 ? decodeURIComponent(name.slice(i + 1)) : name;
};

// ---- Message payload builder (impossible check removed) ----
function buildMessageFields(name: string, text: string) {
  return {
    fields: {
      name: { stringValue: name },
      text: { stringValue: text },
      ts: nowTs(),
      tsNum: { integerValue: String(Date.now()) },
      deviceId: { stringValue: DEVICE_ID },
    },
  };
}

// ---- Tool response helpers (use everywhere) ----
const okText = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj) }],
});
const errText = (tool: string, e: any) => ({
  isError: true,
  content: [{ type: "text" as const, text: `${tool} failed: ${e?.message ?? e}` }],
});

// ---- Universal tool wrapper: kills 32 copies of try/catch boilerplate ----
function tool(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: any; readOnly?: boolean },
  handler: (args: any) => Promise<unknown>
) {
  server.registerTool(
    name,
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
      try {
        return okText(await handler(args));
      } catch (e: any) {
        return errText(name, e);
      }
    }
  );
}

async function queryNewest(collectionId: string, limit: number): Promise<any[]> {
  const data = await firestore(`:runQuery`, {
    method: "POST",
    body: {
      structuredQuery: {
        from: [{ collectionId }],
        orderBy: [{ field: { fieldPath: "ts" }, direction: "DESCENDING" }],
        limit,
      },
    },
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


// ---- Migration helpers (from original, adapted for forName) ----
async function countDocs(collectionId: string): Promise<number | null> {
  try {
    const data = await firestore(`:runAggregationQuery`, {
      method: "POST",
      body: {
        structuredAggregationQuery: {
          structuredQuery: { from: [{ collectionId }] },
          aggregations: [{ count: {}, alias: "total" }],
        },
      },
    });
    const v = data?.[0]?.result?.aggregateFields?.total;
    if (v?.integerValue !== undefined) return Number(v.integerValue);
    return null;
  } catch { return null; }
}

async function patchFields(collectionId: string, docId: string, fields: Record<string, unknown>, forName?: string) {
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  await firestore(`/${collectionId}/${encodeURIComponent(docId)}?${mask}`, {
    method: "PATCH", body: { fields }, forName,
  });
}

function parseReactions(f: any): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const fields = f?.mapValue?.fields ?? {};
  for (const [k, v] of Object.entries<any>(fields)) {
    const vals = v?.arrayValue?.values ?? [];
    out[k] = vals.map((x: any) => x?.stringValue).filter(Boolean);
  }
  return out;
}

function encodeReactions(rx: Record<string, string[]>): unknown {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rx))
    fields[k] = { arrayValue: { values: v.map((n) => ({ stringValue: n })) } };
  return { mapValue: { fields } };
}

async function postActivity(by: string, text: string, forName?: string): Promise<void> {
  await firestore(`/${ACTIVITY}`, {
    method: "POST", forName,
    body: { fields: {
      text: { stringValue: text },
      by: { stringValue: by },
      ts: nowTs(),
    }},
  });
}

async function findTask(task_id?: string, title?: string): Promise<{ id: string; fields: any } | null> {
  if (task_id) {
    const data: any = await firestore(`/${TASKS}/${encodeURIComponent(task_id)}`, { method: "GET" }).catch(() => null);
    if (data && data.fields) return { id: docIdOf(data.name), fields: data.fields };
    return null;
  }
  if (title) {
    const docs = await queryNewest(TASKS, 100);
    const q = title.toLowerCase();
    for (const d of docs) {
      if (str(d.fields?.text).toLowerCase().includes(q))
        return { id: docIdOf(d.name), fields: d.fields ?? {} };
    }
  }
  return null;
}

function fmtTask(d: any) {
  const f = d.fields ?? {};
  return {
    id: docIdOf(d.name),
    text: str(f.text),
    done: boolOf(f.done),
    createdBy: str(f.createdBy),
    assignee: str(f.assignee) || null,
    priority: str(f.priority) || null,
    ts: tsOf(f.ts),
  };
}

// fetchJson/fetchText as thin wrappers over fetchWithTimeout
async function fetchJson(url: string, timeoutMs = 12000): Promise<any> {
  return fetchWithTimeout(url, "json", timeoutMs);
}
async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  return fetchWithTimeout(url, "text", timeoutMs);
}
function extractDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}
function faviconFor(url: string): string {
  const d = extractDomain(url);
  return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=128` : "";
}
const fmtUsd = (n: number): string =>
  n >= 1000 ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 })
  : n >= 1 ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 })
  : "$" + n.toPrecision(3);
const fmtPct = (n: number): string => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
function impactLine(pct: number, holder: string): string {
  if (pct >= 5) return "Ripping \u2014 big green day. " + holder + " are up.";
  if (pct >= 1.5) return "Green \u2014 momentum building for " + holder + ".";
  if (pct <= -5) return "Dumping \u2014 don't panic-sell, " + holder + ".";
  if (pct <= -1.5) return "Dipping \u2014 cheaper if you were buying, " + holder + ".";
  return "Flat \u2014 nothing to act on today.";
}

function buildServer() {
  const server = new McpServer({ name: "highway-chat-mcp-server", version: "2.0.0" });

tool(server, "read_messages",
  { title: "Read Highway messages",
    description: "Read the newest messages from Highway Chat, newest first.",
    inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
    readOnly: true },
  async ({ limit }) => {
    const messages = (await queryNewest(MESSAGES, limit)).map((d: any) => {
      const f = d.fields ?? {};
      return {
        name: str(f.name), text: str(f.text),
        ts: tsOf(f.ts) ?? (d.createTime ? Date.parse(d.createTime) : null),
      };
    });
    return { count: messages.length, messages };
  }
);

  // send_message — migrated to tool() wrapper
  tool(server, "send_message",
    { title: "Send a Highway message",
      description: "Post a message to Highway Chat. Timestamp is generated automatically.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        text: z.string().trim().min(1).max(2000),
      } },
    async ({ name, text }) => {
      const ts = Date.now();
      await firestore(`/${MESSAGES}`, { method: "POST", body: buildMessageFields(name, text), forName: name });
      return { ok: true, name, ts };
    }
  );

  // send_voice — migrated to tool() wrapper
  tool(server, "send_voice",
    { title: "Send a Highway voice message",
      description: "Post a voice message to Highway Chat. Provide base64-encoded audio (webm/mp4, max 800KB).",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        audio: z.string().min(1).max(1100000),
        audioType: z.string().optional().default("audio/webm"),
        caption: z.string().trim().max(200).optional().default("🎤 voice message"),
      } },
    async ({ name, audio, audioType, caption }) => {
      const ts = Date.now();
      const fields = buildMessageFields(name, caption || "🎤 voice message");
      (fields.fields as any).audio = { stringValue: audio };
      (fields.fields as any).audioType = { stringValue: audioType || "audio/webm" };
      await firestore(`/${MESSAGES}`, { method: "POST", body: fields, forName: name });
      return { ok: true, name, ts };
    }
  );

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

tool(server, "route_task",
  { title: "Route a task to the best AI",
    description: "Analyze a task and recommend which team AI should handle it.",
    inputSchema: { task: z.string().trim().min(1).max(2000) },
    readOnly: true },
  async ({ task }) => {
    const t = task.toLowerCase();
    const hit = ROUTES.find((r) => r.re.test(t));
    return {
      task, taskType: hit?.type ?? "general",
      recommended: hit?.bot ?? "whisper",
      reason: hit?.reason ?? "default coordinator",
    };
  }
);

  // save_milestone — migrated to tool() wrapper
  tool(server, "save_milestone",
    { title: "Save a milestone to evolution log",
      description: "Log a significant moment to the permanent evolution timeline.",
      inputSchema: {
        text: z.string().trim().min(1).max(2000),
        type: z.string().optional().default("milestone"),
      } },
    async ({ text, type }) => {
      const doc = { fields: {
        type: { stringValue: type || "milestone" },
        text: { stringValue: text },
        tsNum: { integerValue: String(Date.now()) },
      }};
      await firestore(`/${EVO_LOGS}`, { method: "POST", body: doc });
      return { ok: true };
    }
  );

  // recall_context — migrated to tool() wrapper
  tool(server, "recall_context",
    { title: "Recall lifetime context",
      description: "Read the permanent evolution timeline and stored preferences.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().default(20) },
      readOnly: true },
    async ({ limit }) => {
      const logs = await firestore(`/${EVO_LOGS}?pageSize=${limit || 20}`, { method: "GET" });
      const mems = await firestore(`/${JARVIS_MEM}?pageSize=${limit || 20}`, { method: "GET" });
      return { evolution_logs: logs, jarvis_memory: mems };
    }
  );

  // store_preference — migrated to tool() wrapper
  tool(server, "store_preference",
    { title: "Store a user preference",
      description: "Save a durable preference to permanent memory.",
      inputSchema: {
        key: z.string().trim().min(1).max(200),
        value: z.string().trim().min(1).max(2000),
      } },
    async ({ key, value }) => {
      const doc = { fields: {
        key: { stringValue: key },
        value: { stringValue: value },
        tsNum: { integerValue: String(Date.now()) },
      }};
      await firestore(`/${JARVIS_MEM}`, { method: "POST", body: doc });
      return { ok: true, key };
    }
  );

  // log_correction — migrated to tool() wrapper
  tool(server, "log_correction",
    { title: "Log a correction to permanent memory",
      description: "When the user corrects the AI, log it so the mistake is never repeated.",
      inputSchema: {
        correction: z.string().trim().min(1).max(2000),
        context: z.string().trim().max(500).optional().default(""),
      } },
    async ({ correction, context }) => {
      const doc = { fields: {
        type: { stringValue: "correction" },
        text: { stringValue: `CORRECTION: ${correction}${context ? ` [Context: ${context}]` : ""}` },
        tsNum: { integerValue: String(Date.now()) },
      }};
      await firestore(`/${EVO_LOGS}`, { method: "POST", body: doc });
      return { ok: true };
    }
  );


  // ============ MIGRATED: Presence ============
  tool(server, "set_presence",
    { title: "Set Highway presence",
      description: "Mark a participant as present in Highway Chat. One doc per name, updated in place.",
      inputSchema: { name: z.string().trim().min(1).max(40) } },
    async ({ name }) => {
      const ts = Date.now();
      const docId = encodeURIComponent(name.toLowerCase().replace(/[\/\s]+/g, "_"));
      await firestore(`/${PRESENCE}/${docId}`, {
        method: "PATCH", forName: name,
        body: { fields: { name: { stringValue: name }, ts: nowTs() } },
      });
      return { ok: true, name, ts };
    }
  );

  tool(server, "get_presence",
    { title: "Get Highway presence",
      description: "Who is currently online in Highway Chat. Online = heartbeat fresher than 90 seconds.",
      inputSchema: {}, readOnly: true },
    async () => {
      const data: any = await firestore(`/${PRESENCE}`, { method: "GET" });
      const now = Date.now();
      const people = (data.documents ?? []).map((d: any) => {
        const f = d.fields ?? {};
        const ts = tsOf(f.ts);
        return { name: str(f.name), ts, online: ts !== null && now - ts < 90000 };
      });
      return { count: people.length, online: people.filter((p: any) => p.online).length, people };
    }
  );

  // ============ MIGRATED: Typing ============
  tool(server, "set_typing",
    { title: "Set typing indicator",
      description: "Show (or clear) your typing indicator in Highway Chat.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        typing: z.boolean(),
      } },
    async ({ name, typing }) => {
      const docId = `mcp-${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
      await patchFields(TYPING, docId, {
        name: { stringValue: name },
        typing: { booleanValue: typing },
        ts: nowTs(),
      }, name);
      return { ok: true, name, typing };
    }
  );

  // ============ MIGRATED: Messages ============
  tool(server, "edit_message",
    { title: "Edit a Highway message",
      description: "Edit the text of a message you posted. Only the original author (by name) can edit.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        message_id: z.string().trim().min(1),
        text: z.string().trim().min(1).max(2000),
      } },
    async ({ name, message_id, text }) => {
      const data: any = await firestore(`/${MESSAGES}/${encodeURIComponent(message_id)}`, { method: "GET", forName: name }).catch(() => null);
      if (!data || !data.fields) throw new Error("message not found");
      const author = str(data.fields.name);
      if (author.toLowerCase() !== name.toLowerCase())
        throw new Error(`only the author (${author}) can edit this message`);
      await patchFields(MESSAGES, docIdOf(data.name), { text: { stringValue: text } }, name);
      return { ok: true, message_id: docIdOf(data.name), text };
    }
  );

  tool(server, "delete_message",
    { title: "Delete a Highway message",
      description: "Delete a message you posted. Only the original author (by name) can delete.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        message_id: z.string().trim().min(1),
      } },
    async ({ name, message_id }) => {
      const data: any = await firestore(`/${MESSAGES}/${encodeURIComponent(message_id)}`, { method: "GET", forName: name }).catch(() => null);
      if (!data || !data.fields) throw new Error("message not found");
      const author = str(data.fields.name);
      if (author.toLowerCase() !== name.toLowerCase())
        throw new Error(`only the author (${author}) can delete this message`);
      await firestore(`/${MESSAGES}/${encodeURIComponent(docIdOf(data.name))}`, { method: "DELETE", forName: name });
      return { ok: true, message_id: docIdOf(data.name), deleted: true };
    }
  );

  tool(server, "react_to_message",
    { title: "React to a Highway message",
      description: "Toggle an emoji reaction on a message.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        message_id: z.string().trim().min(1),
        emoji: z.string().trim().min(1).max(8),
      } },
    async ({ name, message_id, emoji }) => {
      const data: any = await firestore(`/${MESSAGES}/${encodeURIComponent(message_id)}`, { method: "GET", forName: name }).catch(() => null);
      if (!data || !data.fields) throw new Error("message not found");
      const rx = parseReactions(data.fields.reactions);
      const users = rx[emoji] ?? [];
      const i = users.findIndex((u) => u.toLowerCase() === name.toLowerCase());
      let action: string;
      if (i >= 0) { users.splice(i, 1); action = "removed"; } else { users.push(name); action = "added"; }
      if (users.length) rx[emoji] = users; else delete rx[emoji];
      await patchFields(MESSAGES, docIdOf(data.name), { reactions: encodeReactions(rx) }, name);
      return { ok: true, message_id: docIdOf(data.name), emoji, action, reactions: rx };
    }
  );

  tool(server, "search_messages",
    { title: "Search Highway messages",
      description: "Search recent chat history for a keyword (case-insensitive). Scans up to 200 newest.",
      inputSchema: {
        query: z.string().trim().min(1).max(100),
        limit: z.number().int().min(1).max(50).default(10),
      }, readOnly: true },
    async ({ query, limit }) => {
      const docs = await queryNewest(MESSAGES, 200);
      const q = query.toLowerCase();
      const matches = docs
        .map((d) => {
          const f = d.fields ?? {};
          return { id: docIdOf(d.name), name: str(f.name), text: str(f.text), ts: tsOf(f.ts) };
        })
        .filter((m) => m.text.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
        .slice(0, limit);
      return { count: matches.length, query, matches };
    }
  );

  tool(server, "pin_message",
    { title: "Pin or unpin a Highway message",
      description: "Pin a message so it stands out, or unpin it.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        message_id: z.string().trim().min(1),
        pinned: z.boolean().default(true),
      } },
    async ({ name, message_id, pinned }) => {
      const data: any = await firestore(`/${MESSAGES}/${encodeURIComponent(message_id)}`, { method: "GET", forName: name }).catch(() => null);
      if (!data || !data.fields) throw new Error("message not found");
      await patchFields(MESSAGES, docIdOf(data.name), { pinned: { booleanValue: pinned } }, name);
      await postActivity(name, `${pinned ? "pinned" : "unpinned"} a message: ${str(data.fields.text).slice(0, 120)}`, name);
      return { ok: true, message_id: docIdOf(data.name), pinned };
    }
  );

  tool(server, "read_pinned",
    { title: "Read pinned Highway messages",
      description: "List messages currently pinned in Highway Chat, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
      readOnly: true },
    async ({ limit }) => {
      const data = await firestore(`:runQuery`, {
        method: "POST",
        body: {
          structuredQuery: {
            from: [{ collectionId: MESSAGES }],
            where: { fieldFilter: { field: { fieldPath: "pinned" }, op: "EQUAL", value: { booleanValue: true } } },
            orderBy: [{ field: { fieldPath: "ts" }, direction: "DESCENDING" }],
            limit,
          },
        },
      });
      const pins = (Array.isArray(data) ? data : [])
        .map((r: any) => r.document).filter(Boolean)
        .map((d: any) => {
          const f = d.fields ?? {};
          return { id: docIdOf(d.name), name: str(f.name), text: str(f.text), ts: tsOf(f.ts) };
        });
      return { count: pins.length, pins };
    }
  );

  // ============ MIGRATED: Activity ============
  tool(server, "log_activity",
    { title: "Log Highway activity",
      description: "Post an entry to the Highway Chat ACTIVITY feed.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        text: z.string().trim().min(1).max(300),
      } },
    async ({ name, text }) => {
      await postActivity(name, text, name);
      return { ok: true, name, text, ts: Date.now() };
    }
  );

  tool(server, "read_activity",
    { title: "Read Highway activity",
      description: "Read recent entries from the Highway Chat ACTIVITY feed, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
      readOnly: true },
    async ({ limit }) => {
      const docs = await queryNewest(ACTIVITY, limit);
      const entries = docs.map((d) => {
        const f = d.fields ?? {};
        return { id: docIdOf(d.name), by: str(f.by), text: str(f.text), ts: tsOf(f.ts) };
      });
      return { count: entries.length, entries };
    }
  );

  // ============ MIGRATED: Tasks ============
  tool(server, "read_tasks",
    { title: "Read Highway tasks",
      description: "List quests/tasks on the Highway board, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(30),
        include_done: z.boolean().default(true),
      }, readOnly: true },
    async ({ limit, include_done }) => {
      const docs = await queryNewest(TASKS, limit);
      let tasks = docs.map(fmtTask);
      if (!include_done) tasks = tasks.filter((t) => !t.done);
      return { count: tasks.length, open: tasks.filter((t) => !t.done).length, tasks };
    }
  );

  tool(server, "add_task",
    { title: "Add a Highway task",
      description: "Add a quest to the Highway board. Posts to ACTIVITY automatically.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        text: z.string().trim().min(1).max(300),
        priority: z.enum(["low", "normal", "high"]).default("normal"),
        assignee: z.string().trim().max(40).optional(),
      } },
    async ({ name, text, priority, assignee }) => {
      const fields: Record<string, unknown> = {
        text: { stringValue: text },
        done: { booleanValue: false },
        createdBy: { stringValue: name },
        priority: { stringValue: priority },
        ts: nowTs(),
      };
      if (assignee) fields.assignee = { stringValue: assignee };
      const data: any = await firestore(`/${TASKS}`, { method: "POST", body: { fields }, forName: name });
      const id = docIdOf(data.name);
      await postActivity(name, `started quest: ${text.slice(0, 200)}`, name).catch((e) => { console.error("postActivity failed:", e?.message || e); });
      return { ok: true, id, text };
    }
  );

  tool(server, "complete_task",
    { title: "Complete a Highway task",
      description: "Mark a quest complete by ID or title match.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        task_id: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).max(300).optional(),
      } },
    async ({ name, task_id, title }) => {
      if (!task_id && !title) throw new Error("provide task_id or title");
      const task = await findTask(task_id, title);
      if (!task) throw new Error("task not found");
      await patchFields(TASKS, task.id, { done: { booleanValue: true } }, name);
      const text = str(task.fields.text);
      await postActivity(name, `completed quest: ${text.slice(0, 200)}`, name).catch((e) => { console.error("postActivity failed:", e?.message || e); });
      return { ok: true, id: task.id, text, done: true };
    }
  );

  tool(server, "update_task",
    { title: "Update a Highway task",
      description: "Edit a quest's title, priority, or assignee by ID.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        task_id: z.string().trim().min(1),
        text: z.string().trim().min(1).max(300).optional(),
        priority: z.enum(["low", "normal", "high"]).optional(),
        assignee: z.string().trim().max(40).optional(),
      } },
    async ({ name, task_id, text, priority, assignee }) => {
      const task = await findTask(task_id);
      if (!task) throw new Error("task not found");
      const fields: Record<string, unknown> = {};
      if (text !== undefined) fields.text = { stringValue: text };
      if (priority !== undefined) fields.priority = { stringValue: priority };
      if (assignee !== undefined) fields.assignee = { stringValue: assignee };
      if (Object.keys(fields).length === 0) throw new Error("nothing to update");
      await patchFields(TASKS, task.id, fields, name);
      const newText = text ?? str(task.fields.text);
      await postActivity(name, `updated quest: ${newText.slice(0, 200)}`, name).catch((e) => { console.error("postActivity failed:", e?.message || e); });
      return { ok: true, id: task.id, text: newText };
    }
  );

  tool(server, "delete_task",
    { title: "Delete a Highway task",
      description: "Remove a quest from the board by ID.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        task_id: z.string().trim().min(1),
      } },
    async ({ name, task_id }) => {
      const task = await findTask(task_id);
      if (!task) throw new Error("task not found");
      const text = str(task.fields.text);
      await firestore(`/${TASKS}/${encodeURIComponent(task.id)}`, { method: "DELETE", forName: name });
      await postActivity(name, `abandoned quest: ${text.slice(0, 200)}`, name).catch((e) => { console.error("postActivity failed:", e?.message || e); });
      return { ok: true, id: task.id, deleted: true };
    }
  );

  tool(server, "assign_task",
    { title: "Assign a Highway task",
      description: "Assign a quest to a team member by task ID.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        task_id: z.string().trim().min(1),
        assignee: z.string().trim().min(1).max(40),
      } },
    async ({ name, task_id, assignee }) => {
      const task = await findTask(task_id);
      if (!task) throw new Error("task not found");
      await patchFields(TASKS, task.id, { assignee: { stringValue: assignee } }, name);
      const text = str(task.fields.text);
      await postActivity(name, `assigned quest "${text.slice(0, 120)}" to ${assignee}`, name).catch((e) => { console.error("postActivity failed:", e?.message || e); });
      return { ok: true, id: task.id, assignee };
    }
  );

  // ============ MIGRATED: Notes ============
  tool(server, "read_notes",
    { title: "Read the Highway grimoire",
      description: "Read the shared Highway notes — one shared page for the whole room.",
      inputSchema: {}, readOnly: true },
    async () => {
      const data: any = await firestore(`/${NOTES}/shared`, { method: "GET" }).catch(() => null);
      if (!data || !data.fields) return { exists: false, content: "", updatedBy: null, ts: null };
      const f = data.fields;
      return { exists: true, content: str(f.content), updatedBy: str(f.updatedBy), ts: tsOf(f.ts) };
    }
  );

  tool(server, "update_notes",
    { title: "Overwrite the Highway grimoire",
      description: "Replace the entire shared notes page. Prefer append_note.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        content: z.string().max(20000),
      } },
    async ({ name, content }) => {
      await patchFields(NOTES, "shared", {
        content: { stringValue: content },
        updatedBy: { stringValue: name },
        ts: nowTs(),
      }, name);
      return { ok: true, updatedBy: name, chars: content.length };
    }
  );

  tool(server, "append_note",
    { title: "Append to the Highway grimoire",
      description: "Add a signed entry to the shared notes without overwriting.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        text: z.string().trim().min(1).max(5000),
      } },
    async ({ name, text }) => {
      const data: any = await firestore(`/${NOTES}/shared`, { method: "GET" }).catch(() => null);
      const current = data?.fields ? str(data.fields.content) : "";
      const entry = `\n\n\u2014 ${name} \u00b7 ${new Date().toLocaleString()}\n${text}`;
      const content = (current + entry).slice(-20000);
      await patchFields(NOTES, "shared", {
        content: { stringValue: content },
        updatedBy: { stringValue: name },
        ts: nowTs(),
      }, name);
      return { ok: true, updatedBy: name, chars: content.length };
    }
  );

  // ============ MIGRATED: News / Team / Stats ============
  tool(server, "get_news",
    { title: "Get Highway money news",
      description: "Money-and-life news feed (crypto + markets + macro). Shares server 5-min cache.",
      inputSchema: { limit: z.number().int().min(1).max(15).default(10) },
      readOnly: true },
    async ({ limit }) => {
      const items = await getNews();
      const sliced = items.slice(0, limit).map((it: any) => ({
        title: it.title, url: it.url, source: it.source,
        image: it.image || null, description: it.description || null,
      }));
      return { ok: true, count: sliced.length, items: sliced };
    }
  );

  tool(server, "get_team",
    { title: "Get Highway team",
      description: "List members with online status — presence merged with recent chatters.",
      inputSchema: {}, readOnly: true },
    async () => {
      const [presData, msgDocs] = await Promise.all([
        firestore(`/${PRESENCE}`, { method: "GET" }).catch(() => ({ documents: [] })),
        queryNewest(MESSAGES, 50).catch(() => []),
      ]);
      const now = Date.now();
      const online = new Map<string, number>();
      for (const d of presData.documents ?? []) {
        const f = d.fields ?? {};
        const n = str(f.name);
        const ts = tsOf(f.ts);
        if (n && ts !== null && now - ts < 90000 && !online.has(n.toLowerCase()))
          online.set(n.toLowerCase(), ts);
      }
      const seen = new Map<string, { name: string; online: boolean; lastSeen: number | null }>();
      for (const d of msgDocs) {
        const f = d.fields ?? {};
        const n = str(f.name);
        if (!n || seen.has(n.toLowerCase())) continue;
        seen.set(n.toLowerCase(), { name: n, online: online.has(n.toLowerCase()), lastSeen: tsOf(f.ts) });
      }
      return { count: seen.size, members: Array.from(seen.values()) };
    }
  );

  tool(server, "get_stats",
    { title: "Get Highway room stats",
      description: "Room vitals: messages, quests, online count, activity, grimoire freshness.",
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
      return {
        messages_total: msgTotal,
        tasks_open: tasks.filter((t) => !t.done).length,
        tasks_done: tasks.filter((t) => t.done).length,
        online_now: online,
        grimoire: notesData?.fields
          ? { updatedBy: str(notesData.fields.updatedBy), ts: tsOf(notesData.fields.ts), chars: str(notesData.fields.content).length }
          : null,
        server_time: new Date().toISOString(),
      };
    }
  );

  tool(server, "get_time",
    { title: "Get server time",
      description: "Current server time (ISO 8601 and unix ms).",
      inputSchema: {}, readOnly: true },
    async () => {
      const now = Date.now();
      return { iso: new Date(now).toISOString(), unix_ms: now };
    }
  );

  return server;
}

async function cryptoNews(): Promise<any[]> {
  const items: any[] = [];
  const push = (sym: string, name: string, id: string, price: number, pct: number, image: string) => {
    items.push({
      title: sym.toUpperCase() + " " + fmtUsd(price) + " " + fmtPct(pct),
      url: "https://www.coingecko.com/en/coins/" + id,
      source: "CRYPTO", image,
      description: impactLine(pct, name + " holders"),
    });
  };
  try { // Kraken free API, no key, no geo-block
    const k: any = await fetchJson(
      "https://api.kraken.com/0/public/Ticker?pair=BTCUSD,ETHUSD,SOLUSD,DOGEUSD,XRPUSD,ADAUSD,AVAXUSD,LINKUSD,HYPEUSD");
    const r = k && k.result;
    if (!r || (k.error && k.error.length)) throw new Error("kraken error");
    const pairMap: any = { BTCUSD: ["BTC", "Bitcoin", "bitcoin"], ETHUSD: ["ETH", "Ethereum", "ethereum"], SOLUSD: ["SOL", "Solana", "solana"], DOGEUSD: ["DOGE", "Dogecoin", "dogecoin"], XRPUSD: ["XRP", "XRP", "ripple"], ADAUSD: ["ADA", "Cardano", "cardano"], AVAXUSD: ["AVAX", "Avalanche", "avalanche"], LINKUSD: ["LINK", "Chainlink", "chainlink"], HYPEUSD: ["HYPE", "Hyperliquid", "hyperliquid"] };
    const found: any[] = [];
    for (const key of Object.keys(r)) {
      for (const pk of Object.keys(pairMap)) {
        if (key.replace(/^X|^Z/, "").startsWith(pk.replace("USD", "")) && key.endsWith("USD")) {
          const t = r[key];
          const price = parseFloat(t.c[0]), open = parseFloat(t.o);
          if (price && open) found.push({ sym: pairMap[pk][0], name: pairMap[pk][1], id: pairMap[pk][2], price, pct: (price - open) / open * 100 });
          break;
        }
      }
    }
    if (!found.length) throw new Error("kraken empty");
    const btc = found.find((f) => f.sym === "BTC"), eth = found.find((f) => f.sym === "ETH");
    const movers = found.filter((f) => f !== btc && f !== eth)
      .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 3);
    for (const f of [btc, eth, ...movers]) {
      if (f) push(f.sym, f.name, f.id, f.price, f.pct, "");
    }
    if (items.length) return items.slice(0, 5);
    throw new Error("kraken empty");
  } catch (e) {
    console.warn("kraken failed, trying coingecko", e);
  }
  try { // CoinGecko free API, no key
    const coins: any[] = await fetchJson(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=60&page=1&sparkline=false&price_change_percentage=24h");
    if (!Array.isArray(coins) || !coins.length) throw new Error("empty coingecko");
    const btc = coins.find((c) => c.symbol === "btc");
    const eth = coins.find((c) => c.symbol === "eth");
    const movers = coins.filter((c) => c !== btc && c !== eth)
      .sort((a, b) => Math.abs(b.price_change_percentage_24h || 0) - Math.abs(a.price_change_percentage_24h || 0))
      .slice(0, 3);
    for (const c of [btc, eth, ...movers]) {
      if (c) push(c.symbol, c.name, c.id, c.current_price, c.price_change_percentage_24h || 0, c.image || "");
    }
  } catch (e) {
    console.warn("coingecko failed, trying binance.us", e);
    try { // Binance.US 24hr tickers, no key — BTC/ETH + top movers by |24h change|
      const tick: any[] = await fetchJson("https://api.binance.us/api/v3/ticker/24hr");
      if (!Array.isArray(tick) || !tick.length) throw new Error("empty binance");
      const usd: Record<string, any> = {};
      for (const t of tick) if (t && typeof t.symbol === "string" && t.symbol.endsWith("USD")) usd[t.symbol] = t;
      const btc = usd["BTCUSD"], eth = usd["ETHUSD"];
      const names: Record<string, string> = { BTCUSD: "Bitcoin", ETHUSD: "Ethereum" };
      const movers = Object.values(usd).filter((t: any) => t !== btc && t !== eth)
        .sort((a: any, b: any) => Math.abs(parseFloat(b.priceChangePercent) || 0) - Math.abs(parseFloat(a.priceChangePercent) || 0))
        .slice(0, 3);
      for (const t of [btc, eth, ...movers]) {
        if (!t) continue;
        const sym = String(t.symbol).replace(/USD$/, "");
        push(sym, names[t.symbol] || sym, sym.toLowerCase(), parseFloat(t.lastPrice), parseFloat(t.priceChangePercent) || 0, "");
      }
    } catch (e2) { console.warn("binance.us failed", e2); }
  }
  return items.slice(0, 5);
}

const MARKET_SYMS = [
  { sym: "VOO", name: "VOO S&P 500", idx: true },
  { sym: "^GSPC", name: "S&P 500", idx: true },
  { sym: "^IXIC", name: "Nasdaq", idx: true },
  { sym: "^DJI", name: "Dow Jones", idx: true },
  { sym: "NVDA", name: "NVIDIA", idx: false },
  { sym: "TSLA", name: "Tesla", idx: false },
  { sym: "AAPL", name: "Apple", idx: false },
  { sym: "MSFT", name: "Microsoft", idx: false },
  { sym: "AMZN", name: "Amazon", idx: false },
  { sym: "META", name: "Meta", idx: false },
  { sym: "AMD", name: "AMD", idx: false },
  { sym: "PLTR", name: "Palantir", idx: false },
  { sym: "WMT", name: "Walmart", idx: false },
  { sym: "COST", name: "Costco", idx: false },
  { sym: "COIN", name: "Coinbase", idx: false },
];

async function marketsNews(): Promise<any[]> {
  const items: any[] = [];
  try { // Yahoo Finance chart API, no key
    const quotes = (await Promise.all(MARKET_SYMS.map(async (t) => {
      try {
        const j: any = await fetchJson(
          "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(t.sym) + "?interval=1d&range=2d", 8000);
        const r = j && j.chart && j.chart.result && j.chart.result[0];
        const m = r && r.meta;
        if (!m || !m.regularMarketPrice || !m.chartPreviousClose) return null;
        return { sym: t.sym, name: t.name, idx: t.idx, price: m.regularMarketPrice,
          pct: (m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose * 100 };
      } catch { return null; }
    }))).filter(Boolean) as any[];
    for (const q of quotes.filter((q) => q.idx)) {
      items.push({
        title: q.name + " " + q.price.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " " + fmtPct(q.pct),
        url: "https://finance.yahoo.com/quote/" + encodeURIComponent(q.sym),
        source: "MARKETS", image: faviconFor("https://finance.yahoo.com"),
        description: q.pct >= 0
          ? "Green day — stocks and retirement accounts up."
          : "Red day — stocks cheaper; don't panic-sell.",
      });
    }
    const movers = quotes.filter((q) => !q.idx).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 2);
    for (const q of movers) {
      items.push({
        title: q.name + " " + fmtUsd(q.price) + " " + fmtPct(q.pct) + " — top mover",
        url: "https://finance.yahoo.com/quote/" + encodeURIComponent(q.sym),
        source: "MARKETS", image: faviconFor("https://finance.yahoo.com"),
        description: impactLine(q.pct, q.name + " holders"),
      });
    }
  } catch (e) { console.warn("markets news failed", e); }
  return items.slice(0, 5);
}

const MONEY_WORDS = ["rate", "fed", "inflation", "cpi", "jobs", "unemployment", "wage",
  "tariff", "tax", "recession", "gdp", "housing", "mortgage", "rent", "oil", "gas",
  "crypto", "bitcoin", "stock", "market", "dollar", "interest", "bank", "debt", "stimulus", "trade",
  "trump", "white house", "congress", "election", "midterm", "ukraine", "russia", "iran", "israel",
  "gaza", "taiwan", "china", "war", "ai", "openai", "anthropic", "nvidia", "chip", "robot",
  "spacex", "nasa", "moon", "mars", "food", "wheat", "corn", "crop", "drought", "famine", "ebt", "snap"];
const MONEY_RE = new RegExp("\\b(" + MONEY_WORDS.join("|") + ")s?\\b");

function macroImpact(title: string): string {
  const t = title.toLowerCase();
  if (/rate|fed|interest|treasury|yield/.test(t)) return "10Y at 5.3% (24yr high) → every loan costs more. Dec hike 73% priced.";
  if (t.includes("inflation") || t.includes("cpi")) return "Inflation above target → Fed can't cut. Your dollar buys less.";
  if (/jobs|unemployment|wage|hiring/.test(t)) return "Only 29K jobs added (vs 90K exp) → hiring freeze risk before Dec hike.";
  if (t.includes("tariff")) return "Tariffs → import prices climb. Oct 18 Russia 500% deadline looms.";
  if (/housing|mortgage|rent/.test(t)) return "Mortgages at 7.5% → affordability worse than 2006. Rents re-accelerating.";
  if (/oil|gas|energy|opec|brent/.test(t)) return "Brent $101-105, Hormuz at 74% → gas & diesel squeeze. Iran war day 222.";
  if (/\btax(es)?\b/.test(t)) return "Taxes → what you keep changes. AI taxation bills moving in Senate.";
  if (/trump|white house|congress|election|midterm/.test(t)) return "Nov 3 midterms → 91% Dem House odds. Power shift moves markets.";
  if (/ukraine|russia|iran|israel|gaza|taiwan|war|hormuz/.test(t)) return "Conflict → oil spikes, markets shake. Post-midterm escalation risk.";
  if (/\bai\b|openai|anthropic|nvidia|chip|robot/.test(t)) return "AI buildout debt-financed at 5%+ rates → concentration risk. FTC probing.";
  if (/spacex|nasa|moon|mars|artemis|starship/.test(t)) return "Starship reached orbit. Moon landing targeted 2028.";
  if (/food|wheat|corn|crop|drought|famine|ebt|snap|beef/.test(t)) return "Beef at $6.92/lb record. El Niño peaking. SNAP Nov funding uncertain.";
  if (/hurricane|storm|flood|earthquake|wildfire|tornado/.test(t)) return "Disaster → supply chains break, insurance spikes, gas prices jump.";
  if (/bitcoin|btc|crypto|ethereum/.test(t)) return "BTC-gold correlation at all-time high → debasement trade. $75K is the line.";
  return "Major shift → watch your wallet.";
}

const MAJOR_WORDS = ["war", "conflict", "strike", "earthquake", "hurricane", "trump", "white house",
  "fed", "inflation", "missile", "ceasefire", "famine", "sanctions", "election", "midterm",
  "iran", "ukraine", "russia", "israel", "gaza", "taiwan", "china", "nuclear", "troops", "invasion",
  "disaster", "flood", "wildfire", "volcano", "tsunami", "pandemic", "crisis", "collapse",
  "spacex", "nasa", "moon", "mars", "artemis", "starship", "hormuz", "opec", "brent",
  "america", "american", "u.s.", "united states", "congress", "senate", "supreme court",
  "mortgage", "housing", "beef", "diesel", "snap", "debt", "treasury", "yield",
  "ai", "openai", "anthropic", "nvidia", "bitcoin", "crypto"];
const MAJOR_RE = new RegExp("\\b(" + MAJOR_WORDS.join("|") + ")s?\\b");
const SOFT_WORDS = ["obituary", "dies at", "celebrity", "sport", "wins", "fashion", "golf club", "profits"];
const SOFT_RE = new RegExp(SOFT_WORDS.join("|"));

async function macroNews(): Promise<any[]> {
  const items: any[] = [];
  const feeds = [
    "https://feeds.npr.org/1001/rss.xml",
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.theguardian.com/world/rss",
    "https://rss.dw.com/rdf/rss-en-top",
    "https://www.france24.com/en/rss",
  ];
  const seen = new Set<string>();
  for (const url of feeds) {
    try {
      const xml = await fetchText(url);
      const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>/g;
      let m: RegExpExecArray | null, n = 0;
      while ((m = re.exec(xml)) && n < 4) {
        const title = m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
        const link = m[2].trim();
        const tl = title.toLowerCase();
        const key = tl.slice(0, 48);
        if (!title || !link || seen.has(key)) continue;
        if (SOFT_RE.test(tl)) continue;
        if (!MAJOR_RE.test(tl) && !MONEY_RE.test(tl)) continue;
        seen.add(key);
        items.push({ title, url: link, source: "WORLD", image: faviconFor(link), description: macroImpact(title) });
        n++;
      }
    } catch (e) { console.warn("macro news failed", url, e); }
  }
  return items.slice(0, 5);
}

async function buildNews(): Promise<any[]> {
  const [crypto, markets, macro] = await Promise.all([cryptoNews(), marketsNews(), macroNews()]);
  return [...macro.slice(0, 8), ...crypto.slice(0, 3), ...markets.slice(0, 3)].slice(0, 14);
}

let newsCache: { at: number; items: any[] } | null = null;
let newsInflight: Promise<any[]> | null = null;
const NEWS_TTL = 5 * 60 * 1000;

async function getNews(): Promise<any[]> {
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

const app = express();
app.use(express.json({ limit: "64kb" }));

// CORS for browser clients
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

const route = MCP_SECRET ? `/mcp/${MCP_SECRET}` : "/mcp";
const server = buildServer(); // Built ONCE at startup

app.post(route, async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});


const notAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
app.get(route, notAllowed);
app.delete(route, notAllowed);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`highway-chat-mcp-server listening on :${port}`));
