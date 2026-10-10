// tool-surface.test.ts — core tool catalog vs index.ts, rook/ember send bind.
//
// Run:  npm test
// Pure. Zero live calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORE_TOOLS,
  SEND_BIND_CLIENTS,
  listedCoreTools,
  isSendBindClient,
  bindClientSend,
  gateSendMessageRpc,
} from './tool-surface.ts';

const indexSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'index.ts'),
  'utf8',
);

test('CORE_TOOLS matches every quoted tool() registration in index.ts', () => {
  assert.deepEqual(listedCoreTools(indexSrc), [...CORE_TOOLS]);
  assert.equal(CORE_TOOLS.length, 63);
});

test('send_message schema in index.ts still names reply_to and idempotency_key', () => {
  const m = /tool\(\s*server\s*,\s*"send_message"[\s\S]{0,2500}/.exec(indexSrc);
  assert.ok(m, 'send_message registration missing');
  assert.match(m[0], /reply_to:/);
  assert.match(m[0], /idempotency_key:/);
});

test('listedCoreTools: empty source is empty; skills line is ignored', () => {
  assert.deepEqual(listedCoreTools(''), []);
  assert.deepEqual(listedCoreTools('   '), []);
  assert.deepEqual(
    listedCoreTools('tool(server, SKILL_PREFIX + spec.name,\ntool(server, "get_time",'),
    ['get_time'],
  );
});

test('whisper (unbound) may still send name+text only', () => {
  assert.deepEqual(bindClientSend({ name: 'whisper', text: 'hello' }), {
    name: 'whisper',
    text: 'hello',
  });
});

test('rook and ember without idempotency_key fail closed', () => {
  for (const name of SEND_BIND_CLIENTS) {
    assert.throws(
      () => bindClientSend({ name, text: 'hello' }),
      /requires idempotency_key/,
    );
    assert.throws(
      () => bindClientSend({ name: name.toUpperCase(), text: 'hello' }),
      /requires idempotency_key/,
    );
  }
});

test('rook/ember new post with idempotency_key, no reply_to, is allowed', () => {
  const got = bindClientSend({ name: 'ember', text: 'sketch', idempotency_key: 'e1' });
  assert.deepEqual(got, { name: 'ember', text: 'sketch', idempotency_key: 'e1' });
});

test('rook/ember threaded send binds both idempotency_key and reply_to', () => {
  const got = bindClientSend({
    name: 'rook',
    text: 'on it',
    channel: 'code',
    reply_to: 'msg-9',
    idempotency_key: 'r1',
  });
  assert.deepEqual(got, {
    name: 'rook',
    text: 'on it',
    channel: 'code',
    reply_to: 'msg-9',
    idempotency_key: 'r1',
  });
});

test('legacy aliases fail closed and are not remapped', () => {
  assert.throws(
    () => bindClientSend({ name: 'whisper', text: 'x', replyTo: 'msg-1' }),
    /"replyTo" is not supported; use reply_to/,
  );
  assert.throws(
    () => bindClientSend({ name: 'rook', text: 'x', idempotency_key: 'k', in_reply_to: 'msg-1' }),
    /"in_reply_to" is not supported; use reply_to/,
  );
  assert.throws(
    () => bindClientSend({ name: 'ember', text: 'x', idempotencyKey: 'k' }),
    /"idempotencyKey" is not supported; use idempotency_key/,
  );
});

test('empty reply_to / idempotency_key fail closed (no silent drop)', () => {
  assert.throws(
    () => bindClientSend({ name: 'whisper', text: 'x', reply_to: '  ' }),
    /reply_to must be a non-empty message id/,
  );
  assert.throws(
    () => bindClientSend({ name: 'whisper', text: 'x', idempotency_key: '' }),
    /idempotency_key must be a non-empty key/,
  );
});

test('isSendBindClient is rook and ember only', () => {
  assert.equal(isSendBindClient('rook'), true);
  assert.equal(isSendBindClient(' Ember '), true);
  assert.equal(isSendBindClient('whisper'), false);
  assert.equal(isSendBindClient('grok'), false);
});

test('gateSendMessageRpc: non-send calls and unbound old-shape pass', () => {
  assert.equal(gateSendMessageRpc({ method: 'tools/list' }), null);
  assert.equal(gateSendMessageRpc({ method: 'initialize' }), null);
  assert.equal(gateSendMessageRpc([{ method: 'tools/call' }]), null);
  assert.equal(
    gateSendMessageRpc({ method: 'tools/call', params: { name: 'read_messages', arguments: {} } }),
    null,
  );
  assert.equal(
    gateSendMessageRpc({
      method: 'tools/call',
      params: { name: 'send_message', arguments: { name: 'whisper', text: 'hi' } },
    }),
    null,
  );
});

test('gateSendMessageRpc: rook old-shape and aliases fail closed', () => {
  const old = gateSendMessageRpc({
    method: 'tools/call',
    params: { name: 'send_message', arguments: { name: 'rook', text: 'hi' } },
  });
  assert.match(String(old), /requires idempotency_key/);
  const alias = gateSendMessageRpc({
    method: 'tools/call',
    params: {
      name: 'send_message',
      arguments: { name: 'whisper', text: 'hi', replyTo: 'm1' },
    },
  });
  assert.match(String(alias), /"replyTo" is not supported; use reply_to/);
});
