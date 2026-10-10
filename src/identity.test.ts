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

test('matchCallerToken scans every token (no early exit) and returns the bound bot', () => {
  const first = 'a'.repeat(16);
  const second = 'b'.repeat(16);
  const third = 'c'.repeat(16);
  const callers = { [first]: 'hollow', [second]: 'whisper', [third]: 'nyx' };
  let compared = 0;
  const equal = (a: string, b: string) => { compared += 1; return a === b; };
  assert.equal(sec.matchCallerToken(first, callers, equal), 'hollow');
  assert.equal(compared, 3, 'must compare all callers even after a hit');
  compared = 0;
  assert.equal(sec.matchCallerToken(third, callers, equal), 'nyx');
  assert.equal(compared, 3);
  compared = 0;
  assert.equal(sec.matchCallerToken('z'.repeat(16), callers, equal), null);
  assert.equal(compared, 3);
  assert.equal(sec.matchCallerToken(first, {}), null);
});

test('spoofed name on the legacy path fails closed (Bearer is authoritative; no path fallback)', async () => {
  const hollowToken = 'h'.repeat(32);
  const resolveAuth = sec.createResolveAuth({
    config: {
      mcpCallers: { [hollowToken]: 'hollow' },
      legacySecret: 's3cret-path',
      legacyEnabled: true,
    },
    isSunset: () => false,
    count: () => {},
    recordLegacySignal: async () => {},
  });
  const spoofBearer = {
    headersDistinct: { authorization: [`Bearer ${'x'.repeat(32)}`] },
  };
  const decoy = await resolveAuth(spoofBearer, '/mcp/s3cret-path');
  assert.equal(decoy.kind, 'decoy', 'wrong Bearer on /mcp/<secret> must not fall back to path auth');

  const bound = await resolveAuth(
    { headersDistinct: { authorization: [`Bearer ${hollowToken}`] } },
    '/mcp/s3cret-path',
  );
  assert.equal(bound.kind, 'ctx');
  if (bound.kind !== 'ctx') throw new Error('expected ctx');
  assert.equal(bound.ctx.method, 'header_bound');
  assert.equal(bound.ctx.bot, 'hollow');

  const gate = sec.createGate({
    isSunset: () => false,
    count: () => {},
    readBot: 'whisper',
    recordBoundUse: () => {},
    recordLegacyName: () => {},
  });
  const spoofWrite = gate.resolveWrite(bound.ctx, 'whisper');
  assert.equal(spoofWrite.ok, false);
  assert.equal(spoofWrite.code, 'identity_mismatch');
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
