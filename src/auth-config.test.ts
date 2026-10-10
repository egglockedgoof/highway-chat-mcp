// auth-config.test.ts — MCP_CALLERS / LEGACY_PATH_AUTH parsing (identity binding, #36).
//
// Run:  npm run build && node --test src/auth-config.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FIREBASE_API_KEY ??= 'test-key';
process.env.MCP_SECRET ??= 'test-secret';
process.env.HIGHWAY_CLIENT_KEY ??= 'test-client-key';
process.env.BOT_CREDENTIALS ??= '{}';
process.env.PHASE3_TEST ??= '1';

const { parseAuthConfig } = await import('../dist/index.js');

const TOKEN = 'a'.repeat(32);
const TOKEN2 = 'b'.repeat(32);
const creds = { nyx: {}, Whisper: {} };

test('defaults: no callers, legacy path auth on (current behavior preserved)', () => {
  assert.deepEqual(parseAuthConfig({}, creds), { mcpCallers: {}, legacyEnabled: true });
});

test('MCP_CALLERS binds tokens to bots; bot lookup is case-insensitive', () => {
  const env = { MCP_CALLERS: JSON.stringify({ [TOKEN]: 'whisper', [TOKEN2]: 'nyx' }) };
  assert.deepEqual(parseAuthConfig(env, creds).mcpCallers, { [TOKEN]: 'whisper', [TOKEN2]: 'nyx' });
});

test('LEGACY_PATH_AUTH=off retires the shared path secret', () => {
  const env = { MCP_CALLERS: JSON.stringify({ [TOKEN]: 'nyx', [TOKEN2]: 'whisper' }), LEGACY_PATH_AUTH: 'OFF' };
  assert.equal(parseAuthConfig(env, creds).legacyEnabled, false);
});

test('rejects configs that would lock everyone out or fail at write time', () => {
  const bad: Array<[Record<string, string>, RegExp]> = [
    [{ LEGACY_PATH_AUTH: 'off' }, /requires MCP_CALLERS/],
    [{ MCP_CALLERS: 'not json' }, /not valid JSON/],
    [{ MCP_CALLERS: '["x"]' }, /JSON object/],
    [{ MCP_CALLERS: JSON.stringify({ [TOKEN]: 42 }) }, /JSON object/],
    [{ MCP_CALLERS: JSON.stringify({ short: 'nyx' }) }, /weak-token/],
    [{ MCP_CALLERS: JSON.stringify({ [TOKEN]: 'system' }) }, /reserved-name/],
    [{ MCP_CALLERS: JSON.stringify({ [TOKEN]: 'ghost' }) }, /without BOT_CREDENTIALS: ghost/],
    [{ MCP_CALLERS: JSON.stringify({ [TOKEN]: 'whisper' }) }, /without MCP_CALLERS token: nyx/],
  ];
  for (const [env, re] of bad) assert.throws(() => parseAuthConfig(env, creds), re, JSON.stringify(env));
});
