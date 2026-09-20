/**
 * What `libraryMaps()` is for after #3810 took the duplicate read out of it.
 *
 * Two claims, and the second is the reason the module still exists. It reads
 * through the shared library cache rather than issuing its own query — so a
 * search no longer pays a `folders` round trip the rest of the server has
 * already cached — and it answers with empty maps when the database cannot be
 * reached, where the cache underneath it throws.
 *
 * That second one is the projection's contract, not a nicety: `abs_path`
 * resolves to `''` and `address` to `null`, and both callers (`list.ts`,
 * `list-meili.ts`) render rows regardless. A search that comes back with
 * unresolved paths beats a 500.
 *
 * The cache lives at module scope and outlives any one case, so each starts
 * from an invalidated one.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { createLiveTestDatabase, insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { libraryMaps } from './libraries.ts';

beforeEach(() => {
  invalidateLibraryRoots();
});

describe('libraryMaps', () => {
  test('returns both maps for a registered library', async () => {
    using live = await createLiveTestDatabase();
    const id = insertFolder(live.db, { path: '/srv/lib-a', slug: 'lib-a' });

    const { libs, idToSlug } = await libraryMaps();

    expect(libs.get(id)).toBe('/srv/lib-a');
    expect(idToSlug.get(id)).toBe('lib-a');
  });

  test('degrades to empty maps when the database cannot be reached', async () => {
    // No pool is open in this case, so the read underneath throws. The
    // assertion is that nothing propagates: the projection would turn a throw
    // here into a 500 for a search that could otherwise have returned its rows.
    const { libs, idToSlug } = await libraryMaps();

    expect(libs.size).toBe(0);
    expect(idToSlug.size).toBe(0);
  });

  test('reads through the shared cache rather than re-querying', async () => {
    // The point of #3810. A row written behind the cache's back is invisible
    // until something invalidates, which is only true if this call is served
    // from the cache — a fresh `folders` read would see it immediately.
    using live = await createLiveTestDatabase();
    const first = insertFolder(live.db, { path: '/srv/lib-a', slug: 'lib-a' });
    expect((await libraryMaps()).libs.get(first)).toBe('/srv/lib-a');

    const second = insertFolder(live.db, { path: '/srv/lib-b', slug: 'lib-b' });
    expect((await libraryMaps()).libs.has(second)).toBe(false);

    invalidateLibraryRoots();
    expect((await libraryMaps()).libs.get(second)).toBe('/srv/lib-b');
  });
});
