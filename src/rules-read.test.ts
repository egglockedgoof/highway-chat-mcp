// rules-read.test.ts — bridge GET collections must have `allow read` in firestore.rules.
//
// Run:  npm run build && node --test src/rules-read.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.FIREBASE_API_KEY ??= 'test-key';
process.env.MCP_SECRET ??= 'test-secret';
process.env.HIGHWAY_CLIENT_KEY ??= 'test-client-key';
process.env.BOT_CREDENTIALS ??= '{}';
process.env.PHASE3_TEST ??= '1';

const { deniedBridgeReads, matchAllowsRead, BRIDGE_READ_COLLECTIONS } = await import('../dist/rules-read.js');

const rulesPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'firestore.rules');
const repoRules = readFileSync(rulesPath, 'utf8');

test('firestore.rules allows read on every collection the bridge GETs', () => {
  assert.deepEqual(deniedBridgeReads(repoRules), []);
});

test('highway_code matches highway_messages: read and create', () => {
  assert.equal(matchAllowsRead(repoRules, 'highway_code'), true);
  assert.match(repoRules, /match \/highway_code\/\{id\}[\s\S]*?allow create: if signedInNonAnon\(\)/);
  assert.match(repoRules, /match \/highway_messages\/\{id\}[\s\S]*?allow create: if signedInNonAnon\(\)/);
});

test('dispatch_locks allows signed-in non-anonymous read and write', () => {
  assert.equal(matchAllowsRead(repoRules, 'dispatch_locks'), true);
  assert.match(repoRules, /match \/dispatch_locks\/\{id\}[\s\S]*?allow read, write: if signedInNonAnon\(\)/);
});

test('security_telemetry is bound to isBridgeSystem (uid sentinel, not live)', () => {
  assert.equal(matchAllowsRead(repoRules, 'security_telemetry'), true);
  assert.match(repoRules, /match \/security_telemetry\/\{docId\}[\s\S]*?allow read, write: if isBridgeSystem\(\)/);
  assert.match(repoRules, /PASTE_LIVE_SYSTEM_UID/);
});

test('header marks this as a console mirror, not a publish', () => {
  assert.match(repoRules, /CONSOLE MIRROR/);
  assert.match(repoRules, /do not deploy this file over Firebase/i);
});

test('deniedBridgeReads: empty or missing rules fail closed (all collections denied)', () => {
  assert.deepEqual(deniedBridgeReads(''), [...BRIDGE_READ_COLLECTIONS]);
  assert.deepEqual(deniedBridgeReads('   '), [...BRIDGE_READ_COLLECTIONS]);
});

test('matchAllowsRead: no match, write-only match, and bad collection name deny', () => {
  const src = `
    match /highway_messages/{id} { allow write: if true; }
    match /dispatch_locks/{id} { allow read: if true; }
  `;
  assert.equal(matchAllowsRead(src, 'highway_messages'), false);
  assert.equal(matchAllowsRead(src, 'dispatch_locks'), true);
  assert.equal(matchAllowsRead(src, 'highway_code'), false);
  assert.equal(matchAllowsRead(src, '../x'), false);
  assert.equal(matchAllowsRead(src, ''), false);
});

test('matchAllowsRead: allow read, write counts as a read grant', () => {
  const src = 'match /highway_code/{id} { allow read, write: if request.auth != null; }';
  assert.equal(matchAllowsRead(src, 'highway_code'), true);
});

test('highway_messages create is signedInNonAnon, not a write-all', () => {
  const m = /match\s+\/highway_messages\/\{[^}]+\}[\s\S]{0,400}/.exec(repoRules);
  assert.ok(m, 'highway_messages match missing');
  assert.match(m[0], /allow create: if signedInNonAnon\(\)/);
  assert.equal(/\ballow\s+write\b/.test(m[0]), false);
});
