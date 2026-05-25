// InMemoryFolderListingCache — unit tests for the cache contract consumed by
// LibraryFetch's stale-while-revalidate directory reads. The IndexedDB
// implementation shares the same contract; tests run against the in-memory
// variant so they don't need a real IDB.

import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryFolderListingCache } from './folder-listing-cache';
import { FsDirListing } from './filesystem-browse.service';

function listing(path: string, dirCount = 0): FsDirListing {
  return {
    path,
    parent: null,
    dirs: Array.from({ length: dirCount }, (_, i) => ({
      name: `d${i}`,
      path: `${path}/d${i}`,
      mtime: '2026-01-01T00:00:00.000Z',
    })),
    images: [],
  };
}

describe('InMemoryFolderListingCache', () => {
  let cache: InMemoryFolderListingCache;

  beforeEach(() => {
    cache = new InMemoryFolderListingCache();
  });

  it('peek returns null for an unknown path', () => {
    expect(cache.peek('/Lib')).toBeNull();
  });

  it('peek returns the listing synchronously after put', () => {
    const l = listing('/Lib', 2);
    cache.put('/Lib', l);
    expect(cache.peek('/Lib')).toBe(l);
  });

  it('get resolves null for an unknown path and the listing once cached', async () => {
    expect(await cache.get('/Lib')).toBeNull();
    const l = listing('/Lib', 1);
    cache.put('/Lib', l);
    expect(await cache.get('/Lib')).toBe(l);
  });

  it('put overwrites a prior listing for the same path (revalidation)', () => {
    cache.put('/Lib', listing('/Lib', 1));
    const fresh = listing('/Lib', 3);
    cache.put('/Lib', fresh);
    expect(cache.peek('/Lib')).toBe(fresh);
    expect(cache.peek('/Lib')!.dirs.length).toBe(3);
  });

  it('clear empties the cache', async () => {
    cache.put('/Lib', listing('/Lib'));
    await cache.clear();
    expect(cache.peek('/Lib')).toBeNull();
    expect(await cache.get('/Lib')).toBeNull();
  });
});
