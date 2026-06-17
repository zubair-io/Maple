// InMemoryFolderListingCache — unit tests for the cache contract consumed by
// LibraryFetch's stale-while-revalidate directory reads. The IndexedDB
// implementation shares the same contract; tests run against the in-memory
// variant so they don't need a real IDB.
//
// After M2 (Task 9) the cache key is a `slug:relPath` address string and the
// value is a `FolderListing` (LibrarySource contract) rather than FsDirListing.

import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryFolderListingCache } from './folder-listing-cache';
import type { FolderListing } from '../addressing/library-source';

function listing(address: string, folderCount = 0): FolderListing {
  const colonIdx = address.indexOf(':');
  const slug = colonIdx >= 0 ? address.slice(0, colonIdx) : 'lib';
  const relPath = colonIdx >= 0 ? address.slice(colonIdx + 1) : '';
  return {
    address,
    parent: null,
    folders: Array.from({ length: folderCount }, (_, i) => ({
      name: `d${i}`,
      address: `${slug}:${relPath ? relPath + '/' : ''}d${i}`,
    })),
    images: [],
  };
}

describe('InMemoryFolderListingCache', () => {
  let cache: InMemoryFolderListingCache;

  beforeEach(() => {
    cache = new InMemoryFolderListingCache();
  });

  it('peek returns null for an unknown address', () => {
    expect(cache.peek('lib:')).toBeNull();
  });

  it('peek returns the listing synchronously after put', () => {
    const l = listing('lib:', 2);
    cache.put('lib:', l);
    expect(cache.peek('lib:')).toBe(l);
  });

  it('get resolves null for an unknown address and the listing once cached', async () => {
    expect(await cache.get('lib:')).toBeNull();
    const l = listing('lib:', 1);
    cache.put('lib:', l);
    expect(await cache.get('lib:')).toBe(l);
  });

  it('put overwrites a prior listing for the same address (revalidation)', () => {
    cache.put('lib:', listing('lib:', 1));
    const fresh = listing('lib:', 3);
    cache.put('lib:', fresh);
    expect(cache.peek('lib:')).toBe(fresh);
    expect(cache.peek('lib:')!.folders.length).toBe(3);
  });

  it('clear empties the cache', async () => {
    cache.put('lib:', listing('lib:'));
    await cache.clear();
    expect(cache.peek('lib:')).toBeNull();
    expect(await cache.get('lib:')).toBeNull();
  });

  it('stores and retrieves listings keyed by sub-folder address', () => {
    const sub = listing('lib:2026/jan', 0);
    cache.put('lib:2026/jan', sub);
    expect(cache.peek('lib:2026/jan')).toBe(sub);
    expect(cache.peek('lib:')).toBeNull(); // different key
  });
});
