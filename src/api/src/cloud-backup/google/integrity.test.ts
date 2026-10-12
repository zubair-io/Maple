import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { GoogleDriveProvider } from './provider.ts';
import { googleStore } from './google-store.test-helpers.ts';
import { verifiedGoogleObject } from './integrity.ts';
import type { GoogleFetch } from './oauth.ts';
import type { PublishSource } from '../provider.ts';

const root = 'maple-root';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
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

test('same-size byte drift without a native checksum fails immutable verification but is reported for mirrors', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const immutable = await provider.publish('blobs/drift', source(new Uint8Array([1, 2, 3])), {
    saveCheckpoint: async () => {},
  });
  Object.assign(store.files.get(immutable.locator)!, {
    sha256Checksum: undefined,
    bytes: new Uint8Array([3, 2, 1]),
  });
  await expect(verifiedGoogleObject(provider, immutable)).rejects.toThrow(
    'read-back checksum mismatch',
  );

  const mirror = await provider.mirrorFile(
    `mirror/${'a'.repeat(24)}/2026/photo.jpg`,
    '2026/photo.jpg',
    source(new Uint8Array([1, 2, 3])),
    { saveCheckpoint: async () => {} },
  );
  Object.assign(store.files.get(mirror.locator)!, {
    sha256Checksum: undefined,
    bytes: new Uint8Array([3, 2, 1]),
  });
  const drifted = await verifiedGoogleObject(provider, mirror);
  expect(drifted.sha256).toBe(sha(new Uint8Array([3, 2, 1])));
  expect(drifted.size).toBe(3);
});

test('removal checks metadata only and never downloads the object bytes', async () => {
  const store = googleStore();
  const mediaRequests: string[] = [];
  const transport: GoogleFetch = async (raw, init) => {
    const url = new URL(raw);
    if (url.searchParams.get('alt') === 'media') mediaRequests.push(url.pathname);
    return store.transport(raw, init);
  };
  const provider = new GoogleDriveProvider(root, async () => 'token', transport);
  const object = await provider.publish('blobs/removed', source(new Uint8Array([1, 2, 3])), {
    saveCheckpoint: async () => {},
  });
  store.files.get(object.locator)!.sha256Checksum = undefined;
  mediaRequests.length = 0;
  await provider.remove(object);
  expect(mediaRequests).toEqual([]);
  expect(store.files.has(object.locator)).toBe(false);
});
