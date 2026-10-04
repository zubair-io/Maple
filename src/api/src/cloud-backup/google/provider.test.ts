import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { GoogleDriveProvider } from './provider.ts';
import { logicalKeyHash } from './client.ts';
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
function googleStore() {
  const files = new Map<
    string,
    {
      id: string;
      name: string;
      parents: string[];
      description: string;
      properties?: Record<string, string>;
      size: string;
      sha256Checksum?: string;
      mimeType: string;
      bytes: Uint8Array;
    }
  >();
  const requests: Array<{ method: string; path: string; query: string | null; headers: Headers }> =
    [];
  let reserve = 0;
  let active: {
    id: string;
    name: string;
    parents: string[];
    description: string;
    properties?: Record<string, string>;
    mimeType: string;
    size: number;
    parts: Uint8Array[];
  } | null = null;
  let loseFinalResponse = false;
  const metadata = (file: { bytes: Uint8Array }) => {
    const { bytes: _bytes, ...safe } = file;
    return safe;
  };
  const transport: GoogleFetch = async (raw, init) => {
    const url = new URL(raw);
    const method = init?.method ?? 'GET';
    requests.push({
      method,
      path: url.pathname,
      query: url.searchParams.get('q'),
      headers: new Headers(init?.headers),
    });
    if (url.pathname.endsWith(`/files/${root}`))
      return Response.json({
        id: root,
        name: 'Maple Photo Backup',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['my-drive'],
        description: JSON.stringify({
          mapleBackupRoot: 1,
          identity: 'backup-uuid',
        }),
      });
    if (url.pathname.endsWith('/generateIds')) return Response.json({ ids: [`file-${++reserve}`] });
    if (url.pathname === '/drive/v3/files') {
      const query = url.searchParams.get('q') ?? '';
      const hash = /properties has \{ key='mapleKeyHash' and value='([a-f0-9]{64})' \}/.exec(
        query,
      )?.[1];
      return Response.json({
        files: [...files.values()]
          .filter(
            (file) =>
              file.parents.includes(root) && (!hash || file.properties?.['mapleKeyHash'] === hash),
          )
          .map(metadata),
      });
    }
    if (url.pathname.startsWith('/drive/v3/files/')) {
      const id = url.pathname.split('/').at(-1)!;
      const file = files.get(id);
      if (!file) return new Response(null, { status: 404 });
      if (method === 'DELETE') {
        files.delete(id);
        return new Response(null, { status: 204 });
      }
      if (url.searchParams.get('alt') === 'media') return new Response(new Uint8Array(file.bytes));
      return Response.json(metadata(file));
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const uploadMetadata = JSON.parse(String(init!.body));
      active = {
        ...uploadMetadata,
        size: Number(new Headers(init?.headers).get('x-upload-content-length')),
        parts: [],
      };
      return new Response(null, {
        status: 200,
        headers: {
          Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1',
        },
      });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'PUT') {
      if (!active) return new Response(null, { status: 404 });
      const body = init?.body as Uint8Array | undefined;
      if (body?.length) active.parts.push(body);
      const size = active.parts.reduce((total, part) => total + part.length, 0);
      if (size < active.size)
        return new Response(null, {
          status: 308,
          headers: size ? { Range: `bytes=0-${size - 1}` } : {},
        });
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of active.parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      files.set(active.id, {
        id: active.id,
        name: active.name,
        mimeType: active.mimeType,
        parents: active.parents,
        description: active.description,
        properties: active.properties,
        size: String(size),
        sha256Checksum: sha(bytes),
        bytes,
      });
      if (loseFinalResponse) {
        loseFinalResponse = false;
        throw new Error('Simulated lost final response');
      }
      return Response.json(metadata(files.get(active.id)!));
    }
    throw new Error(`Unexpected test request ${method} ${url.pathname}`);
  };
  return {
    files,
    requests,
    transport,
    loseFinal: () => {
      loseFinalResponse = true;
    },
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
