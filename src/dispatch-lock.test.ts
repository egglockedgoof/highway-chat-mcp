// dispatch-lock.test.ts — setter, second-dispatcher block, stale expiry, release.
//
// Run:  npm run build && node --test src/dispatch-lock.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FIREBASE_API_KEY ??= 'test-key';
process.env.MCP_SECRET ??= 'test-secret';
process.env.HIGHWAY_CLIENT_KEY ??= 'test-client-key';
process.env.BOT_CREDENTIALS ??= '{}';
process.env.PHASE3_TEST ??= '1';

const idx = await import('../dist/index.js');

function memLockIo() {
  const store = new Map<string, { name: string; fields: Record<string, unknown> }>();
  const key = (c: string, d: string) => `${c}/${d}`;
  const io = {
    get: async (c: string, d: string) => store.get(key(c, d)) ?? null,
    create: async (c: string, d: string, fields: Record<string, unknown>) => {
      const k = key(c, d);
      if (store.has(k)) throw new idx.FirestoreError(409, 'ALREADY_EXISTS', 'exists');
      store.set(k, { name: k, fields: { ...fields } });
    },
    overwrite: async (c: string, d: string, fields: Record<string, unknown>) => {
      const k = key(c, d);
      if (!store.has(k)) throw new idx.FirestoreError(404, 'NOT_FOUND', 'missing');
      store.set(k, { name: k, fields: { ...fields } });
    },
    patch: async (c: string, d: string, fields: Record<string, unknown>) => {
      const k = key(c, d);
      const cur = store.get(k);
      if (!cur) throw new Error('404 NOT_FOUND');
      store.set(k, { name: k, fields: { ...cur.fields, ...fields } });
    },
  };
  return { io, store };
}

const roster = ['grok', 'whisper', 'deepseek', 'ember'];

test('setDispatchLock: first dispatcher acquires; second is blocked while held', async () => {
  const { io } = memLockIo();
  const now = new Date('2026-10-10T07:00:00Z');
  const a = await idx.setDispatchLock('m1', 'grok', 'whisper', { io, now });
  assert.equal(a.ok, true);
  assert.equal(a.acquired, true);
  assert.equal(a.routedTo, 'grok');
  const b = await idx.setDispatchLock('m1', 'deepseek', 'hollow', { io, now });
  assert.equal(b.ok, false);
  assert.equal(b.acquired, false);
  assert.match(b.reason || '', /dispatch-locked to grok/i);
  assert.equal(b.routedTo, 'grok');
  const held = await io.get('dispatch_locks', 'm1');
  assert.equal(held?.fields?.routed_to?.stringValue, 'grok');
  assert.equal(idx.dispatchLockIsHeld(held?.fields, now), true);
});

test('setDispatchLock: stale (expired) lock can be taken by a second dispatcher', async () => {
  const { io } = memLockIo();
  const t0 = new Date('2026-10-10T07:00:00Z');
  const first = await idx.setDispatchLock('m1', 'grok', 'whisper', { io, now: t0, ttlMs: 120_000 });
  assert.equal(first.ok, true);
  const later = new Date(t0.getTime() + 121_000);
  assert.equal(idx.dispatchLockIsHeld((await io.get('dispatch_locks', 'm1'))?.fields, later), false);
  const steal = await idx.setDispatchLock('m1', 'deepseek', 'hollow', { io, now: later });
  assert.equal(steal.ok, true);
  assert.equal(steal.acquired, true);
  assert.equal(steal.routedTo, 'deepseek');
  const held = await io.get('dispatch_locks', 'm1');
  assert.equal(held?.fields?.routed_to?.stringValue, 'deepseek');
  assert.equal(held?.fields?.claimed?.booleanValue, false);
});

test('setDispatchLock: released (claimed) lock can be retaken', async () => {
  const { io } = memLockIo();
  const now = new Date('2026-10-10T07:00:00Z');
  assert.equal((await idx.setDispatchLock('m1', 'grok', 'whisper', { io, now })).ok, true);
  assert.equal(await idx.releaseDispatchLock('m1', 'grok', io), true);
  const after = await io.get('dispatch_locks', 'm1');
  assert.equal(after?.fields?.claimed?.booleanValue, true);
  assert.equal(idx.dispatchLockIsHeld(after?.fields, now), false);
  const again = await idx.setDispatchLock('m1', 'ember', 'whisper', { io, now });
  assert.equal(again.ok, true);
  assert.equal(again.routedTo, 'ember');
});

test('checkDispatchLock: claimed lock is open; unclaimed mismatch stays blocked', async () => {
  const held = {
    name: 'dispatch_locks/m1',
    fields: { routed_to: { stringValue: 'grok' }, claimed: { booleanValue: false } },
  } as any;
  assert.equal((await idx.checkDispatchLock('m1', 'deepseek', async () => held)).allowed, false);
  const released = {
    name: 'dispatch_locks/m1',
    fields: { routed_to: { stringValue: 'grok' }, claimed: { booleanValue: true } },
  } as any;
  assert.equal((await idx.checkDispatchLock('m1', 'deepseek', async () => released)).allowed, true);
});

test('armOutgoingDispatchLock: routed_to wins; single @bot mention locks; two bots skip', async () => {
  const { io } = memLockIo();
  const a = await idx.armOutgoingDispatchLock('n1', 'please look', 'whisper', 'Grok', roster, io);
  assert.equal(a?.ok, true);
  assert.equal(a?.routedTo, 'grok');
  const b = await idx.armOutgoingDispatchLock('n2', '@deepseek handle this', 'whisper', undefined, roster, io);
  assert.equal(b?.ok, true);
  assert.equal(b?.routedTo, 'deepseek');
  const c = await idx.armOutgoingDispatchLock('n3', '@grok and @ember both look', 'whisper', undefined, roster, io);
  assert.equal(c, null);
  const d = await idx.armOutgoingDispatchLock('n4', 'no mention here', 'whisper', undefined, roster, io);
  assert.equal(d, null);
});

test('directMentionTarget is whitespace-anchored (not emails) and roster-gated', () => {
  assert.equal(idx.directMentionTarget('@grok ship it', roster), 'grok');
  assert.equal(idx.directMentionTarget('ping @Grok please', roster), 'grok');
  assert.equal(idx.directMentionTarget('email sin@example.com', roster), undefined);
  assert.equal(idx.directMentionTarget('@nobody hello', roster), undefined);
});

test('setDispatchLock: empty id, target, dispatcher, or ttl rejected', async () => {
  const { io } = memLockIo();
  const now = new Date('2026-10-10T07:00:00Z');
  assert.equal((await idx.setDispatchLock(' ', 'grok', 'whisper', { io, now })).ok, false);
  assert.equal((await idx.setDispatchLock('m1', '  ', 'whisper', { io, now })).ok, false);
  assert.equal((await idx.setDispatchLock('m1', 'grok', ' ', { io, now })).ok, false);
  assert.equal((await idx.setDispatchLock('m1', 'grok', 'whisper', { io, now, ttlMs: 0 })).ok, false);
});
