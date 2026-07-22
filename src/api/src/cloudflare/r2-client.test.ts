import { describe, expect, it, afterEach } from 'bun:test';
import {
  thumbExistsInR2,
  uploadThumbToR2,
  deleteThumbFromR2,
  testR2Credentials,
} from './r2-client.ts';

/** Capture the method of each request the aws4fetch client issues, and reply
 * with a scripted sequence of statuses. */
function stubFetch(statuses: number[]): () => string[] {
  const methods: string[] = [];
  let i = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    methods.push(init?.method ?? (input instanceof Request ? input.method : 'GET'));
    const status = statuses[Math.min(i++, statuses.length - 1)] ?? 200;
    return new Response(status >= 400 ? 'err' : null, { status });
  }) as typeof fetch;
  return () => methods;
}

const CONFIG = {
  account_id: 'acc',
  bucket: 'buck',
  access_key_id: 'ak',
  secret_access_key: 'sk',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('thumbExistsInR2', () => {
  it('returns true on a 200 HEAD', async () => {
    let seenMethod = '';
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seenMethod = init?.method ?? (input instanceof Request ? input.method : 'GET');
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    expect(await thumbExistsInR2(CONFIG, 'thumbs/slug/dir/f.avif')).toBe(true);
    expect(seenMethod).toBe('HEAD');
  });

  it('returns false on a 404', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    expect(await thumbExistsInR2(CONFIG, 'thumbs/x')).toBe(false);
  });

  it('throws on a 500', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(thumbExistsInR2(CONFIG, 'thumbs/x')).rejects.toThrow(/R2 head failed \(500\)/);
  });
});

describe('uploadThumbToR2', () => {
  it('PUTs the bytes and resolves on 200', async () => {
    const methods = stubFetch([200]);
    await uploadThumbToR2(CONFIG, 'thumbs/x', new Uint8Array([1, 2, 3]), 'image/avif');
    expect(methods()).toEqual(['PUT']);
  });

  it('throws on a non-2xx', async () => {
    stubFetch([403]);
    await expect(
      uploadThumbToR2(CONFIG, 'thumbs/x', new Uint8Array(0), 'image/avif'),
    ).rejects.toThrow(/R2 upload failed \(403\)/);
  });
});

describe('deleteThumbFromR2', () => {
  it('DELETEs and resolves on 200', async () => {
    const methods = stubFetch([200]);
    await deleteThumbFromR2(CONFIG, 'thumbs/x');
    expect(methods()).toEqual(['DELETE']);
  });

  it('treats a 404 (already absent) as success', async () => {
    stubFetch([404]);
    await expect(deleteThumbFromR2(CONFIG, 'thumbs/x')).resolves.toBeUndefined();
  });

  it('throws on other non-2xx', async () => {
    stubFetch([500]);
    await expect(deleteThumbFromR2(CONFIG, 'thumbs/x')).rejects.toThrow(/R2 delete failed \(500\)/);
  });
});

describe('testR2Credentials', () => {
  it('round-trips a PUT then DELETE', async () => {
    const methods = stubFetch([200, 200]);
    await testR2Credentials(CONFIG);
    expect(methods()).toEqual(['PUT', 'DELETE']);
  });

  it('throws when the probe PUT fails', async () => {
    stubFetch([401]);
    await expect(testR2Credentials(CONFIG)).rejects.toThrow(/probe PUT failed \(401\)/);
  });
});
