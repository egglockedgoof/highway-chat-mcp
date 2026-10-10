#!/usr/bin/env node
/**
 * Post-deploy smoke against the live bridge.
 *
 *   SMOKE_TOKEN=... SMOKE_BOT_NAME=whisper npm run smoke
 *
 * Imports only src/tool-surface.ts (the core-tool catalog). Live checks
 * are GET /health + MCP JSON-RPC. Writes one tagged [smoke] message on
 * the code channel (idempotent).
 */
import { CORE_TOOLS } from "../src/tool-surface.ts";

const BASE = (process.env.SMOKE_BASE_URL || "https://highway-chat-mcp.onrender.com").replace(/\/$/, "");
const TOKEN = process.env.SMOKE_TOKEN?.trim() || "";
const PATH_SECRET = process.env.SMOKE_PATH_SECRET?.trim() || "";
const BOT = process.env.SMOKE_BOT_NAME?.trim() || "";
const CHANNEL = process.env.SMOKE_CHANNEL?.trim() || "code";
const TIMEOUT_MS = 20_000;
const MIN_TOOLS = CORE_TOOLS.length;
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
    const res = await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal });
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
  if (TOKEN) return "/mcp";
  if (PATH_SECRET) return `/mcp/${encodeURIComponent(PATH_SECRET)}`;
  throw new Error("set SMOKE_TOKEN (preferred) or SMOKE_PATH_SECRET");
}

function mcpHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-03-26",
  };
  if (TOKEN) h.authorization = `Bearer ${TOKEN}`;
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
  if (!BOT) {
    skip("read round-trip", "set SMOKE_BOT_NAME");
    skip("duplicate-key", "set SMOKE_BOT_NAME");
    return;
  }
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `smoke-${stamp}`;
  const text = `[smoke] env-check ${stamp} (safe to ignore)`;

  const first = await callTool("send_message", {
    name: BOT, text, channel: CHANNEL, idempotency_key: key,
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
    name: BOT, text, channel: CHANNEL, idempotency_key: key,
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
  if (!TOKEN) {
    skip("spoofed sender", "needs SMOKE_TOKEN; path secret still allows any name until the token flip");
    return;
  }
  if (!BOT) {
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

async function main() {
  console.log(`smoke → ${BASE}`);
  await checkHealth();

  if (!TOKEN && !PATH_SECRET) {
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

await main();
