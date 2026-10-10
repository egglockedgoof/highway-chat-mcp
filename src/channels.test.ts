// channels.test.ts — channel -> collection routing.
//
// Run:  npm run build && node --test src/channels.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FIREBASE_API_KEY ??= 'test-key';
process.env.MCP_SECRET ??= 'test-secret';
process.env.HIGHWAY_CLIENT_KEY ??= 'test-client-key';
process.env.BOT_CREDENTIALS ??= '{}';
process.env.PHASE3_TEST ??= '1';

const idx = await import('../dist/index.js');

test('each channel maps to its own collection', () => {
  assert.equal(idx.channelCollection('room'), 'highway_messages');
  assert.equal(idx.channelCollection('code'), 'highway_code');
  assert.equal(idx.channelCollection('dm'), 'highway_dm');
});

test('idempotency keys are scoped per channel', () => {
  assert.notEqual(idx.idemDocId('room', 'k'), idx.idemDocId('code', 'k'));
});
