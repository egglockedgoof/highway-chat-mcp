// Thin site API: REST + SSE. The browser talks to the bridge only.
// One Postgres LISTEN (when DATABASE_URL is set) fans out to SSE clients.
// Soft cap SITE_SSE_MAX so we stay under 150/200 realtime connections.

export const SITE_SSE_MAX = 150;
export const PG_NOTIFY_CHANNEL = "highway_events";
export const SITE_CHANNELS = ["room", "code", "dm"] as const;

export type SiteChannel = (typeof SITE_CHANNELS)[number];
export type SiteUser = { localId: string; email?: string };
export type SiteEvent = { type: string; channel?: string; items?: unknown[] };

export interface SiteReq {
  header(name: string): string | undefined;
  query: Record<string, unknown>;
  body?: unknown;
  params?: Record<string, string>;
  on(event: "close", fn: () => void): void;
}

export interface SiteRes {
  status(n: number): SiteRes;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  write(chunk: string): boolean | void;
  end(): void;
  headersSent: boolean;
}

export function bearerToken(req: Pick<SiteReq, "header">): string | null {
  const m = /^Bearer (.+)$/.exec(req.header("authorization") || "");
  return m?.[1] ?? null;
}

export function qstr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

export function parseIntQuery(v: string | undefined, fallback: number, min: number, max: number): number | null {
  if (v === undefined || v === "") return fallback;
  if (!/^-?\d+$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export function parseMessagesQuery(query: Record<string, unknown>):
  | { ok: true; channel: SiteChannel; limit: number; since_ts?: number; mention?: string }
  | { ok: false; error: string } {
  const channel = qstr(query.channel) ?? "room";
  if (!(SITE_CHANNELS as readonly string[]).includes(channel))
    return { ok: false, error: "channel must be room, code, or dm" };
  const limit = parseIntQuery(qstr(query.limit), 20, 1, 50);
  if (limit === null) return { ok: false, error: "limit must be an integer 1-50" };
  const sinceRaw = qstr(query.since_ts);
  let since_ts: number | undefined;
  if (sinceRaw !== undefined && sinceRaw !== "") {
    const n = parseIntQuery(sinceRaw, -1, 0, Number.MAX_SAFE_INTEGER);
    if (n === null) return { ok: false, error: "since_ts must be a unix-ms integer" };
    since_ts = n;
  }
  const mention = qstr(query.mention)?.trim();
  if (mention !== undefined && (mention.length < 1 || mention.length > 40))
    return { ok: false, error: "mention must be 1-40 chars" };
  return { ok: true, channel: channel as SiteChannel, limit, since_ts, mention: mention || undefined };
}

export function parseTasksQuery(query: Record<string, unknown>):
  | { ok: true; limit: number; include_done: boolean }
  | { ok: false; error: string } {
  const limit = parseIntQuery(qstr(query.limit), 30, 1, 100);
  if (limit === null) return { ok: false, error: "limit must be an integer 1-100" };
  const raw = (qstr(query.include_done) ?? "true").toLowerCase();
  if (raw !== "true" && raw !== "false" && raw !== "1" && raw !== "0")
    return { ok: false, error: "include_done must be true or false" };
  return { ok: true, limit, include_done: raw === "true" || raw === "1" };
}

// ---- POST body parsing helpers ----

export function bodyObj(req: SiteReq): Record<string, unknown> | null {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  return b as Record<string, unknown>;
}

export function bstr(v: unknown, maxLen = 5000): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t || t.length > maxLen) return undefined;
  return t;
}

export function bbool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

export function bstrOpt(v: unknown, maxLen = 5000): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return bstr(v, maxLen);
}

export function parseNotifyPayload(raw: string): SiteEvent | null {
  let v: unknown;
  try { v = JSON.parse(raw); }
  catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const type = (v as { type?: unknown }).type;
  if (typeof type !== "string" || !type) return null;
  return v as SiteEvent;
}

export function createSiteBus(maxSse = SITE_SSE_MAX) {
  const clients = new Set<(e: SiteEvent) => void>();
  return {
    max: maxSse,
    size() { return clients.size; },
    publish(e: SiteEvent) {
      for (const fn of clients) fn(e);
    },
    subscribe(fn: (e: SiteEvent) => void): (() => void) | null {
      if (clients.size >= maxSse) return null;
      clients.add(fn);
      return () => { clients.delete(fn); };
    },
  };
}

export type SiteBus = ReturnType<typeof createSiteBus>;

export interface PgListenClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  on(event: "notification" | "error", fn: (arg: unknown) => void): void;
  end(): Promise<void>;
}

export async function startPgListen(opts: {
  url: string;
  channel?: string;
  connect: (url: string) => PgListenClient;
  onPayload: (raw: string) => void;
  onError: (e: unknown) => void;
}): Promise<{ stop: () => Promise<void> }> {
  if (!opts.url.trim()) throw new Error("DATABASE_URL empty");
  const channel = opts.channel ?? PG_NOTIFY_CHANNEL;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(channel)) throw new Error("bad notify channel");
  const client = opts.connect(opts.url);
  client.on("notification", (msg) => {
    const payload = (msg as { payload?: unknown })?.payload;
    if (typeof payload === "string") opts.onPayload(payload);
  });
  client.on("error", opts.onError);
  await client.connect();
  await client.query(`LISTEN ${channel}`);
  return { stop: () => client.end() };
}

export interface SiteApiDeps {
  verifyToken: (token: string) => Promise<SiteUser | null>;
  readMessages: (q: { channel: SiteChannel; limit: number; since_ts?: number; mention?: string }) => Promise<{
    count: number; messages: unknown[]; newest_ts: number | null; cached?: boolean;
  }>;
  readTasks: (q: { limit: number; include_done: boolean }) => Promise<{
    count: number; open: number; tasks: unknown[];
  }>;
  readPresence: () => Promise<unknown[]>;
  readTyping: () => Promise<unknown[]>;
  readNotes: () => Promise<unknown | null>;
  readActivity: (limit: number) => Promise<unknown[]>;
  writeMessage: (input: {
    name: string; text?: string; image?: string; channel?: string;
    deviceId?: string; reply_to?: string; attachments?: unknown[];
  }) => Promise<{ id: string }>;
  writePresence: (input: { id: string; name: string; platform?: string; session?: string }) => Promise<void>;
  writeTyping: (input: { id: string; name: string; typing: boolean }) => Promise<void>;
  writeTask: (input: { text: string; done?: boolean; createdBy?: string }) => Promise<{ id: string }>;
  patchTask: (id: string, patch: { done?: boolean; text?: string }) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  writeActivity: (input: { by: string; text: string }) => Promise<{ id: string }>;
  writeNotes: (input: { content: string; updatedBy?: string }) => Promise<void>;
  bus: SiteBus;
}

async function requireUser(req: SiteReq, res: SiteRes, verify: SiteApiDeps["verifyToken"]): Promise<SiteUser | null> {
  const token = bearerToken(req);
  if (!token) { res.status(401).json({ ok: false, error: "missing bearer token" }); return null; }
  const who = await verify(token);
  if (!who) { res.status(401).json({ ok: false, error: "invalid token" }); return null; }
  return who;
}

export function createSiteApi(deps: SiteApiDeps) {
  return {
    async messages(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      const q = parseMessagesQuery(req.query);
      if (!q.ok) { res.status(400).json({ ok: false, error: q.error }); return; }
      try {
        const body = await deps.readMessages(q);
        res.status(200).json({ ok: true, ...body });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    async tasks(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      const q = parseTasksQuery(req.query);
      if (!q.ok) { res.status(400).json({ ok: false, error: q.error }); return; }
      try {
        const body = await deps.readTasks(q);
        res.status(200).json({ ok: true, ...body });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    async presence(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      try { res.status(200).json({ ok: true, items: await deps.readPresence() }); }
      catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
    },
    async typing(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      try { res.status(200).json({ ok: true, items: await deps.readTyping() }); }
      catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
    },
    async notes(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      try { res.status(200).json({ ok: true, notes: await deps.readNotes() }); }
      catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
    },
    async activity(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      const limit = parseIntQuery(qstr(req.query.limit), 30, 1, 100);
      if (limit === null) { res.status(400).json({ ok: false, error: "limit must be an integer 1-100" }); return; }
      try { res.status(200).json({ ok: true, items: await deps.readActivity(limit) }); }
      catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
    },
    async postMessage(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      const b = bodyObj(req);
      if (!b) { res.status(400).json({ ok: false, error: "expected JSON body" }); return; }
      const name = bstr(b.name, 40);
      if (!name) { res.status(400).json({ ok: false, error: "name is required (1-40 chars)" }); return; }
      const text = bstrOpt(b.text);
      const image = bstrOpt(b.image, 2000000);
      if (!text && !image) { res.status(400).json({ ok: false, error: "text or image is required" }); return; }
      const channel = bstrOpt(b.channel, 10);
      if (channel && !(SITE_CHANNELS as readonly string[]).includes(channel)) {
        res.status(400).json({ ok: false, error: "channel must be room, code, or dm" }); return;
      }
      try {
        const result = await deps.writeMessage({
          name,
          ...(text ? { text } : {}),
          ...(image ? { image } : {}),
          ...(channel ? { channel } : {}),
          ...(bstrOpt(b.deviceId, 80) ? { deviceId: bstr(b.deviceId, 80)! } : {}),
          ...(bstrOpt(b.reply_to, 80) ? { reply_to: bstr(b.reply_to, 80)! } : {}),
          ...(Array.isArray(b.attachments) ? { attachments: b.attachments } : {}),
        });
        res.status(200).json({ ok: true, id: result.id });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    async postPresence(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      const b = bodyObj(req);
      if (!b) { res.status(400).json({ ok: false, error: "expected JSON body" }); return; }
      const id = bstr(b.id, 80);
      const name = bstr(b.name, 40);
      if (!id || !name) { res.status(400).json({ ok: false, error: "id and name are required" }); return; }
      try {
        await deps.writePresence({
          id, name,
          ...(bstrOpt(b.platform, 40) ? { platform: bstr(b.platform, 40)! } : {}),
          ...(bstrOpt(b.session, 80) ? { session: bstr(b.session, 80)! } : {}),
        });
        res.status(200).json({ ok: true });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    async postTyping(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      const b = bodyObj(req);
      if (!b) { res.status(400).json({ ok: false, error: "expected JSON body" }); return; }
      const id = bstr(b.id, 80);
      const name = bstr(b.name, 40);
      const typing = bbool(b.typing);
      if (!id || !name || typing === undefined) {
        res.status(400).json({ ok: false, error: "id, name, and typing (boolean) are required" }); return;
      }
      try {
        await deps.writeTyping({ id, name, typing });
        res.status(200).json({ ok: true });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    async postTask(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      const b = bodyObj(req);
      if (!b) { res.status(400).json({ ok: false, error: "expected JSON body" }); return; }
      const text = bstr(b.text, 500);
      if (!text) { res.status(400).json({ ok: false, error: "text is required (1-500 chars)" }); return; }
      try {
        const result = await deps.writeTask({
          text,
          ...(bbool(b.done) !== undefined ? { done: bbool(b.done)! } : {}),
          ...(bstrOpt(b.createdBy, 40) ? { createdBy: bstr(b.createdBy, 40)! } : {}),
        });
        res.status(200).json({ ok: true, id: result.id });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    async patchTask(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      const id = req.params?.id?.trim();
      if (!id) { res.status(400).json({ ok: false, error: "task id is required" }); return; }
      const b = bodyObj(req);
      if (!b) { res.status(400).json({ ok: false, error: "expected JSON body" }); return; }
      const patch: { done?: boolean; text?: string } = {};
      if (bbool(b.done) !== undefined) patch.done = bbool(b.done)!;
      const text = bstrOpt(b.text, 500);
      if (text) patch.text = text;
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ ok: false, error: "nothing to update (done and/or text)" }); return;
      }
      try {
        await deps.patchTask(id, patch);
        res.status(200).json({ ok: true, id });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    async deleteTask(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      const id = req.params?.id?.trim();
      if (!id) { res.status(400).json({ ok: false, error: "task id is required" }); return; }
      try {
        await deps.deleteTask(id);
        res.status(200).json({ ok: true, id });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    async postActivity(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      const b = bodyObj(req);
      if (!b) { res.status(400).json({ ok: false, error: "expected JSON body" }); return; }
      const by = bstr(b.by, 40);
      const text = bstr(b.text, 500);
      if (!by || !text) { res.status(400).json({ ok: false, error: "by and text are required" }); return; }
      try {
        const result = await deps.writeActivity({ by, text });
        res.status(200).json({ ok: true, id: result.id });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    async postNotes(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      const b = bodyObj(req);
      if (!b) { res.status(400).json({ ok: false, error: "expected JSON body" }); return; }
      if (typeof b.content !== "string" || b.content.length > 20000) {
        res.status(400).json({ ok: false, error: "content is required (string, max 20000 chars)" }); return;
      }
      try {
        await deps.writeNotes({
          content: b.content,
          ...(bstrOpt(b.updatedBy, 40) ? { updatedBy: bstr(b.updatedBy, 40)! } : {}),
        });
        res.status(200).json({ ok: true });
      } catch (e) {
        res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    async stream(req: SiteReq, res: SiteRes): Promise<void> {
      if (!(await requireUser(req, res, deps.verifyToken))) return;
      const unsub = deps.bus.subscribe((e) => {
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      });
      if (!unsub) { res.status(503).json({ ok: false, error: "sse_full" }); return; }
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.write(": ok\n\n");
      req.on("close", unsub);
    },
  };
}
