// Tests for `ThumbBlobCache` — the bearer-gated thumbnail blob cache.
//
// No TestBed: `ThumbBlobCache` is a plain class (not `@Injectable`), so we
// hand its constructor lightweight fakes for the only methods it actually
// calls (`api.getThumb`, `fsBrowse.getThumbBlobUrl`,
// `librarySource.thumbBlob`) rather than pulling in the real HttpClient
// stack. `URL.createObjectURL` / `revokeObjectURL` are stubbed globally
// per-test and restored after, matching the pattern used in
// `library-cache.preview-url.spec.ts`.
//
// The lifecycle this file exists to pin down: three fetch routes (address /
// absPath / apiAssetId), each tagging its result `owned: true|false`, and
// `destroy()` must revoke every `owned` url exactly once while never
// touching a `borrowed` one (the FilesystemBrowseService-owned blob is
// shared with /browse's grid — revoking it here would break that cache).

import { describe, it, expect, vi } from 'vitest';
import { of, throwError, type Observable } from 'rxjs';
import type { BunApiBackendService, FilesystemBrowseService, LibrarySource } from '@maple-common';
import { ThumbBlobCache } from './thumb-blob-cache';

/** Fetch promise chains inside `ensure()` are fire-and-forget; let their
 * microtasks (and any nested `.then()`s) drain before asserting. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function blob(tag = 'x'): Blob {
  return new Blob([tag], { type: 'image/avif' });
}

function fakeApi(getThumb: (id: string) => Observable<Blob>): BunApiBackendService {
  return { getThumb } as unknown as BunApiBackendService;
}

function fakeFsBrowse(getThumbBlobUrl: (path: string) => Promise<string>): FilesystemBrowseService {
  return { getThumbBlobUrl } as unknown as FilesystemBrowseService;
}

function fakeLibrarySource(
  thumbBlob: (a: { slug: string; relPath: string }) => Promise<Blob | null>,
): LibrarySource {
  return { thumbBlob } as unknown as LibrarySource;
}

/** Stub the two `URL` blob-url statics for the duration of `fn`, then
 * restore. `createObjectURL` returns a distinct, inspectable string per
 * call so tests can tell which minted url ended up where. */
async function withStubbedBlobUrls<T>(
  fn: (calls: { created: string[]; revoked: string[] }) => Promise<T>,
): Promise<T> {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const calls = { created: [] as string[], revoked: [] as string[] };
  let n = 0;
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:mock-${n++}`;
    calls.created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    calls.revoked.push(url);
  });
  try {
    return await fn(calls);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
}

describe('ThumbBlobCache.coverKey', () => {
  it('prefers coverAddress', () => {
    expect(
      ThumbBlobCache.coverKey({
        coverAddress: 'lib:a.jpg',
        coverAbsPath: '/x/a.jpg',
        coverAssetId: 'id1',
      }),
    ).toBe('lib:a.jpg');
  });
  it('falls back to coverAbsPath when no address', () => {
    expect(ThumbBlobCache.coverKey({ coverAbsPath: '/x/a.jpg', coverAssetId: 'id1' })).toBe(
      '/x/a.jpg',
    );
  });
  it('falls back to apiId:<id> as a last resort', () => {
    expect(ThumbBlobCache.coverKey({ coverAbsPath: null, coverAssetId: 'id1' })).toBe('apiId:id1');
  });
  it('returns null when nothing is available', () => {
    expect(ThumbBlobCache.coverKey({ coverAbsPath: null, coverAssetId: null })).toBeNull();
  });
});

describe('ThumbBlobCache.ensure — no-op / unroutable cases', () => {
  it('does nothing when cacheKey is null', async () => {
    const getThumbBlobUrl = vi.fn();
    const cache = new ThumbBlobCache(fakeApi(vi.fn()), fakeFsBrowse(getThumbBlobUrl));
    cache.ensure(null, null, null, null);
    await settle();
    expect(getThumbBlobUrl).not.toHaveBeenCalled();
    expect(cache.url(null)).toBeNull();
  });

  it('leaves the key unresolved when no routing arg is provided, and does not wedge future retries', async () => {
    const cache = new ThumbBlobCache(fakeApi(vi.fn()), fakeFsBrowse(vi.fn()));
    cache.ensure('k1', null, null, null);
    await settle();
    expect(cache.url('k1')).toBeNull();
    // A later call with a real route must still succeed — proves the failed
    // attempt above cleared itself out of `inflight` instead of wedging.
    const getThumbBlobUrl = vi.fn(async () => 'blob:legacy-url');
    const cache2 = new ThumbBlobCache(fakeApi(vi.fn()), fakeFsBrowse(getThumbBlobUrl));
    cache2.ensure('k1', null, null, null);
    await settle();
    cache2.ensure('k1', null, '/x/a.jpg', null);
    await settle();
    expect(cache2.url('k1')).toBe('blob:legacy-url');
  });
});

describe('ThumbBlobCache.ensure — absPath route', () => {
  it('fetches via fsBrowse.getThumbBlobUrl and caches the returned url as BORROWED', async () => {
    const getThumbBlobUrl = vi.fn(async (path: string) => `blob:fs-${path}`);
    const cache = new ThumbBlobCache(fakeApi(vi.fn()), fakeFsBrowse(getThumbBlobUrl));
    cache.ensure('k1', null, '/x/a.jpg', null);
    await settle();
    expect(getThumbBlobUrl).toHaveBeenCalledWith('/x/a.jpg');
    expect(cache.url('k1')).toBe('blob:fs-/x/a.jpg');
  });

  it('is used when address is given but no librarySource was supplied to the constructor', async () => {
    const getThumbBlobUrl = vi.fn(async () => 'blob:fs-url');
    const getThumb = vi.fn(() => of(blob()));
    // No third constructor arg — librarySource is undefined, so the address
    // route is unavailable even though ensure() is handed an address.
    const cache = new ThumbBlobCache(fakeApi(getThumb), fakeFsBrowse(getThumbBlobUrl));
    cache.ensure('k1', 'lib:a.jpg', '/x/a.jpg', null);
    await settle();
    expect(getThumbBlobUrl).toHaveBeenCalledWith('/x/a.jpg');
    // Falls back to absPath specifically — not past it to the apiAssetId
    // route, the only other branch reachable from here. (Asserting on a
    // `thumbBlob` mock instead would be vacuous: with no librarySource
    // passed to the constructor, nothing could ever call it.)
    expect(getThumb).not.toHaveBeenCalled();
  });

  it("a borrowed url is never revoked by destroy() — it's owned by FilesystemBrowseService", async () => {
    await withStubbedBlobUrls(async (calls) => {
      const getThumbBlobUrl = vi.fn(async () => 'blob:fs-shared-with-browse');
      const cache = new ThumbBlobCache(fakeApi(vi.fn()), fakeFsBrowse(getThumbBlobUrl));
      cache.ensure('k1', null, '/x/a.jpg', null);
      await settle();
      expect(cache.url('k1')).toBe('blob:fs-shared-with-browse');
      cache.destroy();
      expect(calls.revoked).toEqual([]);
      // destroy() must not have torn down the entry, only the revocation
      // side-effect it doesn't own.
      expect(cache.url('k1')).toBe('blob:fs-shared-with-browse');
    });
  });
});

describe('ThumbBlobCache.ensure — address route', () => {
  it('parses slug:relPath on the FIRST colon and calls librarySource.thumbBlob', async () => {
    await withStubbedBlobUrls(async () => {
      const thumbBlob = vi.fn(async () => blob());
      const cache = new ThumbBlobCache(
        fakeApi(vi.fn()),
        fakeFsBrowse(vi.fn()),
        fakeLibrarySource(thumbBlob),
      );
      // A relPath containing a colon must stay intact after the first split.
      cache.ensure('k1', 'lib1:a:b.jpg', null, null);
      await settle();
      expect(thumbBlob).toHaveBeenCalledWith({ slug: 'lib1', relPath: 'a:b.jpg' });
    });
  });

  it('takes priority over absPath / apiAssetId when both a librarySource and an address are present', async () => {
    await withStubbedBlobUrls(async () => {
      const thumbBlob = vi.fn(async () => blob());
      const getThumbBlobUrl = vi.fn(async () => 'blob:fs-url');
      const getThumb = vi.fn(() => of(blob()));
      const cache = new ThumbBlobCache(
        fakeApi(getThumb),
        fakeFsBrowse(getThumbBlobUrl),
        fakeLibrarySource(thumbBlob),
      );
      cache.ensure('k1', 'lib1:a.jpg', '/x/a.jpg', 'asset-1');
      await settle();
      expect(thumbBlob).toHaveBeenCalledTimes(1);
      expect(getThumbBlobUrl).not.toHaveBeenCalled();
      expect(getThumb).not.toHaveBeenCalled();
    });
  });

  it('mints and caches an OWNED blob url via URL.createObjectURL', async () => {
    await withStubbedBlobUrls(async (calls) => {
      const thumbBlob = vi.fn(async () => blob());
      const cache = new ThumbBlobCache(
        fakeApi(vi.fn()),
        fakeFsBrowse(vi.fn()),
        fakeLibrarySource(thumbBlob),
      );
      cache.ensure('k1', 'lib1:a.jpg', null, null);
      await settle();
      expect(calls.created).toHaveLength(1);
      expect(cache.url('k1')).toBe(calls.created[0]);
    });
  });

  it('rejects (and does not cache) an empty/null blob from LibrarySource', async () => {
    await withStubbedBlobUrls(async (calls) => {
      const thumbBlob = vi.fn(async () => null);
      const cache = new ThumbBlobCache(
        fakeApi(vi.fn()),
        fakeFsBrowse(vi.fn()),
        fakeLibrarySource(thumbBlob),
      );
      cache.ensure('k1', 'lib1:a.jpg', null, null);
      await settle();
      expect(cache.url('k1')).toBeNull();
      expect(calls.created).toEqual([]);
    });
  });
});

describe('ThumbBlobCache.ensure — apiAssetId route', () => {
  it('fetches via api.getThumb and mints an OWNED blob url', async () => {
    await withStubbedBlobUrls(async (calls) => {
      const getThumb = vi.fn((id: string) => of(blob(id)));
      const cache = new ThumbBlobCache(fakeApi(getThumb), fakeFsBrowse(vi.fn()));
      cache.ensure('k1', null, null, 'asset-42');
      await settle();
      expect(getThumb).toHaveBeenCalledWith('asset-42');
      expect(calls.created).toHaveLength(1);
      expect(cache.url('k1')).toBe(calls.created[0]);
    });
  });

  it('is the last resort — used only when there is neither an address nor an absPath', async () => {
    await withStubbedBlobUrls(async () => {
      const getThumb = vi.fn(() => of(blob()));
      const getThumbBlobUrl = vi.fn(async () => 'blob:fs-url');
      const cache = new ThumbBlobCache(fakeApi(getThumb), fakeFsBrowse(getThumbBlobUrl));
      cache.ensure('k1', null, '/x/a.jpg', 'asset-42');
      await settle();
      expect(getThumbBlobUrl).toHaveBeenCalledTimes(1);
      expect(getThumb).not.toHaveBeenCalled();
    });
  });

  it('clears inflight and leaves the key unresolved when api.getThumb errors', async () => {
    const getThumb = vi.fn(() => throwError(() => new Error('404')));
    const cache = new ThumbBlobCache(fakeApi(getThumb), fakeFsBrowse(vi.fn()));
    cache.ensure('k1', null, null, 'asset-42');
    await settle();
    expect(cache.url('k1')).toBeNull();
    // A retry after the failure must fire a fresh request, not be swallowed
    // by a stale `inflight` entry.
    cache.ensure('k1', null, null, 'asset-42');
    await settle();
    expect(getThumb).toHaveBeenCalledTimes(2);
  });
});

describe('ThumbBlobCache.ensure — dedup', () => {
  it('does not re-fetch while a request for the same key is already in flight', async () => {
    await withStubbedBlobUrls(async () => {
      const thumbBlob = vi.fn(async () => blob());
      const cache = new ThumbBlobCache(
        fakeApi(vi.fn()),
        fakeFsBrowse(vi.fn()),
        fakeLibrarySource(thumbBlob),
      );
      cache.ensure('k1', 'lib1:a.jpg', null, null);
      cache.ensure('k1', 'lib1:a.jpg', null, null);
      cache.ensure('k1', 'lib1:a.jpg', null, null);
      await settle();
      expect(thumbBlob).toHaveBeenCalledTimes(1);
    });
  });

  it('does not re-fetch once the key is already cached', async () => {
    await withStubbedBlobUrls(async () => {
      const getThumbBlobUrl = vi.fn(async () => 'blob:fs-url');
      const cache = new ThumbBlobCache(fakeApi(vi.fn()), fakeFsBrowse(getThumbBlobUrl));
      cache.ensure('k1', null, '/x/a.jpg', null);
      await settle();
      expect(getThumbBlobUrl).toHaveBeenCalledTimes(1);
      cache.ensure('k1', null, '/x/a.jpg', null);
      await settle();
      expect(getThumbBlobUrl).toHaveBeenCalledTimes(1);
    });
  });

  it('tracks distinct keys independently', async () => {
    await withStubbedBlobUrls(async () => {
      const getThumbBlobUrl = vi.fn(async (path: string) => `blob:fs-${path}`);
      const cache = new ThumbBlobCache(fakeApi(vi.fn()), fakeFsBrowse(getThumbBlobUrl));
      cache.ensure('k1', null, '/x/a.jpg', null);
      cache.ensure('k2', null, '/x/b.jpg', null);
      await settle();
      expect(cache.url('k1')).toBe('blob:fs-/x/a.jpg');
      expect(cache.url('k2')).toBe('blob:fs-/x/b.jpg');
    });
  });
});

describe('ThumbBlobCache.destroy', () => {
  it('revokes every OWNED url exactly once and never touches a BORROWED one', async () => {
    await withStubbedBlobUrls(async (calls) => {
      const thumbBlob = vi.fn(async () => blob('owned-a'));
      const getThumb = vi.fn(() => of(blob('owned-b')));
      const getThumbBlobUrl = vi.fn(async () => 'blob:borrowed-c');
      const cache = new ThumbBlobCache(
        fakeApi(getThumb),
        fakeFsBrowse(getThumbBlobUrl),
        fakeLibrarySource(thumbBlob),
      );
      cache.ensure('owned-via-address', 'lib1:a.jpg', null, null);
      cache.ensure('owned-via-apiId', null, null, 'asset-1');
      cache.ensure('borrowed-via-abspath', null, '/x/c.jpg', null);
      await settle();
      expect(calls.created).toHaveLength(2); // the two owned mints
      const ownedUrls = [...calls.created];
      const borrowedUrl = cache.url('borrowed-via-abspath');
      cache.destroy();
      expect(calls.revoked.sort()).toEqual(ownedUrls.sort());
      expect(calls.revoked).not.toContain(borrowedUrl);
    });
  });

  it('is idempotent — a second destroy() does not re-revoke', async () => {
    await withStubbedBlobUrls(async (calls) => {
      const thumbBlob = vi.fn(async () => blob());
      const cache = new ThumbBlobCache(
        fakeApi(vi.fn()),
        fakeFsBrowse(vi.fn()),
        fakeLibrarySource(thumbBlob),
      );
      cache.ensure('k1', 'lib1:a.jpg', null, null);
      await settle();
      cache.destroy();
      expect(calls.revoked).toHaveLength(1);
      cache.destroy();
      expect(calls.revoked).toHaveLength(1); // unchanged — not revoked twice
    });
  });

  it('is a no-op when nothing was ever fetched', () => {
    const cache = new ThumbBlobCache(fakeApi(vi.fn()), fakeFsBrowse(vi.fn()));
    expect(() => cache.destroy()).not.toThrow();
  });
});
