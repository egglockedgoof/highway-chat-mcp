// read-order.test.ts — newest-first reads across mixed `ts` types, and voice audio in fmtMsg.
//
// Run:  npm run build && node --test src/read-order.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FIREBASE_API_KEY ??= 'test-key';
process.env.MCP_SECRET ??= 'test-secret';
process.env.HIGHWAY_CLIENT_KEY ??= 'test-client-key';
process.env.BOT_CREDENTIALS ??= '{}';
process.env.PHASE3_TEST ??= '1';

const idx = await import('../dist/index.js');

const doc = (id: string, ms: number, tsKind: 'string' | 'timestamp', withNum: boolean) => ({
  name: `projects/p/databases/(default)/documents/highway_messages/${id}`,
  fields: {
    name: { stringValue: id },
    text: { stringValue: id },
    ts: tsKind === 'string'
      ? { stringValue: new Date(ms).toISOString() }
      : { timestampValue: new Date(ms).toISOString() },
    ...(withNum ? { tsNum: { integerValue: String(ms) } } : {}),
  },
});

test('mergeNewest: newest docs win even when string-typed ts would bury them', () => {
  const t0 = Date.parse('2026-10-09T00:00:00Z');
  // Firestore `ts` DESC returns every stringValue before any timestampValue, so this page
  // is all old string-typed docs; the `tsNum` page holds the actual newest.
  const byTs = Array.from({ length: 20 }, (_, i) => doc(`old${i}`, t0 + i, 'string', true));
  const byNum = [doc('new2', t0 + 3e6, 'timestamp', true), doc('new1', t0 + 2e6, 'timestamp', true), byTs[19]];
  const out = idx.mergeNewest([byTs, byNum], 3).map((d: any) => d.fields.name.stringValue);
  assert.deepEqual(out, ['new2', 'new1', 'old19']);
});

test('mergeNewest: legacy docs without tsNum still surface, duplicates collapse', () => {
  const t0 = Date.parse('2026-10-09T00:00:00Z');
  const legacy = doc('legacy', t0 + 5e6, 'timestamp', false);
  const recent = doc('recent', t0 + 1e6, 'timestamp', true);
  const out = idx.mergeNewest([[legacy, recent], [recent]], 10).map((d: any) => d.fields.name.stringValue);
  assert.deepEqual(out, ['legacy', 'recent']);
});

test('fmtMsg: voice messages expose audio, audioType default, approx decoded size', () => {
  const d = doc('v', Date.parse('2026-10-09T00:00:00Z'), 'timestamp', true);
  (d.fields as any).audio = { stringValue: 'A'.repeat(400) };
  const m = idx.fmtMsg(d);
  assert.equal(m.audio, 'A'.repeat(400));
  assert.equal(m.audioType, 'audio/webm');
  assert.equal(m.audioBytes, 300);
});

test('fmtMsg: text messages carry no audio fields', () => {
  const m = idx.fmtMsg(doc('t', Date.parse('2026-10-09T00:00:00Z'), 'timestamp', true));
  assert.equal('audio' in m, false);
});
