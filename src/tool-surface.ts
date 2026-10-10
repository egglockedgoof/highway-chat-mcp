/**
 * Canonical MCP core-tool surface and send_message client bind.
 *
 * tools/list on the live bridge is this list plus any skill_* entries.
 * Grok/xAI app caches that still describe a ~26-tool subset are stale;
 * re-import from tools/list (or this module) after deploy.
 *
 * rook and ember must send idempotency_key (and reply_to when threading).
 * Legacy aliases are rejected, never remapped.
 */

export const CORE_TOOLS = [
  "read_messages",
  "send_message",
  "send_voice",
  "route_task",
  "edit_message",
  "delete_message",
  "react_to_message",
  "search_messages",
  "pin_message",
  "read_pinned",
  "set_presence",
  "get_presence",
  "set_typing",
  "save_milestone",
  "recall_context",
  "store_preference",
  "log_correction",
  "remember",
  "recall",
  "dream",
  "reflect",
  "record_lesson",
  "orient",
  "propose_skill",
  "review_skill",
  "list_skills",
  "log_activity",
  "read_activity",
  "read_tasks",
  "add_task",
  "complete_task",
  "update_task",
  "delete_task",
  "assign_task",
  "read_notes",
  "update_notes",
  "append_note",
  "get_news",
  "post_curated_batch",
  "get_team",
  "get_stats",
  "get_time",
  "extract_site_schema",
  "diff_check_page",
  "monitor_rss_stream",
  "condense_session_logs",
  "dispatch_ambient_tts",
  "mutate_environment_relay",
  "query_pattern_refinery",
  "store_pattern_win",
  "web_search",
  "fetch_page_text",
  "propose_patch",
  "request_approval",
  "resolve_approval",
  "get_approval_status",
  "score_lead",
  "get_crypto_price",
  "track_tool_telemetry",
  "dedupe_leads",
  "check_bridge_health",
  "get_weather",
  "summarize_thread",
] as const;

export type CoreTool = (typeof CORE_TOOLS)[number];

/** Clients that may not post without the phase-3 send fields. */
export const SEND_BIND_CLIENTS = ["rook", "ember"] as const;

/** Old field names. Rejected; never copied onto the canonical key. */
export const SEND_LEGACY_FIELDS: Record<string, "reply_to" | "idempotency_key"> = {
  replyTo: "reply_to",
  in_reply_to: "reply_to",
  thread_id: "reply_to",
  parent_id: "reply_to",
  idempotencyKey: "idempotency_key",
  idempotency: "idempotency_key",
};

/** Quoted `tool(server, "name"` registrations. Dynamic skill_* tools are not listed. */
export function listedCoreTools(source: string): string[] {
  if (typeof source !== "string" || !source.trim()) return [];
  return [...source.matchAll(/tool\(\s*server\s*,\s*"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
}

export function isSendBindClient(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (SEND_BIND_CLIENTS as readonly string[]).includes(n);
}

export type ClientSend = {
  name: string;
  text: string;
  channel?: string;
  reply_to?: string;
  routed_to?: string;
  idempotency_key?: string;
};

function strField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Canonical send_message payload for rook/ember (and a fail-closed gate for everyone).
 * Unbound clients may omit idempotency_key and reply_to. Bound clients may omit
 * reply_to only for a new post; they cannot omit idempotency_key.
 */
export function bindClientSend(raw: unknown): ClientSend {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("send_message expects an object");
  }
  const o = raw as Record<string, unknown>;
  for (const [legacy, canonical] of Object.entries(SEND_LEGACY_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(o, legacy) && o[legacy] !== undefined) {
      throw new Error(`send_message: "${legacy}" is not supported; use ${canonical}`);
    }
  }
  const name = strField(o, "name");
  const text = strField(o, "text");
  if (!name) throw new Error("send_message: name is required");
  if (!text) throw new Error("send_message: text is required");

  const out: ClientSend = { name, text };
  const channel = strField(o, "channel");
  if (channel) out.channel = channel;
  const routed = strField(o, "routed_to");
  if (routed) out.routed_to = routed;

  const reply = strField(o, "reply_to");
  if ("reply_to" in o && o.reply_to !== undefined) {
    if (!reply) throw new Error("send_message: reply_to must be a non-empty message id");
    out.reply_to = reply;
  }
  const idem = strField(o, "idempotency_key");
  if ("idempotency_key" in o && o.idempotency_key !== undefined) {
    if (!idem) throw new Error("send_message: idempotency_key must be a non-empty key");
    out.idempotency_key = idem;
  }

  if (isSendBindClient(name) && !out.idempotency_key) {
    throw new Error(`send_message: ${name} requires idempotency_key`);
  }
  return out;
}

/** Raw `tools/call` arguments for send_message, or undefined for every other RPC. */
export function sendMessageRpcArgs(body: unknown): unknown | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const b = body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (b.method !== "tools/call" || b.params?.name !== "send_message") return undefined;
  return b.params.arguments ?? {};
}

/** Error text when a send_message RPC must fail closed; null to pass through. */
export function gateSendMessageRpc(body: unknown): string | null {
  const args = sendMessageRpcArgs(body);
  if (args === undefined) return null;
  try {
    bindClientSend(args);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
