// identity.test.ts — bot-name normalization + Firestore updateMask encoding.
//
// "money snatcher 3000" / "MONEY SNATCHER 3000" / "money-snatcher-3000" must
// resolve to the same BOT_CREDENTIALS row. updateMask.fieldPaths must be
// repeated query params, not one comma-joined path (idempotency_key 400).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FIREBASE_API_KEY ??= 'test-key';
process.env.MCP_SECRET ??= 'test-secret';
process.env.HIGHWAY_CLIENT_KEY ??= 'test-client-key';
process.env.BOT_CREDENTIALS ??= '{}';
process.env.PHASE3_TEST ??= '1';

const sec = await import('../dist/security.js');
const idx = await import('../dist/index.js');

test('normalizeBotName collapses case, spaces, underscores, and hyphens', () => {
  const n = sec.normalizeBotName;
  assert.equal(n('MONEY SNATCHER 3000'), 'money snatcher 3000');
  assert.equal(n(' money-snatcher-3000 '), 'money snatcher 3000');
  assert.equal(n('money_snatcher_3000'), 'money snatcher 3000');
  assert.equal(n('Risk Mitigator'), 'risk mitigator');
  assert.equal(n('last30days'), 'last30days');
  assert.equal(n('SYSTEM'), 'system');
});

test('indexBotCreds looks up every spelling of a BOT_CREDENTIALS key', () => {
  const creds = idx.indexBotCreds({
    'MONEY SNATCHER 3000': { email: 'a@example.com', password: 'x' },
    Whisper: { email: 'w@example.com', password: 'y' },
  });
  assert.equal(creds[sec.normalizeBotName('money-snatcher-3000')]?.email, 'a@example.com');
  assert.equal(creds[sec.normalizeBotName('WHISPER')]?.email, 'w@example.com');
});

test('parseAuthConfig matches MCP_CALLERS names to spaced / hyphenated cred keys', () => {
  const token = 'a'.repeat(32);
  const creds = { 'money-snatcher-3000': { email: 'a@example.com', password: 'x' } };
  const env = { MCP_CALLERS: JSON.stringify({ [token]: 'MONEY SNATCHER 3000' }) };
  const cfg = idx.parseAuthConfig(env, creds);
  assert.equal(cfg.mcpCallers[token], 'MONEY SNATCHER 3000');
});

test('header_bound write accepts equivalent spellings of the bound name', () => {
  const counts: string[] = [];
  const gate = sec.createGate({
    isSunset: () => false,
    count: (n: string) => { counts.push(n); },
    readBot: 'whisper',
    recordBoundUse: () => {},
    recordLegacyName: () => {},
  });
  const ctx = { bot: 'MONEY SNATCHER 3000', method: 'header_bound' as const };
  const ok = gate.resolveWrite(ctx, 'money-snatcher-3000');
  assert.equal(ok.ok, true);
  assert.equal(ok.bot, 'MONEY SNATCHER 3000');
  const bad = gate.resolveWrite(ctx, 'whisper');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'identity_mismatch');
});

test('buildFirestoreQuery repeats updateMask.fieldPaths (idempotency_key regression)', () => {
  const fields = ['name', 'text', 'ts', 'tsNum', 'deviceId', 'idempotency_key'];
  const q = sec.buildFirestoreQuery({ updateMask: fields });
  assert.match(q, /^\?/);
  const params = new URLSearchParams(q.slice(1));
  assert.deepEqual(params.getAll('updateMask.fieldPaths'), fields);
  assert.equal(q.includes('name%2Ctext'), false);
  assert.equal(q.includes('name,text'), false);
});
