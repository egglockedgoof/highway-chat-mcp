// firestore-errors.test.ts — errors thrown by the security.ts choke point must be the class
// index.ts checks with instanceof (contention, 404, missing-index fallback).
//
// Run:  npm run build && node --test src/firestore-errors.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FIREBASE_API_KEY ??= 'test-key';
process.env.MCP_SECRET ??= 'test-secret';
process.env.HIGHWAY_CLIENT_KEY ??= 'test-client-key';
process.env.BOT_CREDENTIALS ??= '{}';
process.env.PHASE3_TEST ??= '1';

const sec = await import('../dist/security.js');
const idx = await import('../dist/index.js');

test('index.ts and security.ts share one FirestoreError class', () => {
  assert.equal(idx.FirestoreError, sec.FirestoreError);
});

test('fromResponse unwraps :runQuery array error bodies', () => {
  const body = [{ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'The query requires an index.' } }];
  const e = sec.FirestoreError.fromResponse(400, body);
  assert.equal(e.code, 'FAILED_PRECONDITION');
  assert.equal(e.message, 'The query requires an index.');
});

test('isWriteContention recognises a choke-point ALREADY_EXISTS error', () => {
  const e = sec.FirestoreError.fromResponse(409, { error: { status: 'ALREADY_EXISTS', message: 'exists' } });
  assert.equal(idx.isWriteContention(e), true);
});

test('writeIdempotent reports a lost create race as duplicate, using a real choke-point error', async () => {
  const io = {
    getDoc: async () => null,
    createDoc: async () => { throw sec.FirestoreError.fromResponse(409, { error: { status: 'ALREADY_EXISTS', message: 'exists' } }); },
  };
  const r = await idx.writeIdempotent('highway_idempotency', 'idem_x', { fields: {} }, undefined, io);
  assert.equal(r.duplicate, true);
});
