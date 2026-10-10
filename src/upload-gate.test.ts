// upload-gate.test.ts — POST /upload must not trust a bare Firebase ID token.
//
// Run:  npm run build && node --test src/upload-gate.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FIREBASE_API_KEY ??= 'test-key';
process.env.MCP_SECRET ??= 'test-secret';
process.env.HIGHWAY_CLIENT_KEY ??= 'test-client-key';
process.env.BOT_CREDENTIALS ??= '{}';
process.env.PHASE3_TEST ??= '1';

const idx = await import('../dist/index.js');

test('uploadAllowed: fails closed when no allowlist is configured', () => {
  assert.equal(idx.uploadAllowed('sin@example.com', new Set()), false);
});

test('uploadAllowed: listed emails pass, case- and whitespace-insensitive', () => {
  const allowed = new Set(['sin@example.com']);
  assert.equal(idx.uploadAllowed(' SIN@Example.com ', allowed), true);
  assert.equal(idx.uploadAllowed('stranger@example.com', allowed), false);
});

test('uploadAllowed: accounts without an email are refused', () => {
  assert.equal(idx.uploadAllowed(undefined, new Set(['sin@example.com'])), false);
  assert.equal(idx.uploadAllowed('', new Set([''])), false);
});
