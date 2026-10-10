// blockers.test.ts — regression tests for hollow's Phase 3 blockers (#34–#37).
//
// Run:  cd ~/workspace/highway-chat-mcp && npm run build && node --test src/blockers.test.ts
// Imports the COMPILED modules (../dist/*.js) — index.ts's sibling imports use
// .js specifiers, which only resolve after tsc emits. Zero live calls — the
// security.ts transport is mocked and index.ts helpers take injected io.
//
// The suite imports the repo files (../dist/security.js, ../dist/index.js) with
// dummy env plus PHASE3_TEST set before the dynamic imports below, so no port
// binds and no timers arm.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FIREBASE_API_KEY ??= 'test-key';
process.env.MCP_SECRET ??= 'test-secret';
process.env.HIGHWAY_CLIENT_KEY ??= 'test-client-key';
process.env.BOT_CREDENTIALS ??= '{}';
process.env.PHASE3_TEST ??= '1';

const sec = await import('../dist/security.js');
const idx = await import('../dist/index.js');

// ---------------------------------------------------------------- #34 helpers

const noAuthReq = { headersDistinct: {}, rawHeaders: [] };

function authDeps(over: any = {}) {
  return {
    config: { mcpCallers: {}, legacySecret: 's3cret-path', legacyEnabled: true },
    isSunset: () => false,
    count: (_n: string) => {},
    ...over,
  };
}

// Mocked Firestore transport for createSecurity: GET → doc missing (404), PATCH →
// 200 with updateTime, or fail per behavior. Mirrors the shapes MockFirestore uses.
function makeSecTransport(behavior: { failPatch?: boolean } = {}) {
  const calls: Array<{ method: string; url: string }> = [];
  const request = async (method: string, url: string, _opts: any) => {
    calls.push({ method, url });
    if (method === 'GET') {
      return { status: 404, body: { error: { code: 404, status: 'NOT_FOUND', message: 'not found' } } };
    }
    if (method === 'PATCH') {
      if (behavior.failPatch) {
        return { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'down' } } };
      }
      return { status: 200, body: { updateTime: '2026-10-09T13:00:00.000Z' } };
    }
    return { status: 200, body: {} };
  };
  const s = sec.createSecurity(
    {
      baseUrl: 'https://firestore.example.invalid/v1/projects/p/databases/(default)/documents',
      fsTimeoutMs: 5000,
      readBot: 'whisper',
      isSunset: () => false,
      request,
      getIdToken: async () => 'fake-token',
      now: () => new Date().toISOString(),
    },
    {
      instanceId: 'test',
      instanceStartedAt: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString(),
      quietWindowMs: 14 * 24 * 3600 * 1000,
      boundWriteThroughMs: 3600 * 1000,
    },
    { mcpCallers: {}, legacySecret: 'x', legacyEnabled: true },
  );
  return { s, calls };
}

// ---------------------------------------------------------------- #34

test('#34a auth path returns before the legacy signal resolves (fire-and-forget)', async () => {
  let signalStarted = false;
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const resolveAuth = sec.createResolveAuth(authDeps({
    recordLegacySignal: (_m: string) => { signalStarted = true; return gate; },
  }));
  const res = await Promise.race([
    resolveAuth(noAuthReq, '/mcp/s3cret-path'),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('REGRESSION #34: resolveAuth blocked awaiting the legacy signal')), 2000)),
  ]) as any;
  assert.equal(res.kind, 'ctx');
  assert.equal(res.ctx.method, 'path_legacy');
  assert.equal(signalStarted, true, 'the signal must still be recorded — just not awaited');
  release();
  await gate;
});

test('#34b legacy signal rejection does not fail auth (caught fire-and-forget)', async () => {
  const resolveAuth = sec.createResolveAuth(authDeps({
    recordLegacySignal: async (_m: string) => { throw new Error('firestore down'); },
  }));
  const res = await resolveAuth(noAuthReq, '/mcp/s3cret-path');
  assert.equal(res.kind, 'ctx', 'auth succeeds even when the signal write fails');
  await new Promise((r) => setTimeout(r, 50)); // let the rejection settle — no unhandled rejection may surface
});

test('#34c signal write failure stays pending for flush (bound write-through, never throws)', async () => {
  const { s } = makeSecTransport({ failPatch: true });
  await s.telemetry.recordLegacySignal('path_legacy'); // must NOT throw
  assert.deepEqual(s.telemetry.tracker.pendingBots(), ['legacy:path_legacy'],
    'failed signal stays pending — the batch flush reconciles it (lesson #31)');
});

test('#34d signal write success marks durable (pending cleared)', async () => {
  const { s, calls } = makeSecTransport();
  await s.telemetry.recordLegacySignal('path_legacy');
  assert.deepEqual(s.telemetry.tracker.pendingBots(), [], 'durable write clears the pending entry');
  assert.ok(calls.some((c) => c.method === 'PATCH'), 'the recorder still performs the durable write');
});

// ---------------------------------------------------------------- #35

test('#35a idemDocId is deterministic, channel-scoped, and key-sensitive', () => {
  assert.equal(idx.idemDocId('room', 'k1'), idx.idemDocId('room', 'k1'));
  assert.notEqual(idx.idemDocId('room', 'k1'), idx.idemDocId('dm', 'k1'), 'channel is part of the id');
  assert.notEqual(idx.idemDocId('room', 'k1'), idx.idemDocId('room', 'k2'), 'key is part of the id');
  assert.match(idx.idemDocId('room', 'k1'), /^idem_[0-9a-f]{32}$/);
  assert.ok(!idx.idemDocId('room', 'k1').includes('/'), 'doc id is path-safe');
});

test('#35b same key twice → second is duplicate, exactly one write', async () => {
  const store = new Map<string, any>();
  let writes = 0;
  const io = {
    getDoc: async (c: string, d: string) => store.get(`${c}/${d}`) ?? null,
    createDoc: async (c: string, d: string, body: any) => {
      writes++;
      store.set(`${c}/${d}`, { name: `${c}/${d}`, fields: body.fields });
    },
  };
  const body = { fields: { text: { stringValue: 'hi' } } };
  const docId = idx.idemDocId('room', 'k9');
  const r1 = await idx.writeIdempotent('highway_messages', docId, body, 'whisper', io);
  const r2 = await idx.writeIdempotent('highway_messages', docId, body, 'whisper', io);
  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);
  assert.equal(r1.id, r2.id);
  assert.equal(writes, 1, 'the key drove a check-before-write: one write total');
});

test('#35c lost write race (create-only contention) → duplicate, not error', async () => {
  const io = {
    getDoc: async (_c: string, _d: string) => null, // check saw nothing…
    createDoc: async (_c: string, _d: string, _body: any) => {
      throw new idx.FirestoreError(409, 'ALREADY_EXISTS', 'doc already exists'); // …but the race was lost
    },
  };
  const r = await idx.writeIdempotent('highway_messages', 'idem_x', { fields: {} }, 'whisper', io);
  assert.equal(r.duplicate, true, 'the other writer won — report duplicate, not error');
});

test('#35d non-contention write error still throws', async () => {
  const io = {
    getDoc: async (_c: string, _d: string) => null,
    createDoc: async (_c: string, _d: string, _body: any) => { throw new Error('boom'); },
  };
  await assert.rejects(() => idx.writeIdempotent('c', 'd', { fields: {} }, 'w', io), /boom/);
});

// ---------------------------------------------------------------- #36

test('#36 lock check is explicitly advisory (tripwire flag on every result)', async () => {
  const open = await idx.checkDispatchLock('', 'whisper', async () => null);
  assert.equal(open.advisory, true);
  const routed = await idx.checkDispatchLock('m1', 'grok', async () => ({
    name: 'dispatch_locks/m1',
    fields: { routed_to: { stringValue: 'grok' } },
  }) as any);
  assert.equal(routed.advisory, true);
  assert.equal(routed.allowed, true);
  // If a future change makes the lock binding, it must flip this flag deliberately —
  // silently upgrading advisory→binding breaks this test.
});

// ---------------------------------------------------------------- #37

test('#37a lock-read error fails CLOSED (never unlocked)', async () => {
  const r = await idx.checkDispatchLock('m1', 'grok', async () => {
    throw new Error('quota exhausted');
  });
  assert.equal(r.allowed, false, 'an unreadable lock is a locked lock');
  assert.equal(r.retryable, true, 'the sender should retry, not give up');
  assert.equal(r.advisory, true);
});

test('#37b no lock doc → open (unchanged behavior)', async () => {
  const r = await idx.checkDispatchLock('m1', 'grok', async () => null);
  assert.equal(r.allowed, true);
});

test('#37c routed mismatch blocked; routed agent + whisper bypass intact', async () => {
  const lockDoc = { name: 'dispatch_locks/m1', fields: { routed_to: { stringValue: 'grok' } } } as any;
  const getLock = async () => lockDoc;
  assert.equal((await idx.checkDispatchLock('m1', 'deepseek', getLock)).allowed, false);
  assert.equal((await idx.checkDispatchLock('m1', 'grok', getLock)).allowed, true);
  assert.equal((await idx.checkDispatchLock('m1', 'whisper', getLock)).allowed, true);
  assert.equal((await idx.checkDispatchLock('m1', 'WHISPER', getLock)).allowed, true, 'bypass is case-insensitive');
});

test('#37d expired lock and broadcast → open (unchanged behavior)', async () => {
  const expired = {
    name: 'x',
    fields: {
      routed_to: { stringValue: 'grok' },
      expires_at: { timestampValue: new Date(Date.now() - 60_000).toISOString() },
    },
  } as any;
  assert.equal((await idx.checkDispatchLock('m1', 'deepseek', async () => expired)).allowed, true);
  const bc = { name: 'x', fields: { broadcast: { booleanValue: true } } } as any;
  assert.equal((await idx.checkDispatchLock('m1', 'deepseek', async () => bc)).allowed, true);
});

// ---------------------------------------------------------------- #38
// hollow re-review (2026-10-09): "nothing writes dispatch_locks — lock inert."
// Writer: highway-push/dispatch-lock-writer.js (listener writes the lock on routing,
// dormant behind HIGHWAY_DISPATCH_LOCKS=1). Bridge side: the routed agent's reply
// claims the lock (spec §2 ledger). Claim is ledger-only — never blocks the send.

test('#38a routed reply claims the lock (patch dispatch_locks/{id}, exists:true)', async () => {
  const calls: Array<{ c: string; d: string; f: any }> = [];
  const io = { patch: async (c: string, d: string, f: any, _n?: string) => { calls.push({ c, d, f }); } };
  const ok = await idx.markLockClaimed('m1', 'grok', io);
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].c, 'dispatch_locks');
  assert.equal(calls[0].d, 'm1');
  assert.deepEqual(calls[0].f, { claimed: { booleanValue: true } },
    'only the claimed field is patched — never creates a lock doc from a claim');
});

test('#38b claim never throws: missing lock / write failure → false', async () => {
  const io = { patch: async () => { throw new Error('404 NOT_FOUND'); } };
  assert.equal(await idx.markLockClaimed('nope', 'grok', io), false,
    'a failed claim must not fail the send — the reply already landed');
});

test('#38c checkDispatchLock reports routedTo for the claim decision', async () => {
  const lockDoc = { name: 'dispatch_locks/m1', fields: { routed_to: { stringValue: 'Grok' } } } as any;
  const r = await idx.checkDispatchLock('m1', 'grok', async () => lockDoc);
  assert.equal(r.routedTo, 'grok', 'lowercased routed agent, ready for the claim comparison');
  const open = await idx.checkDispatchLock('m1', 'grok', async () => null);
  assert.equal(open.routedTo, undefined, 'no lock doc = nothing to claim');
});
