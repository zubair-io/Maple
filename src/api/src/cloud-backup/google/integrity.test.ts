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

test('removal trusts a native checksum without downloading, and hashes drifted bytes when Drive omits one', async () => {
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
  mediaRequests.length = 0;
  await provider.remove(object);
  expect(mediaRequests).toEqual([]);
  expect(store.files.has(object.locator)).toBe(false);

  const drifted = await provider.publish('blobs/drifted', source(new Uint8Array([4, 5, 6])), {
    saveCheckpoint: async () => {},
  });
  Object.assign(store.files.get(drifted.locator)!, {
    sha256Checksum: undefined,
    bytes: new Uint8Array([6, 5, 4]),
  });
  await expect(provider.remove(drifted)).rejects.toThrow('checksum mismatch');
  expect(store.files.has(drifted.locator)).toBe(true);
  expect(mediaRequests).toEqual([`/drive/v3/files/${drifted.locator}`]);
});

test('byte verification revalidates the backup root before reading media', async () => {
  const store = googleStore();
  let rootTrashed = false;
  const mediaRequests: string[] = [];
  const transport: GoogleFetch = async (raw, init) => {
    const url = new URL(raw);
    if (url.searchParams.get('alt') === 'media') mediaRequests.push(url.pathname);
    if (rootTrashed && url.pathname === `/drive/v3/files/${root}`) {
      const body = (await (await store.transport(raw, init)).json()) as Record<string, unknown>;
      return Response.json({ ...body, trashed: true });
    }
    return store.transport(raw, init);
  };
  const provider = new GoogleDriveProvider(root, async () => 'token', transport);
  const object = await provider.publish('blobs/root-check', source(new Uint8Array([1, 2, 3])), {
    saveCheckpoint: async () => {},
  });
  store.files.get(object.locator)!.sha256Checksum = undefined;
  mediaRequests.length = 0;
  rootTrashed = true;
  await expect(verifiedGoogleObject(provider, object)).rejects.toThrow();
  expect(mediaRequests).toEqual([]);
});
