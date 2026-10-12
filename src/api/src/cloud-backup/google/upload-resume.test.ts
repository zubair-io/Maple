import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { GoogleDriveProvider } from './provider.ts';
import { googleStore } from './google-store.test-helpers.ts';
import type { PublishSource, UploadCheckpoint } from '../provider.ts';

const root = 'maple-root';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const objectCount = (store: ReturnType<typeof googleStore>) =>
  [...store.files.values()].filter((file) => file.mimeType !== 'application/vnd.google-apps.folder')
    .length;
function source(bytes: Uint8Array): PublishSource {
  return {
    size: bytes.length,
    sha256: sha(bytes),
    open: (offset) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(offset));
          controller.close();
        },
      }),
  };
}

test('an immutable re-upload resumes its own checkpoint when the database still maps a vanished object', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const content = source(new Uint8Array([1, 2, 3]));
  const vanished = await provider.publish('blobs/immutable', content, {
    saveCheckpoint: async () => {},
  });
  store.files.delete(vanished.locator);

  let checkpoint: UploadCheckpoint | null = null;
  store.loseFinal();
  await expect(
    provider.publish('blobs/immutable', content, {
      expected: vanished,
      saveCheckpoint: async (value) => {
        checkpoint = value;
      },
    }),
  ).rejects.toThrow('request failed');
  expect(checkpoint).not.toBeNull();
  expect(objectCount(store)).toBe(1);

  const resumed = await provider.publish('blobs/immutable', content, {
    checkpoint,
    expected: vanished,
    saveCheckpoint: async () => {},
  });
  expect(resumed.locator).not.toBe(vanished.locator);
  expect(resumed.sha256).toBe(content.sha256);
  expect(objectCount(store)).toBe(1);
});

test('a mirror re-upload resumes its committed replacement instead of orphaning it beside a vanished mapping', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const key = `mirror/${'a'.repeat(24)}/2026/photo.jpg`;
  const content = source(new Uint8Array([1, 2, 3]));
  const vanished = await provider.mirrorFile(key, '2026/photo.jpg', content, {
    saveCheckpoint: async () => {},
  });
  store.files.delete(vanished.locator);

  let checkpoint: UploadCheckpoint | null = null;
  store.loseFinal();
  await expect(
    provider.mirrorFile(key, '2026/photo.jpg', content, {
      expected: vanished,
      saveCheckpoint: async (value) => {
        checkpoint = value;
      },
    }),
  ).rejects.toThrow('request failed');
  expect(checkpoint).not.toBeNull();
  expect(objectCount(store)).toBe(1);

  const resumed = await provider.mirrorFile(key, '2026/photo.jpg', content, {
    checkpoint,
    expected: vanished,
    saveCheckpoint: async () => {},
  });
  expect(resumed.locator).not.toBe(vanished.locator);
  expect(resumed.sha256).toBe(content.sha256);
  expect(objectCount(store)).toBe(1);
  expect((await provider.inspect(key))?.locator).toBe(resumed.locator);
});
