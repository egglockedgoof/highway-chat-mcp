// cloudinary-upload.test.ts — invariants for server-side Cloudinary uploads.
//
// Run:  cd ~/workspace/highway-chat-mcp && node --test src/cloudinary-upload.test.ts
// Node 24 strips types natively; no build step. Zero live calls — the
// uploader is injected, so no Cloudinary credentials are needed.
//
// What these tests pin:
//   1. MIME → folder convention (highway-chat/{images|audio|video|files}).
//   2. MIME → Cloudinary resource_type (audio rides as `video`, docs as `raw`).
//   3. Public ids are URL-safe (no traversal, no spaces, no weird chars).
//   4. Missing env → clean error, never a half-configured SDK call.
//   5. Uploader failures surface as errors; missing secure_url is an error.
//   6. Result shaping: secure_url/public_id/folder/bytes pass through.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  folderForMime,
  resourceTypeForMime,
  cloudinaryConfigured,
  makePublicId,
  uploadToCloudinary,
  type UploaderFn,
  type UploadDeps,
} from './cloudinary-upload.ts';

const GOOD_ENV = {
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-key',
  CLOUDINARY_API_SECRET: 'test-secret',
} as NodeJS.ProcessEnv;

const fakeOk: UploaderFn = async (_dataUri, opts) => ({
  secure_url: `https://res.cloudinary.com/test-cloud/${opts.resource_type}/upload/${opts.folder}/${opts.public_id}.bin`,
  public_id: opts.public_id,
  resource_type: opts.resource_type,
  bytes: 1234,
} as any);

const input = (mimeType: string) => ({
  dataUri: `data:${mimeType};base64,AAAA`,
  filename: 'My Photo (1).JPG',
  mimeType,
});

test('folder convention: images/audio/video/files', () => {
  assert.equal(folderForMime('image/jpeg'), 'highway-chat/images');
  assert.equal(folderForMime('image/webp'), 'highway-chat/images');
  assert.equal(folderForMime('audio/mpeg'), 'highway-chat/audio');
  assert.equal(folderForMime('audio/wav'), 'highway-chat/audio');
  assert.equal(folderForMime('video/mp4'), 'highway-chat/video');
  assert.equal(folderForMime('application/pdf'), 'highway-chat/files');
  assert.equal(folderForMime('text/plain'), 'highway-chat/files');
  assert.equal(folderForMime(''), 'highway-chat/files');
});

test('resource types: audio rides as video, docs as raw', () => {
  assert.equal(resourceTypeForMime('image/png'), 'image');
  assert.equal(resourceTypeForMime('audio/mpeg'), 'video');
  assert.equal(resourceTypeForMime('audio/ogg'), 'video');
  assert.equal(resourceTypeForMime('video/mp4'), 'video');
  assert.equal(resourceTypeForMime('application/pdf'), 'raw');
  assert.equal(resourceTypeForMime('text/markdown'), 'raw');
});

test('public ids are URL-safe', () => {
  const id = makePublicId('../../etc/passwd pic!.png', 12345);
  assert.match(id, /^[a-z0-9-]+$/);
  assert.ok(!id.includes('..'));
  assert.ok(id.length <= 60);
  const empty = makePublicId('!!!', 1);
  assert.match(empty, /^[a-z0-9-]+$/);
});

test('missing env → clean error before any SDK call', async () => {
  let called = false;
  const deps: UploadDeps = {
    env: {} as NodeJS.ProcessEnv,
    uploader: async (...a) => { called = true; return fakeOk(...a); },
  };
  await assert.rejects(() => uploadToCloudinary(input('image/png'), deps), /not configured/);
  assert.equal(called, false);
});

test('non-data URI rejected', async () => {
  await assert.rejects(
    () => uploadToCloudinary({ dataUri: 'https://evil.example/x.png', filename: 'x.png', mimeType: 'image/png' }, { env: GOOD_ENV, uploader: fakeOk }),
    /data: URI/,
  );
});

test('happy path: metadata passes through, folder matches mime', async () => {
  const r = await uploadToCloudinary(input('audio/mpeg'), { env: GOOD_ENV, uploader: fakeOk, nowMs: () => 999 });
  assert.ok(r.secure_url.startsWith('https://res.cloudinary.com/'));
  assert.equal(r.folder, 'highway-chat/audio');
  assert.equal(r.resource_type, 'video');
  assert.equal(r.bytes, 1234);
  assert.match(r.public_id, /^[a-z0-9-]+$/);
});

test('uploader failure surfaces as upload error', async () => {
  const boom: UploaderFn = async () => { throw new Error('net down'); };
  await assert.rejects(
    () => uploadToCloudinary(input('image/png'), { env: GOOD_ENV, uploader: boom }),
    /Cloudinary upload failed: net down/,
  );
});

test('missing secure_url in response is an error', async () => {
  const noUrl: UploaderFn = async (_d, opts) => ({ public_id: opts.public_id } as any);
  await assert.rejects(
    () => uploadToCloudinary(input('image/png'), { env: GOOD_ENV, uploader: noUrl }),
    /no secure_url/,
  );
});

test('cloudinaryConfigured detects partial env', () => {
  assert.equal(cloudinaryConfigured(GOOD_ENV), true);
  assert.equal(cloudinaryConfigured({ CLOUDINARY_CLOUD_NAME: 'x' } as NodeJS.ProcessEnv), false);
  assert.equal(cloudinaryConfigured({} as NodeJS.ProcessEnv), false);
});
