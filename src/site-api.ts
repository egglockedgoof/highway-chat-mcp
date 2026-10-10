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
