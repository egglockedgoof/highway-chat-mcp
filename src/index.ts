import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API_KEY = process.env.FIREBASE_API_KEY;
if (!API_KEY) {
  console.error("FATAL: FIREBASE_API_KEY environment variable is not set.");
  process.exit(1);
}

const MCP_SECRET = process.env.MCP_SECRET || "";

const BASE =
  process.env.FIRESTORE_BASE ||
  "https://firestore.googleapis.com/v1/projects/highway-chat/databases/(default)/documents";

const MESSAGES = "highway_messages";
const PRESENCE = "highway_presence";
const ACTIVITY = "highway_activity";
const TASKS = "highway_tasks";
const NOTES = "highway_notes";
const TYPING = "highway_typing";

// Mirror of the Firestore security rule:
// allow create: if request.resource.data.keys().hasAll(['name','text','deviceId'])
// Single source of truth for the write contract — change here if rules change.
const REQUIRED_MESSAGE_KEYS = ["name", "text", "deviceId"] as const;
const DEVICE_ID = "mcp-bridge";

async function firestore(path: string, init: { method: string; body?: unknown }) {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": API_KEY as string,
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

const str = (f: any): string => f?.stringValue ?? "";
const tsOf = (f: any): number | null => {
  if (!f) return null;
  if (f.timestampValue !== undefined) return Date.parse(f.timestampValue);
  if (f.integerValue !== undefined) return Number(f.integerValue);
  if (f.doubleValue !== undefined) return Number(f.doubleValue);
  return null;
};
const nowTs = () => ({ timestampValue: new Date().toISOString() });

// Payload builder guarantees the Firestore rule contract is always satisfied.
function buildMessageFields(name: string, text: string) {
  const fields: Record<string, unknown> = {
    name: { stringValue: name },
    text: { stringValue: text },
    ts: nowTs(),
    tsNum: { integerValue: String(Date.now()) },
    deviceId: { stringValue: DEVICE_ID },
  };
  // Fail fast locally if the contract is ever broken again,
  // instead of surfacing a cryptic 403 from Firestore.
  const missing = REQUIRED_MESSAGE_KEYS.filter((k) => !(k in fields));
  if (missing.length > 0) {
    throw new Error(`Message payload missing required keys: ${missing.join(", ")}`);
  }
  return { fields };
}

// Extract doc ID from a Firestore resource name:
// "projects/<p>/databases/(default)/documents/<col>/<id>" -> "<id>"
function docIdOf(name: string): string {
  const i = name.lastIndexOf("/");
  return i >= 0 ? decodeURIComponent(name.slice(i + 1)) : name;
}

const boolOf = (f: any): boolean => f?.booleanValue ?? false;

// Newest-first query on any collection by its ts field.
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

// Cheap server-side document count via aggregation query.
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
  } catch {
    return null;
  }
}

// PATCH only the given fields on a doc (updateMask), leaving other fields intact.
// Upserts: creates the doc if it does not exist.
async function patchFields(collectionId: string, docId: string, fields: Record<string, unknown>) {
  const mask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");
  await firestore(`/${collectionId}/${encodeURIComponent(docId)}?${mask}`, {
    method: "PATCH",
    body: { fields },
  });
}

// Parse Firestore map<string, string[]> (reactions) into a plain object.
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
  for (const [k, v] of Object.entries(rx)) {
    fields[k] = { arrayValue: { values: v.map((n) => ({ stringValue: n })) } };
  }
  return { mapValue: { fields } };
}

// Post one activity entry. Shared by log_activity and the task tools,
// mirroring the widget's "<b>by</b> text <time>ts</time>" render contract.
async function postActivity(by: string, text: string): Promise<void> {
  await firestore(`/${ACTIVITY}`, {
    method: "POST",
    body: {
      fields: {
        text: { stringValue: text },
        by: { stringValue: by },
        ts: nowTs(),
      },
    },
  });
}

// Find a task doc by exact ID, or by case-insensitive title substring.
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
      if (str(d.fields?.text).toLowerCase().includes(q)) {
        return { id: docIdOf(d.name), fields: d.fields ?? {} };
      }
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

function okText(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function errText(tool: string, e: any) {
  return { isError: true, content: [{ type: "text" as const, text: `${tool} failed: ${e.message}` }] };
}

function buildServer() {
  const server = new McpServer({ name: "highway-chat-mcp-server", version: "1.0.0" });

  server.registerTool(
    "read_messages",
    {
      title: "Read Highway messages",
      description: "Read the newest messages from Highway Chat, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      try {
        // Order by ts DESC server-side via runQuery, so the newest docs
        // are actually returned even as the collection grows.
        const data = await firestore(`:runQuery`, {
          method: "POST",
          body: {
            structuredQuery: {
              from: [{ collectionId: MESSAGES }],
              orderBy: [{ field: { fieldPath: "ts" }, direction: "DESCENDING" }],
              limit,
            },
          },
        });
        const messages = (Array.isArray(data) ? data : [])
          .map((r: any) => r.document)
          .filter(Boolean)
          .map((d: any) => {
            const f = d.fields ?? {};
            // Fall back to createTime when ts is missing/unparseable,
            // so no message is invisible to newest-first ordering.
            const ts = tsOf(f.ts) ?? (d.createTime ? Date.parse(d.createTime) : null);
            return { name: str(f.name), text: str(f.text), ts };
          });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ count: messages.length, messages }, null, 2) }],
        };
      } catch (e: any) {
        return { isError: true, content: [{ type: "text" as const, text: `read_messages failed: ${e.message}` }] };
      }
    }
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a Highway message",
      description: "Post a message to Highway Chat. Timestamp is generated automatically.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        text: z.string().trim().min(1).max(2000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, text }) => {
      try {
        const ts = Date.now();
        await firestore(`/${MESSAGES}`, { method: "POST", body: buildMessageFields(name, text) });
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, name, ts }) }] };
      } catch (e: any) {
        return { isError: true, content: [{ type: "text" as const, text: `send_message failed: ${e.message}` }] };
      }
    }
  );

  server.registerTool(
    "set_presence",
    {
      title: "Set Highway presence",
      description: "Mark a participant as present in Highway Chat. One doc per name, updated in place.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name }) => {
      try {
        const ts = Date.now();
        const docId = encodeURIComponent(name.toLowerCase().replace(/[\/\s]+/g, "_"));
        await firestore(`/${PRESENCE}/${docId}`, {
          method: "PATCH",
          body: { fields: { name: { stringValue: name }, ts: nowTs() } },
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, name, ts }) }] };
      } catch (e: any) {
        return { isError: true, content: [{ type: "text" as const, text: `set_presence failed: ${e.message}` }] };
      }
    }
  );

  server.registerTool(
    "edit_message",
    {
      title: "Edit a Highway message",
      description: "Edit the text of a message you posted. Only the original author (by name) can edit.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        message_id: z.string().trim().min(1),
        text: z.string().trim().min(1).max(2000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, message_id, text }) => {
      try {
        const data: any = await firestore(`/${MESSAGES}/${encodeURIComponent(message_id)}`, { method: "GET" }).catch(() => null);
        if (!data || !data.fields) return errText("edit_message", new Error("message not found"));
        const author = str(data.fields.name);
        if (author.toLowerCase() !== name.toLowerCase()) {
          return errText("edit_message", new Error(`only the author (${author}) can edit this message`));
        }
        await patchFields(MESSAGES, docIdOf(data.name), { text: { stringValue: text } });
        return okText({ ok: true, message_id: docIdOf(data.name), text });
      } catch (e: any) {
        return errText("edit_message", e);
      }
    }
  );

  server.registerTool(
    "delete_message",
    {
      title: "Delete a Highway message",
      description: "Delete a message you posted. Only the original author (by name) can delete.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        message_id: z.string().trim().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, message_id }) => {
      try {
        const data: any = await firestore(`/${MESSAGES}/${encodeURIComponent(message_id)}`, { method: "GET" }).catch(() => null);
        if (!data || !data.fields) return errText("delete_message", new Error("message not found"));
        const author = str(data.fields.name);
        if (author.toLowerCase() !== name.toLowerCase()) {
          return errText("delete_message", new Error(`only the author (${author}) can delete this message`));
        }
        await firestore(`/${MESSAGES}/${encodeURIComponent(docIdOf(data.name))}`, { method: "DELETE" });
        return okText({ ok: true, message_id: docIdOf(data.name), deleted: true });
      } catch (e: any) {
        return errText("delete_message", e);
      }
    }
  );

  server.registerTool(
    "react_to_message",
    {
      title: "React to a Highway message",
      description: "Toggle an emoji reaction on a message (adds it if you haven't reacted, removes it if you have). Mirrors the widget's reaction pills.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        message_id: z.string().trim().min(1),
        emoji: z.string().trim().min(1).max(8),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, message_id, emoji }) => {
      try {
        const data: any = await firestore(`/${MESSAGES}/${encodeURIComponent(message_id)}`, { method: "GET" }).catch(() => null);
        if (!data || !data.fields) return errText("react_to_message", new Error("message not found"));
        const rx = parseReactions(data.fields.reactions);
        const users = rx[emoji] ?? [];
        const i = users.findIndex((u) => u.toLowerCase() === name.toLowerCase());
        let action: string;
        if (i >= 0) { users.splice(i, 1); action = "removed"; } else { users.push(name); action = "added"; }
        if (users.length) rx[emoji] = users; else delete rx[emoji];
        await patchFields(MESSAGES, docIdOf(data.name), { reactions: encodeReactions(rx) });
        return okText({ ok: true, message_id: docIdOf(data.name), emoji, action, reactions: rx });
      } catch (e: any) {
        return errText("react_to_message", e);
      }
    }
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search Highway messages",
      description: "Search recent chat history for a keyword (case-insensitive). Scans up to 200 newest messages.",
      inputSchema: {
        query: z.string().trim().min(1).max(100),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      try {
        const docs = await queryNewest(MESSAGES, 200);
        const q = query.toLowerCase();
        const matches = docs
          .map((d) => {
            const f = d.fields ?? {};
            return { id: docIdOf(d.name), name: str(f.name), text: str(f.text), ts: tsOf(f.ts) };
          })
          .filter((m) => m.text.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
          .slice(0, limit);
        return okText({ count: matches.length, query, matches });
      } catch (e: any) {
        return errText("search_messages", e);
      }
    }
  );

  server.registerTool(
    "pin_message",
    {
      title: "Pin or unpin a Highway message",
      description: "Pin a message so it stands out, or unpin it. Pinned messages are listed by read_pinned.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        message_id: z.string().trim().min(1),
        pinned: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, message_id, pinned }) => {
      try {
        const data: any = await firestore(`/${MESSAGES}/${encodeURIComponent(message_id)}`, { method: "GET" }).catch(() => null);
        if (!data || !data.fields) return errText("pin_message", new Error("message not found"));
        await patchFields(MESSAGES, docIdOf(data.name), { pinned: { booleanValue: pinned } });
        await postActivity(name, `${pinned ? "pinned" : "unpinned"} a message: ${str(data.fields.text).slice(0, 120)}`);
        return okText({ ok: true, message_id: docIdOf(data.name), pinned });
      } catch (e: any) {
        return errText("pin_message", e);
      }
    }
  );

  server.registerTool(
    "read_pinned",
    {
      title: "Read pinned Highway messages",
      description: "List messages currently pinned in Highway Chat, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      try {
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
          .map((r: any) => r.document)
          .filter(Boolean)
          .map((d: any) => {
            const f = d.fields ?? {};
            return { id: docIdOf(d.name), name: str(f.name), text: str(f.text), ts: tsOf(f.ts) };
          });
        return okText({ count: pins.length, pins });
      } catch (e: any) {
        return errText("read_pinned", e);
      }
    }
  );

  server.registerTool(
    "get_presence",
    {
      title: "Get Highway presence",
      description: "Who is currently online in Highway Chat. A participant counts as online if their heartbeat is fresher than 90 seconds.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const data: any = await firestore(`/${PRESENCE}`, { method: "GET" });
        const now = Date.now();
        const people = (data.documents ?? []).map((d: any) => {
          const f = d.fields ?? {};
          const ts = tsOf(f.ts);
          return { name: str(f.name), ts, online: ts !== null && now - ts < 90000 };
        });
        return okText({ count: people.length, online: people.filter((p: any) => p.online).length, people });
      } catch (e: any) {
        return errText("get_presence", e);
      }
    }
  );

  server.registerTool(
    "set_typing",
    {
      title: "Set typing indicator",
      description: "Show (or clear) your typing indicator in Highway Chat, like the widget does while you type.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        typing: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, typing }) => {
      try {
        const docId = `mcp-${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
        await patchFields(TYPING, docId, {
          name: { stringValue: name },
          typing: { booleanValue: typing },
          ts: nowTs(),
        });
        return okText({ ok: true, name, typing });
      } catch (e: any) {
        return errText("set_typing", e);
      }
    }
  );

  server.registerTool(
    "log_activity",
    {
      title: "Log Highway activity",
      description: "Post an entry to the Highway Chat ACTIVITY feed (the living timeline). Use it for quest updates, milestones, arrivals, or anything the room should see. Renders as '<name> <text>'.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        text: z.string().trim().min(1).max(300),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, text }) => {
      try {
        await postActivity(name, text);
        return okText({ ok: true, name, text, ts: Date.now() });
      } catch (e: any) {
        return errText("log_activity", e);
      }
    }
  );

  server.registerTool(
    "read_activity",
    {
      title: "Read Highway activity",
      description: "Read recent entries from the Highway Chat ACTIVITY feed, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      try {
        const docs = await queryNewest(ACTIVITY, limit);
        const entries = docs.map((d) => {
          const f = d.fields ?? {};
          return { id: docIdOf(d.name), by: str(f.by), text: str(f.text), ts: tsOf(f.ts) };
        });
        return okText({ count: entries.length, entries });
      } catch (e: any) {
        return errText("read_activity", e);
      }
    }
  );

  server.registerTool(
    "read_tasks",
    {
      title: "Read Highway tasks",
      description: "List quests/tasks on the Highway board, newest first. Hide completed ones unless include_done is true.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(30),
        include_done: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit, include_done }) => {
      try {
        const docs = await queryNewest(TASKS, limit);
        let tasks = docs.map(fmtTask);
        if (!include_done) tasks = tasks.filter((t) => !t.done);
        return okText({ count: tasks.length, open: tasks.filter((t) => !t.done).length, tasks });
      } catch (e: any) {
        return errText("read_tasks", e);
      }
    }
  );

  server.registerTool(
    "add_task",
    {
      title: "Add a Highway task",
      description: "Add a quest to the Highway board. Also posts 'started quest: <text>' to the ACTIVITY feed automatically.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        text: z.string().trim().min(1).max(300),
        priority: z.enum(["low", "normal", "high"]).default("normal"),
        assignee: z.string().trim().max(40).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, text, priority, assignee }) => {
      try {
        const fields: Record<string, unknown> = {
          text: { stringValue: text },
          done: { booleanValue: false },
          createdBy: { stringValue: name },
          priority: { stringValue: priority },
          ts: nowTs(),
        };
        if (assignee) fields.assignee = { stringValue: assignee };
        const data: any = await firestore(`/${TASKS}`, { method: "POST", body: { fields } });
        const id = docIdOf(data.name);
        await postActivity(name, `started quest: ${text.slice(0, 200)}`).catch(() => {});
        return okText({ ok: true, id, text, priority, assignee: assignee ?? null });
      } catch (e: any) {
        return errText("add_task", e);
      }
    }
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete a Highway task",
      description: "Mark a quest complete by its ID, or by matching part of its title. Posts 'completed quest: <text>' to ACTIVITY automatically.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        task_id: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).max(300).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, task_id, title }) => {
      try {
        if (!task_id && !title) return errText("complete_task", new Error("provide task_id or title"));
        const task = await findTask(task_id, title);
        if (!task) return errText("complete_task", new Error("task not found"));
        await patchFields(TASKS, task.id, { done: { booleanValue: true } });
        const text = str(task.fields.text);
        await postActivity(name, `completed quest: ${text.slice(0, 200)}`).catch(() => {});
        return okText({ ok: true, id: task.id, text, done: true });
      } catch (e: any) {
        return errText("complete_task", e);
      }
    }
  );

  server.registerTool(
    "update_task",
    {
      title: "Update a Highway task",
      description: "Edit a quest's title, priority, or assignee by ID. Posts an ACTIVITY entry automatically.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        task_id: z.string().trim().min(1),
        text: z.string().trim().min(1).max(300).optional(),
        priority: z.enum(["low", "normal", "high"]).optional(),
        assignee: z.string().trim().max(40).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, task_id, text, priority, assignee }) => {
      try {
        const task = await findTask(task_id);
        if (!task) return errText("update_task", new Error("task not found"));
        const fields: Record<string, unknown> = {};
        if (text !== undefined) fields.text = { stringValue: text };
        if (priority !== undefined) fields.priority = { stringValue: priority };
        if (assignee !== undefined) fields.assignee = { stringValue: assignee };
        if (Object.keys(fields).length === 0) return errText("update_task", new Error("nothing to update"));
        await patchFields(TASKS, task.id, fields);
        const newText = text ?? str(task.fields.text);
        await postActivity(name, `updated quest: ${newText.slice(0, 200)}`).catch(() => {});
        return okText({ ok: true, id: task.id, updated: Object.keys(fields) });
      } catch (e: any) {
        return errText("update_task", e);
      }
    }
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete a Highway task",
      description: "Remove a quest from the board by ID. Posts 'abandoned quest: <text>' to ACTIVITY automatically.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        task_id: z.string().trim().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, task_id }) => {
      try {
        const task = await findTask(task_id);
        if (!task) return errText("delete_task", new Error("task not found"));
        const text = str(task.fields.text);
        await firestore(`/${TASKS}/${encodeURIComponent(task.id)}`, { method: "DELETE" });
        await postActivity(name, `abandoned quest: ${text.slice(0, 200)}`).catch(() => {});
        return okText({ ok: true, id: task.id, deleted: true });
      } catch (e: any) {
        return errText("delete_task", e);
      }
    }
  );

  server.registerTool(
    "assign_task",
    {
      title: "Assign a Highway task",
      description: "Assign a quest to a team member by task ID. Posts an ACTIVITY entry automatically.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        task_id: z.string().trim().min(1),
        assignee: z.string().trim().min(1).max(40),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, task_id, assignee }) => {
      try {
        const task = await findTask(task_id);
        if (!task) return errText("assign_task", new Error("task not found"));
        await patchFields(TASKS, task.id, { assignee: { stringValue: assignee } });
        const text = str(task.fields.text);
        await postActivity(name, `assigned quest "${text.slice(0, 120)}" to ${assignee}`).catch(() => {});
        return okText({ ok: true, id: task.id, assignee });
      } catch (e: any) {
        return errText("assign_task", e);
      }
    }
  );

  server.registerTool(
    "read_notes",
    {
      title: "Read the Highway grimoire",
      description: "Read the shared Highway notes (the Grimoire) — one shared page for the whole room.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const data: any = await firestore(`/${NOTES}/shared`, { method: "GET" }).catch(() => null);
        if (!data || !data.fields) return okText({ exists: false, content: "", updatedBy: null, ts: null });
        const f = data.fields;
        return okText({ exists: true, content: str(f.content), updatedBy: str(f.updatedBy), ts: tsOf(f.ts) });
      } catch (e: any) {
        return errText("read_notes", e);
      }
    }
  );

  server.registerTool(
    "update_notes",
    {
      title: "Overwrite the Highway grimoire",
      description: "Replace the entire shared notes page with new content. Prefer append_note to add without wiping.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        content: z.string().max(20000),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, content }) => {
      try {
        await patchFields(NOTES, "shared", {
          content: { stringValue: content },
          updatedBy: { stringValue: name },
          ts: nowTs(),
        });
        return okText({ ok: true, updatedBy: name, chars: content.length });
      } catch (e: any) {
        return errText("update_notes", e);
      }
    }
  );

  server.registerTool(
    "append_note",
    {
      title: "Append to the Highway grimoire",
      description: "Add a signed entry to the end of the shared notes page without overwriting existing content.",
      inputSchema: {
        name: z.string().trim().min(1).max(40),
        text: z.string().trim().min(1).max(5000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, text }) => {
      try {
        const data: any = await firestore(`/${NOTES}/shared`, { method: "GET" }).catch(() => null);
        const current = data?.fields ? str(data.fields.content) : "";
        const entry = `\n\n— ${name} · ${new Date().toLocaleString()}\n${text}`;
        const content = (current + entry).slice(-20000);
        await patchFields(NOTES, "shared", {
          content: { stringValue: content },
          updatedBy: { stringValue: name },
          ts: nowTs(),
        });
        return okText({ ok: true, updatedBy: name, chars: content.length });
      } catch (e: any) {
        return errText("append_note", e);
      }
    }
  );

  server.registerTool(
    "get_news",
    {
      title: "Get Highway money news",
      description: "Get the same money-and-life news feed the widget's News tab shows (crypto movers + stock markets + macro money news), so you can read and discuss it in chat. Shares the server's 5-minute cache.",
      inputSchema: {
        limit: z.number().int().min(1).max(15).default(10),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      try {
        const now = Date.now();
        if (!newsCache || now - newsCache.at > NEWS_TTL) {
          newsCache = { at: now, items: await buildNews() };
        }
        const items = newsCache.items.slice(0, limit).map((it: any) => ({
          title: it.title, url: it.url, source: it.source,
          image: it.image || null, description: it.description || null,
        }));
        return okText({ ok: true, updated: new Date(newsCache.at).toISOString(), count: items.length, items });
      } catch (e: any) {
        return errText("get_news", e);
      }
    }
  );

  server.registerTool(
    "get_team",
    {
      title: "Get Highway team",
      description: "List Highway Chat members with online status — presence heartbeats merged with recent chatters.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
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
          if (n && ts !== null && now - ts < 90000 && !online.has(n.toLowerCase())) {
            online.set(n.toLowerCase(), ts);
          }
        }
        const seen = new Map<string, { name: string; online: boolean; lastSeen: number | null }>();
        for (const d of msgDocs) {
          const f = d.fields ?? {};
          const n = str(f.name);
          if (!n || seen.has(n.toLowerCase())) continue;
          const ts = tsOf(f.ts);
          seen.set(n.toLowerCase(), { name: n, online: online.has(n.toLowerCase()), lastSeen: ts });
        }
        for (const [k, ts] of online) {
          if (!seen.has(k)) seen.set(k, { name: k, online: true, lastSeen: ts });
        }
        const members = [...seen.values()].sort((a, b) => Number(b.online) - Number(a.online));
        return okText({ count: members.length, online: members.filter((m) => m.online).length, members });
      } catch (e: any) {
        return errText("get_team", e);
      }
    }
  );

  server.registerTool(
    "get_stats",
    {
      title: "Get Highway room stats",
      description: "Room vitals: total messages, open/done quests, online count, recent activity, grimoire freshness.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
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
        return okText({
          messages_total: msgTotal,
          tasks_open: tasks.filter((t) => !t.done).length,
          tasks_done: tasks.filter((t) => t.done).length,
          online_now: online,
          grimoire: notesData?.fields
            ? { updatedBy: str(notesData.fields.updatedBy), ts: tsOf(notesData.fields.ts), chars: str(notesData.fields.content).length }
            : null,
          server_time: new Date().toISOString(),
        });
      } catch (e: any) {
        return errText("get_stats", e);
      }
    }
  );

  server.registerTool(
    "get_time",
    {
      title: "Get server time",
      description: "Current server time (ISO 8601 and unix milliseconds). Useful for scheduling and timestamps.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const now = Date.now();
      return okText({ iso: new Date(now).toISOString(), unix_ms: now });
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "64kb" }));

// CORS for browser clients (news feed widget, etc.)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- News aggregator: money-and-life first (crypto + markets + macro), 5-min cache ----
// Server-side fetch, so no CORS limits: the widget only ever talks to /news.
let newsCache: { at: number; items: any[] } | null = null;
const NEWS_TTL = 5 * 60 * 1000;

async function fetchJson(url: string, timeoutMs = 12000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; highway-chat-news/1.0)" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
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

// Wallet-impact one-liner for a price move (plain language, no fabricated "why").
function impactLine(pct: number, holder: string): string {
  if (pct >= 5) return "Ripping — big green day. " + holder + " are up.";
  if (pct >= 1.5) return "Green — momentum building for " + holder + ".";
  if (pct <= -5) return "Dumping — don't panic-sell, " + holder + ".";
  if (pct <= -1.5) return "Dipping — cheaper if you were buying, " + holder + ".";
  return "Flat — nothing to act on today.";
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
  if (/rate|fed|interest/.test(t)) return "Rates move → borrowing & savings rates shift.";
  if (t.includes("inflation") || t.includes("cpi")) return "Prices rising → your dollar buys less.";
  if (/jobs|unemployment|wage|hiring/.test(t)) return "Jobs market → hiring & pay pressure.";
  if (t.includes("tariff")) return "Tariffs → import prices may climb.";
  if (/housing|mortgage|rent/.test(t)) return "Housing → rent & mortgage costs.";
  if (/oil|gas|energy/.test(t)) return "Energy → gas & utility bills.";
  if (/\btax(es)?\b/.test(t)) return "Taxes → what you keep changes.";
  if (/trump|white house|congress|election|midterm/.test(t)) return "Power shift → policy moves money.";
  if (/ukraine|russia|iran|israel|gaza|taiwan|war/.test(t)) return "Conflict → markets shake, prices move.";
  if (/\bai\b|openai|anthropic|nvidia|chip|robot/.test(t)) return "AI/tech → jobs and markets shift.";
  if (/spacex|nasa|moon|mars/.test(t)) return "Space → humanity's reach expands.";
  if (/food|wheat|corn|crop|drought|famine|ebt|snap/.test(t)) return "Food → what you eat costs more.";
  return "Macro shift → watch your wallet.";
}

const MAJOR_WORDS = ["war", "conflict", "strike", "earthquake", "hurricane", "trump", "white house",
  "fed", "inflation", "missile", "ceasefire", "famine", "outbreak", "sanctions", "election", "midterm",
  "iran", "ukraine", "russia", "israel", "gaza", "taiwan", "china", "nuclear", "troops", "invasion",
  "disaster", "flood", "wildfire", "volcano", "tsunami", "pandemic", "crisis", "collapse",
  "spacex", "nasa", "moon", "mars", "artemis", "starship",
  "america", "american", "u.s.", "united states", "congress", "senate", "supreme court"];
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

app.get("/news", async (_req, res) => {
  try {
    const now = Date.now();
    if (!newsCache || now - newsCache.at > NEWS_TTL) {
      newsCache = { at: now, items: await buildNews() };
    }
    res.json({ ok: true, updated: new Date(newsCache.at).toISOString(), count: newsCache.items.length, items: newsCache.items });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const route = MCP_SECRET ? `/mcp/${MCP_SECRET}` : "/mcp";

app.post(route, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const notAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
app.get(route, notAllowed);
app.delete(route, notAllowed);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`highway-chat-mcp-server listening on :${port}`));
