import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { GoogleDriveProvider } from './provider.ts';
import { logicalKeyHash } from './client.ts';
import { googleStore } from './google-store.test-helpers.ts';
import type { GoogleFetch } from './oauth.ts';
import type { PublishSource, UploadCheckpoint } from '../provider.ts';

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
test('immutable uploads reserve IDs durably, align chunks and resume after a lost final response without duplicates', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const bytes = new Uint8Array(8 * 1024 * 1024 + 31);
  bytes.fill(7);
  const content = source(bytes);
  let checkpoint: UploadCheckpoint | null = null;
  let checkpointWrites = 0;
  store.loseFinal();
  await expect(
    provider.publish('blobs/immutable-sha', content, {
      saveCheckpoint: async (value) => {
        checkpoint = value;
        checkpointWrites += 1;
      },
    }),
  ).rejects.toThrow('request failed');
  expect(checkpoint).not.toBeNull();
  expect(checkpointWrites).toBeGreaterThanOrEqual(5);
  expect(store.files.size).toBe(1);
  const object = await provider.publish('blobs/immutable-sha', content, {
    checkpoint,
    saveCheckpoint: async (value) => {
      checkpoint = value;
    },
  });
  expect(object.sha256).toBe(content.sha256);
  expect(store.files.size).toBe(1);
  const chunks = store.requests.filter((r) => r.method === 'PUT');
  expect(chunks[0]!.headers.get('content-range')).toBe(
    `bytes 0-${8 * 1024 * 1024 - 1}/${bytes.length}`,
  );
  expect(chunks[1]!.headers.get('content-range')).toBe(
    `bytes ${8 * 1024 * 1024}-${bytes.length - 1}/${bytes.length}`,
  );
});
test('listing is root scoped; foreign and moved locators are refused for download and purge', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const object = await provider.publish('blobs/test', source(new Uint8Array([1, 2, 3])), {
    saveCheckpoint: async () => {},
  });
  store.files.get(object.locator)!.parents = ['foreign-folder'];
  const requestsBeforeInspection = store.requests.length;
  await expect(provider.inspect(object.key, undefined, object.locator)).rejects.toThrow('outside');
  expect(
    store.requests
      .slice(requestsBeforeInspection)
      .some((request) => request.path === '/drive/v3/files'),
  ).toBe(false);
  await expect(provider.download(object)).rejects.toThrow('outside');
  await expect(provider.remove(object)).rejects.toThrow('outside');
  expect(store.files.size).toBe(1);
  expect(store.requests.some((r) => r.method === 'DELETE')).toBe(false);
});
test('logical key and checkpoint URL injection cannot transmit bearer credentials to arbitrary endpoints', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  await expect(
    provider.publish('../escape', source(new Uint8Array([1])), {
      saveCheckpoint: async () => {},
    }),
  ).rejects.toThrow('logical key');
  await expect(
    provider.abort({
      provider: 'google-drive',
      version: 1,
      state: {
        rootId: root,
        key: 'blobs/test',
        fileId: 'file-1',
        size: 1,
        sha256: sha(new Uint8Array([1])),
        session: 'https://evil.example/upload?upload_id=1',
      },
    }),
  ).rejects.toThrow('resumable session');
  expect(store.requests).toHaveLength(0);
});
test('immutable key content mismatch never overwrites existing Google bytes', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  await provider.publish('blobs/test', source(new Uint8Array([1])), {
    saveCheckpoint: async () => {},
  });
  const before = store.requests.filter((r) => r.method === 'POST').length;
  await expect(
    provider.publish('blobs/test', source(new Uint8Array([2])), {
      saveCheckpoint: async () => {},
    }),
  ).rejects.toThrow('conflicts');
  expect(store.requests.filter((r) => r.method === 'POST')).toHaveLength(before);
});

test('Google display names preserve photo extension and MIME while immutable keys stay portable', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const content = {
    ...source(new Uint8Array([1, 2, 3])),
    name: 'Wedding.JPG',
    contentType: 'image/jpeg',
  };
  const object = await provider.publish('blobs/photo-sha', content, {
    saveCheckpoint: async () => {},
  });
  const file = store.files.get(object.locator)!;
  expect(file.name).toBe(`Wedding__${content.sha256.slice(0, 12)}.JPG`);
  expect(file.mimeType).toBe('image/jpeg');
  expect(JSON.parse(file.description).key).toBe('blobs/photo-sha');
  expect(
    store.requests
      .find((request) => request.method === 'POST')!
      .headers.get('x-upload-content-type'),
  ).toBe('image/jpeg');
});
test('inspect hashes bytes when Google does not supply a native SHA; marker metadata cannot forge verification', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const object = await provider.publish('blobs/photo-sha', source(new Uint8Array([1, 2, 3])), {
    saveCheckpoint: async () => {},
  });
  const file = store.files.get(object.locator)!;
  file.sha256Checksum = undefined;
  expect((await provider.inspect(object.key))!.sha256).toBe(object.sha256);
  file.bytes = new Uint8Array([3, 2, 1]);
  await expect(provider.inspect(object.key)).rejects.toThrow('read-back checksum mismatch');
});

test('cleanup of a corrupt reservation cannot delete another owned backup object', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const object = await provider.publish('blobs/retained', source(new Uint8Array([1, 2, 3])), {
    saveCheckpoint: async () => {},
  });
  await expect(
    provider.abort({
      provider: 'google-drive',
      version: 1,
      state: {
        rootId: root,
        key: 'blobs/purged',
        fileId: object.locator,
        sha256: object.sha256,
        size: object.size,
        session: null,
      },
    }),
  ).rejects.toThrow('changed upload reservation');
  expect(store.files.has(object.locator)).toBe(true);
  expect(store.requests.some((request) => request.method === 'DELETE')).toBe(false);
});

test('exact inspection queries a bounded public key hash and never enumerates unrelated root files', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const key = `catalog/${'é'.repeat(400)}`;
  const object = await provider.publish(key, source(new Uint8Array([1, 2, 3])), {
    saveCheckpoint: async () => {},
  });
  const file = store.files.get(object.locator)!;
  expect(file.properties).toEqual({ mapleKeyHash: logicalKeyHash(key) });
  expect(
    Buffer.byteLength('mapleKeyHash' + file.properties!['mapleKeyHash']!, 'utf8'),
  ).toBeLessThanOrEqual(124);
  expect(JSON.parse(file.description).key).toBe(key);
  for (let index = 0; index < 200; index++) {
    const otherKey = `blobs/unrelated-${index}`;
    store.files.set(`unrelated-${index}`, {
      ...file,
      id: `unrelated-${index}`,
      properties: { mapleKeyHash: logicalKeyHash(otherKey) },
      description: JSON.stringify({ ...JSON.parse(file.description), key: otherKey }),
    });
  }
  expect(await provider.inspect(key)).toEqual(object);
  const lists = store.requests.filter((request) => request.path === '/drive/v3/files');
  expect(lists.length).toBeGreaterThan(0);
  for (const request of lists) {
    expect(request.query).toBe(
      `'${root}' in parents and trashed = false and properties has { key='mapleKeyHash' and value='${logicalKeyHash(key)}' }`,
    );
    expect(request.query).not.toContain('é');
  }
});

test('portable root listings and direct downloads do not depend on the searchable property', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const object = await provider.publish('blobs/portable', source(new Uint8Array([1, 2, 3])), {
    saveCheckpoint: async () => {},
  });
  delete store.files.get(object.locator)!.properties;
  const objects: unknown[] = [];
  for await (const listed of provider.list('blobs/')) objects.push(listed);
  expect(objects).toEqual([object]);
  expect(await provider.inspect(object.key, undefined, object.locator)).toEqual(object);
  expect(await new Response(await provider.download(object)).bytes()).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  const before = store.requests.length;
  expect(await provider.inspect(object.key)).toBeNull();
  const lists = store.requests
    .slice(before)
    .filter((request) => request.path === '/drive/v3/files');
  expect(lists).toHaveLength(1);
  expect(lists[0]!.query).toContain('properties has');
  store.files.delete(object.locator);
  expect(await provider.inspect(object.key, undefined, object.locator)).toBeNull();
});

test('exact search rejects inconsistent public metadata and duplicates across result pages', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const object = await provider.publish('blobs/exact', source(new Uint8Array([1, 2, 3])), {
    saveCheckpoint: async () => {},
  });
  const file = store.files.get(object.locator)!;
  const original = file.description;
  file.description = JSON.stringify({ ...JSON.parse(original), key: 'blobs/wrong-key' });
  await expect(provider.inspect(object.key)).rejects.toThrow('search index');
  file.description = original;
  const paged: GoogleFetch = async (raw, init) => {
    const url = new URL(raw);
    if (url.pathname === '/drive/v3/files') {
      expect(url.searchParams.get('q')).toContain(`value='${logicalKeyHash(object.key)}'`);
      return Response.json({
        files: [{ ...file, id: url.searchParams.has('pageToken') ? 'duplicate-id' : file.id }],
        ...(url.searchParams.has('pageToken') ? {} : { nextPageToken: 'second-page' }),
      });
    }
    return store.transport(raw, init);
  };
  const duplicateProvider = new GoogleDriveProvider(root, async () => 'token', paged);
  await expect(duplicateProvider.inspect(object.key)).rejects.toThrow('Conflicting immutable');
});

for (const ownership of [
  { ownedByMe: false, driveId: undefined },
  { ownedByMe: undefined, driveId: undefined },
  { ownedByMe: true, driveId: 'shared-drive' },
]) {
  test(`object access and cleanup require affirmative My Drive ownership (${JSON.stringify(ownership)})`, async () => {
    const store = googleStore();
    const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
    const object = await provider.publish('blobs/owned', source(new Uint8Array([1, 2, 3])), {
      saveCheckpoint: async () => {},
    });
    Object.assign(store.files.get(object.locator)!, ownership);
    const before = store.requests.length;
    await expect(provider.inspect(object.key)).rejects.toThrow('owned');
    await expect(provider.inspect(object.key, undefined, object.locator)).rejects.toThrow('owned');
    await expect(provider.download(object)).rejects.toThrow('owned');
    await expect(provider.remove(object)).rejects.toThrow('owned');
    await expect(
      (async () => {
        for await (const _object of provider.list('blobs/')) {
        }
      })(),
    ).rejects.toThrow('owned');
    expect(store.requests.slice(before).some((request) => request.method === 'DELETE')).toBe(false);
  });
  test(`root probes require affirmative My Drive ownership (${JSON.stringify(ownership)})`, async () => {
    const store = googleStore();
    const transport: GoogleFetch = async (url, init) => {
      const response = await store.transport(url, init);
      return new URL(url).pathname === `/drive/v3/files/${root}`
        ? Response.json({ ...(await response.json()), ...ownership })
        : response;
    };
    await expect(
      new GoogleDriveProvider(root, async () => 'token', transport).probe(),
    ).rejects.toThrow('owned');
  });
}

test('an empty upload completes without a status-probe Content-Range and reconciles a lost final response', async () => {
  const store = googleStore();
  const transport: GoogleFetch = async (url, init) => {
    if (init?.method === 'PUT') {
      const headers = new Headers(init.headers);
      expect(headers.get('content-length')).toBe('0');
      expect(headers.has('content-range')).toBe(false);
    }
    return store.transport(url, init);
  };
  const provider = new GoogleDriveProvider(root, async () => 'token', transport);
  const content = source(new Uint8Array());
  let checkpoint: UploadCheckpoint | null = null;
  store.loseFinal();
  await expect(
    provider.publish('blobs/empty', content, {
      saveCheckpoint: async (value) => {
        checkpoint = value;
      },
    }),
  ).rejects.toThrow('request failed');
  const object = await provider.publish('blobs/empty', content, {
    checkpoint,
    saveCheckpoint: async () => {},
  });
  expect(object.size).toBe(0);
  expect(object.sha256).toBe(content.sha256);
  expect(store.files.size).toBe(1);
});
