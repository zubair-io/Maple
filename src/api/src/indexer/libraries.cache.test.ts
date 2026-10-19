/**
 * The process-wide library-roots cache.
 *
 * The interesting behaviour is not the read — `folders.repo.ts` owns that — but
 * what the cache does between reads. It has no TTL, so a second lookup is
 * served from memory and a caller that mutates `folders` without calling
 * `invalidateLibraryRoots()` keeps seeing the old map indefinitely. Each case
 * below therefore writes behind the cache's back and asserts what the next
 * lookup sees.
 *
 * The cache lives at module scope and outlives any one test, so every case
 * starts from an invalidated one.
 */

import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { ObjectId } from '../db/object-id.ts';
import * as foldersRepo from '../db/repos/folders.repo.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import {
  UNKNOWN_LIBRARY_RELOAD_MIN_INTERVAL_MS,
  getLibraryBySlug,
  hasUnregisteredLibrary,
  invalidateLibraryRoots,
  loadLibraryRoots,
  loadLibraryRootsForAsset,
  loadJailLibraryRoots,
  setLibraryRootsForTests,
} from './libraries.cache.ts';

beforeEach(() => {
  invalidateLibraryRoots();
});

describe('loadLibraryRoots', () => {
  test('concurrent cold readers share the same jail generation', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/srv/lib-a', slug: 'lib-a' });

    const [first, second, jail, slug] = await Promise.all([
      loadLibraryRoots(),
      loadLibraryRoots(),
      loadJailLibraryRoots(),
      getLibraryBySlug('lib-a'),
    ]);

    expect(second).toBe(first);
    expect(jail).toBe(first);
    expect(await loadJailLibraryRoots()).toBe(first);
    expect(slug?.root).toBe('/srv/lib-a');
  });

  test.each(['invalidate', 'reset'] as const)(
    '%s detaches an old load without letting its completion clear the new load',
    async (mode) => {
      using live = await createLiveTestDatabase();
      insertFolder(live.db, { path: '/srv/lib-a' });
      const obsolete = Promise.withResolvers<foldersRepo.LibraryRoot[]>();
      const current = Promise.withResolvers<foldersRepo.LibraryRoot[]>();
      const reader = spyOn(foldersRepo, 'listLibraryRoots')
        .mockImplementationOnce(() => obsolete.promise)
        .mockImplementationOnce(() => current.promise);
      try {
        const oldRead = loadLibraryRoots();
        if (mode === 'invalidate') invalidateLibraryRoots();
        else setLibraryRootsForTests(null);
        const newRead = loadLibraryRoots();
        obsolete.resolve([]);
        expect((await oldRead).size).toBe(0);
        const concurrent = loadJailLibraryRoots();
        const rows = [{ id: new ObjectId(), path: '/srv/lib-a', slug: 'a', label: 'A' }];
        current.resolve(rows);
        const roots = await newRead;
        expect(await concurrent).toBe(roots);
        expect(await loadJailLibraryRoots()).toBe(roots);
        expect([...roots.values()]).toEqual(['/srv/lib-a']);
        expect(reader).toHaveBeenCalledTimes(2);
      } finally {
        obsolete.resolve([]);
        current.resolve([]);
        reader.mockRestore();
      }
    },
  );

  test('a failed shared load can be retried', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/srv/lib-a' });
    const actualRead = foldersRepo.listLibraryRoots;
    const reader = spyOn(foldersRepo, 'listLibraryRoots')
      .mockRejectedValueOnce(new Error('Database unavailable'))
      .mockImplementation(actualRead);
    try {
      const results = await Promise.allSettled([loadLibraryRoots(), loadJailLibraryRoots()]);
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      expect(reader).toHaveBeenCalledTimes(1);
      expect([...(await loadJailLibraryRoots()).values()]).toEqual(['/srv/lib-a']);
      expect(reader).toHaveBeenCalledTimes(2);
    } finally {
      reader.mockRestore();
    }
  });

  test('returns a map keyed by hex id', async () => {
    using live = await createLiveTestDatabase();
    const id = insertFolder(live.db, { path: '/srv/lib-a' });

    expect((await loadLibraryRoots()).get(id)).toBe('/srv/lib-a');
  });

  test('returns the same map on a second call without refetching', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/x' });

    const first = await loadLibraryRoots();
    // Wipe behind the cache; the cached map should still be returned.
    run(live.db, `DELETE FROM folders`);
    const second = await loadLibraryRoots();

    expect(second).toBe(first);
    expect(second.size).toBe(1);
  });

  test('invalidate forces a re-read', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/x' });

    expect((await loadLibraryRoots()).size).toBe(1);

    invalidateLibraryRoots();
    run(live.db, `DELETE FROM folders`);

    expect((await loadLibraryRoots()).size).toBe(0);
  });

  test('a read in flight across an invalidation is not cached (#4747)', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/x' });

    const inFlight = loadLibraryRoots();
    run(live.db, `DELETE FROM folders`);
    invalidateLibraryRoots();
    await inFlight;

    expect((await loadLibraryRoots()).size).toBe(0);
  });
});

describe('getLibraryBySlug', () => {
  test('returns {libraryId, root, label} for a known slug', async () => {
    using live = await createLiveTestDatabase();
    const id = new ObjectId();
    // Inserted by hand rather than through `insertFolder`, which labels every
    // row 'Test library' — a distinctive label is what shows the value comes
    // off the row rather than out of a default.
    run(
      live.db,
      `INSERT INTO folders (id, path, slug, label, file_count, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      id.toHexString(),
      '/srv/lib-slug',
      'my-library',
      'My Library',
      '2026-06-16T00:00:00.000Z',
    );

    const result = await getLibraryBySlug('my-library');
    expect(result).not.toBeNull();
    expect(result!.root).toBe('/srv/lib-slug');
    expect(result!.label).toBe('My Library');
    expect(result!.libraryId.toHexString()).toBe(id.toHexString());
  });

  test('returns null for an unknown slug', async () => {
    // The database is opened and left empty on purpose: the answer has to be
    // "no library has that slug", not "the lookup never got as far as asking".
    using live = await createLiveTestDatabase();
    expect(live.db.query(`SELECT COUNT(*) AS n FROM folders`).get()).toEqual({ n: 0 });

    expect(await getLibraryBySlug('no-such-slug')).toBeNull();
  });

  test('invalidate forces reload that picks up a newly-inserted folder slug', async () => {
    using live = await createLiveTestDatabase();

    // Not yet present.
    expect(await getLibraryBySlug('fresh-library')).toBeNull();

    insertFolder(live.db, { path: '/srv/fresh', slug: 'fresh-library' });

    // Cache still stale — must not see it yet.
    expect(await getLibraryBySlug('fresh-library')).toBeNull();

    invalidateLibraryRoots();
    const result = await getLibraryBySlug('fresh-library');
    expect(result).not.toBeNull();
    expect(result!.root).toBe('/srv/fresh');
  });
});

describe('loadLibraryRootsForAsset', () => {
  const assetIn = (libraryId: string) => ({
    fileinfo: [{ library_id: new ObjectId(libraryId), deleted_at: null }],
  });

  afterEach(() => {
    setSystemTime();
  });

  test('re-reads once when a live location points at a library added after the cache filled', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/srv/original' });
    await loadLibraryRoots();
    setSystemTime(new Date(Date.now() + UNKNOWN_LIBRARY_RELOAD_MIN_INTERVAL_MS + 1));

    const addedLater = insertFolder(live.db, { path: '/srv/added-later' });
    const libs = await loadLibraryRootsForAsset(assetIn(addedLater));

    expect(libs.get(addedLater)).toBe('/srv/added-later');
  });

  test('does not re-read for a library the cache already knows', async () => {
    using live = await createLiveTestDatabase();
    const known = insertFolder(live.db, { path: '/srv/known' });
    const first = await loadLibraryRoots();
    setSystemTime(new Date(Date.now() + UNKNOWN_LIBRARY_RELOAD_MIN_INTERVAL_MS + 1));
    insertFolder(live.db, { path: '/srv/unseen' });

    expect(await loadLibraryRootsForAsset(assetIn(known))).toBe(first);
  });

  test('ignores soft-deleted locations when deciding whether to re-read', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/srv/original' });
    const first = await loadLibraryRoots();
    setSystemTime(new Date(Date.now() + UNKNOWN_LIBRARY_RELOAD_MIN_INTERVAL_MS + 1));
    const addedLater = insertFolder(live.db, { path: '/srv/added-later' });

    const libs = await loadLibraryRootsForAsset({
      fileinfo: [{ library_id: new ObjectId(addedLater), deleted_at: '2026-01-01T00:00:00Z' }],
    });

    expect(libs).toBe(first);
  });

  test('rate-limits re-reads for a library that stays unknown', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/srv/original' });
    await loadLibraryRoots();
    const addedLater = insertFolder(live.db, { path: '/srv/added-later' });

    const libs = await loadLibraryRootsForAsset(assetIn(addedLater));

    expect(libs.has(addedLater)).toBe(false);
    expect(hasUnregisteredLibrary(assetIn(addedLater), libs)).toBe(true);
  });
});
