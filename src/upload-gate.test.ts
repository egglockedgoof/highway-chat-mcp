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

test('parseUploadAllowlist: unset, empty, and whitespace-only fail closed', () => {
  assert.equal(idx.parseUploadAllowlist(undefined).size, 0);
  assert.equal(idx.parseUploadAllowlist('').size, 0);
  assert.equal(idx.parseUploadAllowlist('  , , ').size, 0);
  assert.equal(idx.uploadAllowed('anyone@example.com', idx.parseUploadAllowlist(undefined)), false);
  assert.equal(idx.uploadAllowed('anyone@example.com', idx.parseUploadAllowlist('')), false);
});

test('parseUploadAllowlist: comma-separated, case- and whitespace-insensitive', () => {
  const allowed = idx.parseUploadAllowlist(' Alpha@Example.com ,beta@example.com');
  assert.deepEqual([...allowed].sort(), ['alpha@example.com', 'beta@example.com']);
  assert.equal(idx.uploadAllowed(' ALPHA@example.com ', allowed), true);
  assert.equal(idx.uploadAllowed('beta@example.com', allowed), true);
  assert.equal(idx.uploadAllowed('stranger@example.com', allowed), false);
});

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
  assert.equal(idx.uploadAllowed('   ', new Set(['sin@example.com'])), false);
});
