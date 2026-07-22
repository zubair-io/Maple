import { describe, expect, it, afterEach } from 'bun:test';
import { thumbExistsInR2 } from './r2-client.ts';

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
