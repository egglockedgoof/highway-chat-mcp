import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API_KEY = process.env.FIREBASE_API_KEY;
if (!API_KEY) {
  console.error("FATAL: FIREBASE_API_KEY environment variable is not set.");
  process.exit(1);
}

// Optional but recommended: makes the endpoint /mcp/<secret> so strangers can't post to your room.
const MCP_SECRET = process.env.MCP_SECRET || "";

const BASE =
  process.env.FIRESTORE_BASE ||
  "https://firestore.googleapis.com/v1/projects/highway-chat/databases/(default)/documents";

const MESSAGES = "highway_messages";
const PRESENCE = "highway_presence";

// Key goes in a header, never in the URL, so it can't leak via URLs or access logs.
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
    // Only status + Google's message; never echo headers or the key.
    throw new Error(`Firestore ${res.status}: ${msg}`);
  }
  return data;
}

const str = (f: any): string => f?.stringValue ?? "";
// NOTE: this chat stores time in the `ts` field (usually timestampValue).
const tsOf = (f: any): number | null => {
  if (!f) return null;
  if (f.timestampValue !== undefined) return Date.parse(f.timestampValue);
  if (f.integerValue !== undefined) return Number(f.integerValue);
  if (f.doubleValue !== undefined) return Number(f.doubleValue);
  return null;
};
const nowTs = () => ({ timestampValue: new Date().toISOString() });

function buildServer() {
  const server = new McpServer({ name: "highway-chat-mcp-server", version: "1.0.0" });

  server.registerTool(
    "read_messages",
    {
      title: "Read Highway messages",
      description:
        "Read the newest messages from Highway Chat (highway_messages). Returns name, text, and ts (Unix ms), newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10).describe("How many newest messages to return (1-50)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }) => {
      try {
        const data = await firestore(`/${MESSAGES}?pageSize=${limit}`, { method: "GET" });
        const messages = ((data as any).documents ?? [])
          .map((d: any) => {
            const f = d.fields ?? {};
            return { name: str(f.name), text: str(f.text), ts: tsOf(f.ts) };
          })
          .sort((a: any, b: any) => (b.ts ?? 0) - (a.ts ?? 0))
          .slice(0, limit);
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
      description: "Post a message to Highway Chat (highway_messages). Timestamp is generated automatically.",
      inputSchema: {
        name: z.string().trim().min(1).max(40).describe("Sender display name, e.g. 'whisper'."),
        text: z.string().trim().min(1).max(2000).describe("Message text."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, text }) => {
      try {
        const ts = Date.now();
        await firestore(`/${MESSAGES}`, {
          method: "POST",
          body: {
            fields: {
              name: { stringValue: name },
              text: { stringValue: text },
              ts: nowTs(),
            },
          },
        });
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
      description:
        "Mark a participant as present in Highway Chat (highway_presence). One doc per name, updated in place. Timestamp is generated automatically.",
      inputSchema: {
        name: z.string().trim().min(1).max(40).describe("Participant name, e.g. 'whisper'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name }) => {
      try {
        const ts = Date.now();
        // Doc ID = slug of the name so repeated calls update the same presence doc.
        const docId = encodeURIComponent(name.toLowerCase().replace(/[\/\s]+/g, "_"));
        await firestore(`/${PRESENCE}/${docId}`, {
          method: "PATCH",
          body: {
            fields: {
              name: { stringValue: name },
              ts: nowTs(),
            },
          },
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

app.get("/health", (_req, res) => res.json({ ok: true }));

const route = MCP_SECRET ? `/mcp/${MCP_SECRET}` : "/mcp";

// Stateless streamable HTTP: fresh server + transport per request.
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
app.listen(port, () => console.log(`highway-chat-mcp-server listening on :${port} (endpoint path ${MCP_SECRET ? "/mcp/<secret>" : "/mcp"})`));
