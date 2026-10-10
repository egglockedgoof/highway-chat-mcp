import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bearerToken, parseMessagesQuery, parseTasksQuery, parseNotifyPayload,
  createSiteBus, createSiteApi, startPgListen, SITE_SSE_MAX,
} from "../dist/site-api.js";

test("bearerToken reads a single Bearer value", () => {
  assert.equal(bearerToken({ header: () => undefined }), null);
  assert.equal(bearerToken({ header: () => "Basic x" }), null);
  assert.equal(bearerToken({ header: () => "Bearer tok-1" }), "tok-1");
});

test("parseMessagesQuery defaults and rejects bad input", () => {
  assert.deepEqual(parseMessagesQuery({}), { ok: true, channel: "room", limit: 20, since_ts: undefined, mention: undefined });
  assert.equal(parseMessagesQuery({ channel: "lobby" }).ok, false);
  assert.equal(parseMessagesQuery({ limit: "0" }).ok, false);
  assert.equal(parseMessagesQuery({ since_ts: "nope" }).ok, false);
  assert.deepEqual(parseMessagesQuery({ channel: "code", limit: "5", since_ts: "100", mention: "Nyx" }), {
    ok: true, channel: "code", limit: 5, since_ts: 100, mention: "Nyx",
  });
});

test("parseTasksQuery include_done", () => {
  assert.deepEqual(parseTasksQuery({}), { ok: true, limit: 30, include_done: true });
  assert.deepEqual(parseTasksQuery({ include_done: "false", limit: "10" }), { ok: true, limit: 10, include_done: false });
  assert.equal(parseTasksQuery({ include_done: "maybe" }).ok, false);
});

test("parseNotifyPayload accepts typed JSON only", () => {
  assert.equal(parseNotifyPayload("not-json"), null);
  assert.equal(parseNotifyPayload("{}"), null);
  assert.deepEqual(parseNotifyPayload('{"type":"messages","channel":"room"}'), { type: "messages", channel: "room" });
});

test("site bus fans out and refuses over the soft cap", () => {
  const bus = createSiteBus(2);
  const a: unknown[] = [];
  const b: unknown[] = [];
  const ua = bus.subscribe((e) => a.push(e));
  const ub = bus.subscribe((e) => b.push(e));
  assert.ok(ua && ub);
  assert.equal(bus.subscribe(() => {}), null);
  bus.publish({ type: "messages", channel: "room" });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  ua();
  assert.equal(bus.size(), 1);
  assert.equal(SITE_SSE_MAX, 150);
});

function mockRes() {
  const out: { status: number; body?: unknown; headers: Record<string, string>; chunks: string[] } = {
    status: 200, headers: {}, chunks: [],
  };
  const res = {
    headersSent: false,
    status(n: number) { out.status = n; return res; },
    json(body: unknown) { out.body = body; },
    setHeader(k: string, v: string) { out.headers[k] = v; },
    write(chunk: string) { out.chunks.push(chunk); },
    end() {},
  };
  return { res, out };
}

function mockReq(auth?: string, query: Record<string, unknown> = {}) {
  let onClose: (() => void) | undefined;
  return {
    req: {
      header: (n: string) => n.toLowerCase() === "authorization" ? auth : undefined,
      query,
      on(_e: "close", fn: () => void) { onClose = fn; },
    },
    close() { onClose?.(); },
  };
}

const extras = {
  readPresence: async () => [{ id: "p1", name: "sin" }],
  readTyping: async () => [],
  readNotes: async () => ({ content: "hi", updatedBy: "sin", ts: 1 }),
  readActivity: async () => [{ id: "a1", text: "x" }],
};

test("API refuses missing and invalid tokens", async () => {
  const api = createSiteApi({
    verifyToken: async () => null,
    readMessages: async () => ({ count: 0, messages: [], newest_ts: null }),
    readTasks: async () => ({ count: 0, open: 0, tasks: [] }),
    ...extras,
    bus: createSiteBus(),
  });
  const missing = mockRes();
  await api.messages(mockReq().req, missing.res);
  assert.equal(missing.out.status, 401);
  const bad = mockRes();
  await api.messages(mockReq("Bearer x").req, bad.res);
  assert.equal(bad.out.status, 401);
});

test("API serves messages and tasks after a valid token", async () => {
  const api = createSiteApi({
    verifyToken: async (t) => t === "good" ? { localId: "u1" } : null,
    readMessages: async (q) => ({ count: 1, messages: [{ id: "m1", channel: q.channel }], newest_ts: 9, cached: true }),
    readTasks: async () => ({ count: 1, open: 1, tasks: [{ id: "t1" }] }),
    ...extras,
    bus: createSiteBus(),
  });
  const msgs = mockRes();
  await api.messages(mockReq("Bearer good", { channel: "code" }).req, msgs.res);
  assert.equal(msgs.out.status, 200);
  assert.deepEqual(msgs.out.body, { ok: true, count: 1, messages: [{ id: "m1", channel: "code" }], newest_ts: 9, cached: true });
  const tasks = mockRes();
  await api.tasks(mockReq("Bearer good").req, tasks.res);
  assert.equal(tasks.out.status, 200);
  assert.equal((tasks.out.body as { open: number }).open, 1);
});

test("SSE writes events and unsubscribes on close; 503 when full", async () => {
  const bus = createSiteBus(1);
  const api = createSiteApi({
    verifyToken: async () => ({ localId: "u1" }),
    readMessages: async () => ({ count: 0, messages: [], newest_ts: null }),
    readTasks: async () => ({ count: 0, open: 0, tasks: [] }),
    ...extras,
    bus,
  });
  const a = mockReq("Bearer t");
  const ar = mockRes();
  await api.stream(a.req, ar.res);
  assert.equal(ar.out.headers["Content-Type"], "text/event-stream");
  bus.publish({ type: "messages", channel: "room", items: [{ id: "n" }] });
  assert.match(ar.out.chunks.join(""), /data: .*n/);
  const full = mockRes();
  await api.stream(mockReq("Bearer t").req, full.res);
  assert.equal(full.out.status, 503);
  a.close();
  assert.equal(bus.size(), 0);
});

test("presence/notes require a token and return items", async () => {
  const api = createSiteApi({
    verifyToken: async (t) => t === "good" ? { localId: "u1" } : null,
    readMessages: async () => ({ count: 0, messages: [], newest_ts: null }),
    readTasks: async () => ({ count: 0, open: 0, tasks: [] }),
    ...extras,
    bus: createSiteBus(),
  });
  const no = mockRes();
  await api.presence(mockReq().req, no.res);
  assert.equal(no.out.status, 401);
  const ok = mockRes();
  await api.presence(mockReq("Bearer good").req, ok.res);
  assert.equal(ok.out.status, 200);
  assert.deepEqual((ok.out.body as { items: unknown[] }).items, [{ id: "p1", name: "sin" }]);
  const notes = mockRes();
  await api.notes(mockReq("Bearer good").req, notes.res);
  assert.equal((notes.out.body as { notes: { content: string } }).notes.content, "hi");
});

test("startPgListen opens one LISTEN and fans payloads; empty url fails closed", async () => {
  const events: string[] = [];
  let notified: ((msg: unknown) => void) | undefined;
  const client = {
    connect: async () => {},
    query: async (sql: string) => { events.push(sql); },
    on(event: string, fn: (arg: unknown) => void) { if (event === "notification") notified = fn; },
    end: async () => { events.push("end"); },
  };
  await assert.rejects(() => startPgListen({
    url: "  ", connect: () => client, onPayload: () => {}, onError: () => { throw new Error("no"); },
  }), /DATABASE_URL empty/);
  const { stop } = await startPgListen({
    url: "postgres://local",
    connect: (url) => { events.push(url); return client; },
    onPayload: (raw) => { events.push(`p:${raw}`); },
    onError: (e) => { throw e; },
  });
  notified?.({ payload: '{"type":"tasks"}' });
  await stop();
  assert.deepEqual(events, ["postgres://local", "LISTEN highway_events", "p:{\"type\":\"tasks\"}", "end"]);
});
