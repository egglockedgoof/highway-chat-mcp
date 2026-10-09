// message-limits.test.ts — invariants for full-text Highway messages.
//
// Run:  cd ~/workspace/highway-chat-mcp && node --test src/message-limits.test.ts
// Node 24 strips types natively; no build step. Zero live calls.
//
// Sin's directive (2026-10-09): long messages post in full — no preview
// split, no truncation, no attachment machinery. These tests pin the two
// load-bearing guarantees:
//   1. The send_message text schema accepts messages up to MESSAGE_MAX_CHARS
//      (imported from the same module index.ts uses — no drift).
//   2. Even the largest allowed message fits in a Firestore document
//      (worst-case UTF-8 bytes + overhead < 1 MiB).
// A live Firestore round-trip (50k chars through the bridge, read back
// complete) still needs a credentialed run — arranged by the parent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  messageTextSchema,
  messageByteSize,
  maxMessageFitsInDoc,
  MESSAGE_MAX_CHARS,
  COLLAPSE_AFTER_CHARS,
  FIRESTORE_DOC_LIMIT_BYTES,
} from './message-limits.ts';

const schema = messageTextSchema();

test('50k-char message passes the send_message text schema intact', () => {
  const text = 'a'.repeat(50_000);
  const parsed = schema.parse(text);
  assert.equal(parsed, text);
  assert.equal(parsed.length, 50_000);
});

test('exactly MESSAGE_MAX_CHARS passes', () => {
  const text = 'b'.repeat(MESSAGE_MAX_CHARS);
  assert.equal(schema.parse(text).length, MESSAGE_MAX_CHARS);
});

test('MESSAGE_MAX_CHARS + 1 is rejected', () => {
  assert.throws(() => schema.parse('c'.repeat(MESSAGE_MAX_CHARS + 1)));
});

test('empty and whitespace-only text rejected', () => {
  assert.throws(() => schema.parse(''));
  assert.throws(() => schema.parse('   \n  '));
});

test('50k-char ASCII message is far under the Firestore doc limit', () => {
  const bytes = messageByteSize('x'.repeat(50_000));
  assert.equal(bytes, 50_000);
  assert.ok(bytes < FIRESTORE_DOC_LIMIT_BYTES);
});

test('worst case (100k × 4-byte chars) still fits in a Firestore doc', () => {
  const worst = '🔥'.repeat(MESSAGE_MAX_CHARS); // 4 bytes each in UTF-8
  assert.equal(messageByteSize(worst), MESSAGE_MAX_CHARS * 4);
  assert.ok(messageByteSize(worst) < FIRESTORE_DOC_LIMIT_BYTES);
  assert.equal(maxMessageFitsInDoc(), true);
});

test('bounds are sane and ordered', () => {
  assert.equal(MESSAGE_MAX_CHARS, 100_000);
  assert.equal(COLLAPSE_AFTER_CHARS, 1000);
  assert.ok(COLLAPSE_AFTER_CHARS < MESSAGE_MAX_CHARS);
  assert.equal(FIRESTORE_DOC_LIMIT_BYTES, 1_048_576);
});

test('multibyte text byte size is measured, not char-counted', () => {
  assert.equal(messageByteSize('é'), 2); // 2 bytes in UTF-8, 1 char
  assert.equal(messageByteSize('🔥'), 4);
});
