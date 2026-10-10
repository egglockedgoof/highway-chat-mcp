#!/usr/bin/env node
/**
 * Post-deploy smoke against the live bridge.
 *
 *   SMOKE_TOKEN=... SMOKE_BOT_NAME=whisper npm run smoke
 *   SMOKE_OFFLINE=1 npm run smoke:offline   # CI: local mock, never hits Highway
 *
 * Does not import src/. Uses GET /health + MCP JSON-RPC only.
 * Live mode writes one tagged [smoke] message on the code channel (idempotent).
 */
function baseUrl(): string {
  return (process.env.SMOKE_BASE_URL || "https://highway-chat-mcp.onrender.com").replace(/\/$/, "");
}
function smokeToken(): string { return process.env.SMOKE_TOKEN?.trim() || ""; }
function smokePathSecret(): string { return process.env.SMOKE_PATH_SECRET?.trim() || ""; }
function smokeBot(): string { return process.env.SMOKE_BOT_NAME?.trim() || ""; }
const CHANNEL = process.env.SMOKE_CHANNEL?.trim() || "code";
const TIMEOUT_MS = 20_000;
const MIN_TOOLS = 50;
const CORE_TOOLS = ["read_messages", "send_message", "get_time", "check_bridge_health"] as const;
const SPOOF_NAME = "smoke-impostor";

type Rpc = { jsonrpc?: string; id?: unknown; result?: unknown; error?: { code?: number; message?: string } };

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function ok(label: string, detail?: string) {
  passed++;
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label: string, detail: string) {
  failed++;
  failures.push(`${label}: ${detail}`);
  console.log(`FAIL  ${label} — ${detail}`);
}
function skip(label: string, detail: string) {
  skipped++;
  console.log(`SKIP  ${label} — ${detail}`);
}

async function http(path: string, init: RequestInit = {}): Promise<{ status: number; contentType: string; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${path}`, { ...init, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get("content-type") || "", text };
  } finally {
    clearTimeout(timer);
  }
}

function parseSse(text: string): unknown {
  const payloads: unknown[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const raw = t.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try { payloads.push(JSON.parse(raw)); } catch { /* ignore malformed event */ }
  }
  return payloads.find((p) => p && typeof p === "object" && ("result" in (p as object) || "error" in (p as object)))
    ?? payloads.at(-1);
}

function parseRpc(contentType: string, text: string): Rpc {
  if (contentType.includes("text/event-stream")) return (parseSse(text) ?? {}) as Rpc;
  return JSON.parse(text) as Rpc;
}

function mcpPath(): string {
  if (smokeToken()) return "/mcp";
  if (smokePathSecret()) return `/mcp/${encodeURIComponent(smokePathSecret())}`;
  throw new Error("set SMOKE_TOKEN (preferred) or SMOKE_PATH_SECRET");
}

function mcpHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-03-26",
  };
  if (smokeToken()) h.authorization = `Bearer ${smokeToken()}`;
  return h;
}

let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown> = {}): Promise<Rpc> {
  const id = ++rpcId;
  const { status, contentType, text } = await http(mcpPath(), {
    method: "POST",
    headers: mcpHeaders(),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (status === 404) {
    throw new Error(`MCP 404 decoy (bad or missing credentials). HTTP ${status}`);
  }
  if (status >= 400) {
    throw new Error(`MCP HTTP ${status}: ${text.slice(0, 300)}`);
  }
  let body: Rpc;
  try { body = parseRpc(contentType, text); }
  catch { throw new Error(`MCP non-JSON response: ${text.slice(0, 300)}`); }
  if (body.error) throw new Error(`JSON-RPC ${body.error.code}: ${body.error.message}`);
  return body;
}

function toolPayload(rpcBody: Rpc): { isError: boolean; text: string; json: Record<string, unknown> | null } {
  const result = (rpcBody.result ?? {}) as { isError?: boolean; content?: Array<{ text?: string }> };
  const text = result.content?.[0]?.text ?? "";
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* tool errors are plain text */ }
  return { isError: !!result.isError, text, json };
}

async function callTool(name: string, args: Record<string, unknown>) {
  const body = await rpc("tools/call", { name, arguments: args });
  return toolPayload(body);
}

async function checkHealth() {
  const { status, text } = await http("/health");
  if (status !== 200) return fail("health", `HTTP ${status}: ${text.slice(0, 200)}`);
  let body: { ok?: boolean; reads?: { budget?: number; overBudget?: boolean } };
  try { body = JSON.parse(text); }
  catch { return fail("health", `non-JSON body: ${text.slice(0, 200)}`); }
  if (body.ok !== true) return fail("health", `ok=${String(body.ok)}`);
  ok("health", `budget ${body.reads?.budget ?? "?"}, overBudget=${String(body.reads?.overBudget)}`);
}

async function checkTools(): Promise<string[]> {
  const body = await rpc("tools/list");
  const tools = (body.result as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? [];
  const names = tools.map((t) => t.name).filter((n): n is string => !!n);
  const missing = CORE_TOOLS.filter((n) => !names.includes(n));
  if (missing.length) {
    fail("tool count", `missing core tools: ${missing.join(", ")} (got ${names.length})`);
    return names;
  }
  if (names.length < MIN_TOOLS) {
    fail("tool count", `expected at least ${MIN_TOOLS} tools, got ${names.length}`);
    return names;
  }
  ok("tool count", `${names.length} tools, core present`);
  return names;
}

async function checkRoundTripAndIdempotency() {
  const bot = smokeBot();
  if (!bot) {
    skip("read round-trip", "set SMOKE_BOT_NAME");
    skip("duplicate-key", "set SMOKE_BOT_NAME");
    return;
  }
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `smoke-${stamp}`;
  const text = `[smoke] env-check ${stamp} (safe to ignore)`;

  const first = await callTool("send_message", {
    name: bot, text, channel: CHANNEL, idempotency_key: key,
  });
  if (first.isError || first.json?.ok !== true) {
    fail("read round-trip", `send failed: ${first.text.slice(0, 300)}`);
    skip("duplicate-key", "send did not land");
    return;
  }
  if (first.json?.duplicate === true) {
    fail("read round-trip", "first send reported duplicate=true");
    return;
  }
  const sentId = String(first.json?.id ?? "");

  const read = await callTool("read_messages", { limit: 5, channel: CHANNEL });
  if (read.isError || !read.json) {
    fail("read round-trip", `read failed: ${read.text.slice(0, 300)}`);
  } else {
    const messages = Array.isArray(read.json.messages) ? read.json.messages as Array<{ text?: string; id?: string }> : [];
    const found = messages.some((m) => m.text === text || (sentId && m.id === sentId));
    if (!found) fail("read round-trip", `sent ${sentId || text} not in last ${messages.length} on ${CHANNEL}`);
    else ok("read round-trip", `found on ${CHANNEL} (limit 5)`);
  }

  const second = await callTool("send_message", {
    name: bot, text, channel: CHANNEL, idempotency_key: key,
  });
  if (second.isError) {
    fail("duplicate-key", `second send errored: ${second.text.slice(0, 300)}`);
    return;
  }
  if (second.json?.duplicate !== true) {
    fail("duplicate-key", `expected duplicate=true, got ${JSON.stringify(second.json)}`);
    return;
  }
  if (sentId && second.json.id && String(second.json.id) !== sentId) {
    fail("duplicate-key", `id changed ${sentId} → ${String(second.json.id)}`);
    return;
  }
  ok("duplicate-key", "same key, duplicate=true, one write");
}

async function checkSpoof() {
  if (!smokeToken()) {
    skip("spoofed sender", "needs SMOKE_TOKEN; path secret still allows any name until the token flip");
    return;
  }
  if (!smokeBot()) {
    skip("spoofed sender", "set SMOKE_BOT_NAME");
    return;
  }
  const spoof = await callTool("send_message", {
    name: SPOOF_NAME,
    text: `[smoke] spoof probe (should be rejected)`,
    channel: CHANNEL,
    idempotency_key: `smoke-spoof-${Date.now().toString(36)}`,
  });
  const blob = `${spoof.text} ${JSON.stringify(spoof.json ?? {})}`;
  const rejected = spoof.isError && /identity_mismatch|cannot mint/i.test(blob);
  if (rejected) {
    ok("spoofed sender", `rejected as ${SPOOF_NAME}`);
    return;
  }
  if (!spoof.isError && spoof.json?.ok === true) {
    fail("spoofed sender", `token-bound caller posted as ${SPOOF_NAME}; identity gate did not fire`);
    return;
  }
  fail("spoofed sender", `unexpected: ${spoof.text.slice(0, 300)}`);
}

async function startOfflineMock(): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const sent = new Map<string, { id: string; text: string; name: string }>();
  const tools = [...CORE_TOOLS, ...Array.from({ length: MIN_TOOLS }, (_, i) => `offline_${i}`)];
  const server = createServer((req, res) => {
    const url = req.url || "/";
    if (req.method === "GET" && url.startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, reads: { budget: 20000, overBudget: false } }));
      return;
    }
    if (req.method === "POST" && url.startsWith("/mcp")) {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        let rpc: { id?: unknown; method?: string; params?: Record<string, unknown> };
        try { rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }));
          return;
        }
        const toolResult = (obj: unknown, isError = false) => ({
          jsonrpc: "2.0", id: rpc.id, result: { isError, content: [{ type: "text", text: JSON.stringify(obj) }] },
        });
        if (rpc.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: tools.map((name) => ({ name })) } }));
          return;
        }
        if (rpc.method === "tools/call") {
          const params = rpc.params ?? {};
          const name = String(params.name ?? "");
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          if (name === "read_messages") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(toolResult({ messages: [...sent.values()] })));
            return;
          }
          if (name === "send_message") {
            const sender = String(args.name ?? "");
            if (sender === SPOOF_NAME) {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify(toolResult({ error: "identity_mismatch" }, true)));
              return;
            }
            const key = String(args.idempotency_key ?? "");
            const existing = sent.get(key);
            if (existing) {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify(toolResult({ ok: true, duplicate: true, id: existing.id })));
              return;
            }
            const row = { id: `offline-${sent.size + 1}`, text: String(args.text ?? ""), name: sender };
            if (key) sent.set(key, row);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(toolResult({ ok: true, duplicate: false, id: row.id })));
            return;
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("offline mock failed to bind");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

async function main() {
  console.log(`smoke → ${baseUrl()}`);
  await checkHealth();

  if (!smokeToken() && !smokePathSecret()) {
    fail("mcp auth", "set SMOKE_TOKEN (preferred) or SMOKE_PATH_SECRET, plus SMOKE_BOT_NAME");
  } else {
    try {
      await checkTools();
      await checkRoundTripAndIdempotency();
      await checkSpoof();
    } catch (e) {
      fail("mcp", e instanceof Error ? e.message : String(e));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failures.length) {
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
}

if (process.env.SMOKE_OFFLINE === "1") {
  const mock = await startOfflineMock();
  process.env.SMOKE_BASE_URL = mock.url;
  process.env.SMOKE_TOKEN = process.env.SMOKE_TOKEN?.trim() || "offline-smoke-token-16ch";
  process.env.SMOKE_BOT_NAME = process.env.SMOKE_BOT_NAME?.trim() || "whisper";
  console.log(`smoke offline mock → ${mock.url}`);
  try { await main(); }
  finally { await mock.close(); }
} else {
  await main();
}
