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

import { beforeEach, describe, expect, test } from 'bun:test';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { getLibraryBySlug, invalidateLibraryRoots, loadLibraryRoots } from './libraries.cache.ts';

beforeEach(() => {
  invalidateLibraryRoots();
});

describe('loadLibraryRoots', () => {
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
