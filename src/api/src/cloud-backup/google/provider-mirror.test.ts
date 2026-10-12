import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { GoogleDriveProvider } from './provider.ts';
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

test('database-mapped mirror files recover from missing markers and repair changed bytes', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const key = `mirror/${'a'.repeat(24)}/2026/photo.jpg`;
  const original = source(new Uint8Array([1, 2, 3]));
  const object = await provider.mirrorFile(key, '2026/photo.jpg', original, {
    saveCheckpoint: async () => {},
  });
  const file = store.files.get(object.locator)!;
  file.description = '{}';
  file.sha256Checksum = undefined;
  file.bytes = new Uint8Array([9, 9, 9, 9]);
  file.size = '4';

  const drifted = await provider.inspect(key, undefined, {
    locator: object.locator,
    expected: object,
  });
  expect(drifted?.size).toBe(4);
  expect(drifted?.sha256).toBe(sha(file.bytes));
  const repaired = await provider.mirrorFile(key, '2026/photo.jpg', original, {
    expected: object,
    saveCheckpoint: async () => {},
  });
  expect(repaired.locator).toBe(object.locator);
  expect(store.files.get(object.locator)!.bytes).toEqual(new Uint8Array([1, 2, 3]));
  const heartbeatCandidates: string[] = [];
  await provider.inspect(key, undefined, object.locator, async (candidate) => {
    heartbeatCandidates.push(candidate.sha256);
  });
  expect(heartbeatCandidates.length).toBeGreaterThan(0);
  expect(heartbeatCandidates[0]).toBe(object.sha256);
});

test('download without Drive checksum streams bytes only once for caller verification', async () => {
  const store = googleStore();
  const mediaRequests: string[] = [];
  const transport: GoogleFetch = async (raw, init) => {
    const url = new URL(raw);
    if (url.searchParams.get('alt') === 'media') mediaRequests.push(url.pathname);
    return store.transport(raw, init);
  };
  const provider = new GoogleDriveProvider(root, async () => 'token', transport);
  const object = await provider.publish(
    'blobs/no-native-checksum',
    source(new Uint8Array([1, 2, 3])),
    {
      saveCheckpoint: async () => {},
    },
  );
  store.files.get(object.locator)!.sha256Checksum = undefined;
  mediaRequests.length = 0;

  expect(await new Response(await provider.download(object)).bytes()).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  expect(mediaRequests).toEqual([`/drive/v3/files/${object.locator}`]);
});

test('inspecting a missing mirror path is read-only and does not create folders', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  expect(await provider.inspect(`mirror/${'a'.repeat(24)}/missing/photo.jpg`)).toBeNull();
  expect(store.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
});

test('unmapped mirror discovery repairs markerless exact-path files and rejects duplicates', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const key = `mirror/${'b'.repeat(24)}/2026/photo.jpg`;
  const first = await provider.mirrorFile(key, '2026/photo.jpg', source(new Uint8Array([1])), {
    saveCheckpoint: async () => {},
  });
  const file = store.files.get(first.locator)!;
  file.description = '{}';
  const before = store.requests.length;
  expect((await provider.inspect(key))?.locator).toBe(first.locator);
  const listings = store.requests.slice(before).filter((request) => request.query);
  expect(listings.length).toBeGreaterThan(0);
  for (const request of listings) expect(request.query).toContain("name = 'photo.jpg'");

  const duplicate = {
    ...file,
    id: 'duplicate-mirror-file',
    bytes: file.bytes?.slice(),
  };
  store.files.set(duplicate.id, duplicate);
  await expect(provider.inspect(key)).rejects.toThrow('Multiple Google files');
});

test('non-mirror expected identities still reject locator and checksum mismatches', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const object = await provider.publish('blobs/immutable', source(new Uint8Array([1, 2])), {
    saveCheckpoint: async () => {},
  });
  await expect(
    provider.inspect(object.key, undefined, {
      locator: object.locator,
      expected: { ...object, locator: 'other-file' },
    }),
  ).rejects.toThrow('database object mapping');
  await expect(
    provider.inspect(object.key, undefined, {
      locator: object.locator,
      expected: { ...object, sha256: '0'.repeat(64) },
    }),
  ).rejects.toThrow('database object mapping');
});

test('mirror inspection rejects a trashed managed parent', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const key = `mirror/${'d'.repeat(24)}/2026/photo.jpg`;
  const target = await provider.objectTarget(key);
  Object.assign(store.files.get(target.parentId)!, { trashed: true });
  await expect(provider.inspect(key)).rejects.toThrow('moved outside');
});

test('cached mirror folders are checked before listing after they move outside the root', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const key = `mirror/${'e'.repeat(24)}/2026/photo.jpg`;
  const target = await provider.objectTarget(key);
  store.files.get(target.parentId)!.parents = ['outside-root'];
  const before = store.requests.length;
  await expect(provider.inspect(key)).rejects.toThrow('moved outside');
  expect(
    store.requests
      .slice(before)
      .some((request) => request.query?.includes(`'${target.parentId}' in parents`)),
  ).toBe(false);
});

test('stale mirror upload checkpoint yields to the database-mapped locator', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const key = `mirror/${'c'.repeat(24)}/2026/photo.jpg`;
  const old = source(new Uint8Array([1]));
  const current = await provider.mirrorFile(key, '2026/photo.jpg', old, {
    saveCheckpoint: async () => {},
  });
  const target = await provider.objectTarget(key);
  const replacement = source(new Uint8Array([2, 3]));
  const checkpoint: UploadCheckpoint = {
    provider: 'google-drive',
    version: 1,
    state: {
      rootId: root,
      key,
      fileId: 'stale-reservation',
      parentId: target.parentId,
      name: target.name,
      replace: false,
      exactName: true,
      sha256: replacement.sha256,
      size: replacement.size,
      session: null,
    },
  };
  const repaired = await provider.mirrorFile(key, '2026/photo.jpg', replacement, {
    checkpoint,
    expected: current,
    saveCheckpoint: async () => {},
  });
  expect(repaired.locator).toBe(current.locator);
  expect(store.files.get(current.locator)!.bytes).toEqual(new Uint8Array([2, 3]));
});

test('changed source resumes a markerless mapped mirror after discarding its stale checkpoint', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const key = `mirror/${'f'.repeat(24)}/2026/photo.jpg`;
  const original = source(new Uint8Array([1, 2, 3]));
  const current = await provider.mirrorFile(key, '2026/photo.jpg', original, {
    saveCheckpoint: async () => {},
  });
  const target = await provider.objectTarget(key);
  const staleSource = source(new Uint8Array([7, 8]));
  const checkpoint: UploadCheckpoint = {
    provider: 'google-drive',
    version: 1,
    state: {
      rootId: root,
      key,
      fileId: current.locator,
      parentId: target.parentId,
      name: target.name,
      replace: true,
      exactName: true,
      sha256: staleSource.sha256,
      size: staleSource.size,
      session: null,
    },
  };
  store.files.get(current.locator)!.description = '{}';

  const replacement = source(new Uint8Array([4, 5, 6, 7]));
  const repaired = await provider.mirrorFile(key, '2026/photo.jpg', replacement, {
    checkpoint,
    expected: current,
    saveCheckpoint: async () => {},
  });

  expect(repaired.locator).toBe(current.locator);
  expect(store.files.get(current.locator)!.bytes).toEqual(new Uint8Array([4, 5, 6, 7]));
});

test('mirror discovery escapes Drive query quotes in file names', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const name = "o'neil \\ 2026.jpg";
  const key = `mirror/${'g'.repeat(24)}/2026/${name}`;
  const first = await provider.mirrorFile(key, `2026/${name}`, source(new Uint8Array([1])), {
    saveCheckpoint: async () => {},
  });
  store.files.get(first.locator)!.description = '{}';
  const found = await provider.inspect(key);
  expect(found?.locator).toBe(first.locator);
  expect(
    store.requests.some((request) => request.query?.includes("name = 'o\\'neil \\\\ 2026.jpg'")),
  ).toBe(true);
});

test('a mapped mirror file renamed inside the root is re-created at its library path', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const key = `mirror/${'h'.repeat(24)}/2026/photo.jpg`;
  const content = source(new Uint8Array([1, 2, 3]));
  const mapped = await provider.mirrorFile(key, '2026/photo.jpg', content, {
    saveCheckpoint: async () => {},
  });
  const target = await provider.objectTarget(key);
  Object.assign(store.files.get(mapped.locator)!, { name: 'renamed.jpg', description: '{}' });

  const restored = await provider.mirrorFile(key, '2026/photo.jpg', content, {
    expected: mapped,
    saveCheckpoint: async () => {},
  });
  expect(restored.locator).not.toBe(mapped.locator);
  expect(restored.sha256).toBe(content.sha256);
  const file = store.files.get(restored.locator)!;
  expect(file.name).toBe('photo.jpg');
  expect(file.parents).toEqual([target.parentId]);
  expect(store.files.has(mapped.locator)).toBe(false);
  expect((await provider.inspect(key))?.locator).toBe(restored.locator);
});

test('a displaced copy is still removed when the replacement committed before the retry', async () => {
  const store = googleStore();
  const provider = new GoogleDriveProvider(root, async () => 'token', store.transport);
  const key = `mirror/${'i'.repeat(24)}/2026/photo.jpg`;
  const content = source(new Uint8Array([1, 2, 3]));
  const mapped = await provider.mirrorFile(key, '2026/photo.jpg', content, {
    saveCheckpoint: async () => {},
  });
  Object.assign(store.files.get(mapped.locator)!, { name: 'renamed.jpg' });
  let checkpoint: UploadCheckpoint | null = null;
  store.loseFinal();
  await expect(
    provider.mirrorFile(key, '2026/photo.jpg', content, {
      expected: mapped,
      saveCheckpoint: async (value) => {
        checkpoint = value;
      },
    }),
  ).rejects.toThrow('request failed');
  expect(store.files.has(mapped.locator)).toBe(true);

  const restored = await provider.mirrorFile(key, '2026/photo.jpg', content, {
    checkpoint,
    expected: mapped,
    saveCheckpoint: async () => {},
  });
  expect(restored.locator).not.toBe(mapped.locator);
  expect(store.files.get(restored.locator)!.name).toBe('photo.jpg');
  expect(store.files.has(mapped.locator)).toBe(false);
  expect((await provider.inspect(key))?.locator).toBe(restored.locator);
});

test('a displaced copy whose bytes changed after inspection is left alone while the replacement publishes', async () => {
  const store = googleStore();
  let displacedId: string | null = null;
  const transport: GoogleFetch = async (raw, init) => {
    const response = await store.transport(raw, init);
    const headers = new Headers(init?.headers);
    if (displacedId && headers.has('content-range'))
      Object.assign(store.files.get(displacedId)!, { sha256Checksum: '0'.repeat(64) });
    return response;
  };
  const provider = new GoogleDriveProvider(root, async () => 'token', transport);
  const key = `mirror/${'j'.repeat(24)}/2026/photo.jpg`;
  const content = source(new Uint8Array([1, 2, 3]));
  const mapped = await provider.mirrorFile(key, '2026/photo.jpg', content, {
    saveCheckpoint: async () => {},
  });
  Object.assign(store.files.get(mapped.locator)!, { name: 'renamed.jpg' });
  displacedId = mapped.locator;

  const restored = await provider.mirrorFile(key, '2026/photo.jpg', content, {
    expected: mapped,
    saveCheckpoint: async () => {},
  });
  expect(restored.locator).not.toBe(mapped.locator);
  expect(store.files.get(restored.locator)!.name).toBe('photo.jpg');
  expect(store.files.has(mapped.locator)).toBe(true);
});
