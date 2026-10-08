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

// ---- News aggregator: trending overall (HN + Lobsters + BBC), 15-min cache ----
let newsCache: { at: number; items: any[] } | null = null;
const NEWS_TTL = 15 * 60 * 1000;

async function fetchJson(url: string, timeoutMs = 12000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "highway-chat-news/1.0" } });
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

async function buildNews(): Promise<any[]> {
  const items: { title: string; url: string; source: string; score?: number }[] = [];
  try { // Hacker News top stories
    const ids: number[] = await fetchJson("https://hacker-news.firebaseio.com/v0/topstories.json");
    const stories = await Promise.all(ids.slice(0, 12).map((id) =>
      fetchJson("https://hacker-news.firebaseio.com/v0/item/" + id + ".json").catch(() => null)));
    for (const s of stories) {
      if (s && s.title) items.push({ title: s.title, url: s.url || ("https://news.ycombinator.com/item?id=" + s.id), source: "HN", score: s.score || 0 });
    }
  } catch (e) { console.warn("HN news failed", e); }
  try { // Lobsters hottest
    const lob = await fetchJson("https://lobste.rs/hottest.json");
    for (const s of (Array.isArray(lob) ? lob : []).slice(0, 10)) {
      if (s && s.title) items.push({ title: s.title, url: s.url || s.comments_url, source: "Lobsters", score: s.score || 0 });
    }
  } catch (e) { console.warn("Lobsters news failed", e); }
  try { // BBC world news RSS
    const xml = await fetchText("https://feeds.bbci.co.uk/news/rss.xml");
    const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>/g;
    let m: RegExpExecArray | null, n = 0;
    while ((m = re.exec(xml)) && n < 10) {
      const title = m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
      const link = m[2].trim();
      if (title && link) { items.push({ title, url: link, source: "BBC" }); n++; }
    }
  } catch (e) { console.warn("BBC news failed", e); }
  return items;
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
