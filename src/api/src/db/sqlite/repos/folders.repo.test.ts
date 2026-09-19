/**
 * The library-root registry, and the path cache the change feed leans on.
 *
 * Two groups of cases. The first is the registration contract — a path and a
 * slug are each unique, and the route has to be able to tell those two
 * collisions apart, because one means "already registered" and the other means
 * "retry with a different slug". The second is the cache: it never invalidates,
 * so the tests pin the two properties that makes safe — a miss is not cached,
 * and registering a library afterwards is still visible.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { ObjectId } from '../../object-id.ts';
import { createTestDatabase, testSqliteDb } from '../test-sqlite.test-helpers.ts';
import * as foldersRepo from './folders.repo.ts';
import {
  __resetFolderPathCacheForTests,
  findFolderById,
  findFolderByPath,
  folderPath,
  registerFolder,
  isSlugConflict,
  listFolders,
  listFolderSlugs,
  listFoldersWithMirrors,
  listLibraryRoots,
  setFolderLastScan,
  setFolderMirrors,
} from './folders.repo.ts';
import type { SqliteDb } from './db-handle.ts';

afterEach(() => {
  __resetFolderPathCacheForTests();
});

function library(n: number) {
  return { path: `/libraries/${n}`, label: `Library ${n}`, slug: `library-${n}` };
}

async function seed(db: SqliteDb, n: number, createdAt?: string) {
  return await registerFolder({ ...library(n), ...(createdAt ? { createdAt } : {}) }, db);
}

describe('registration', () => {
  test('a registered library round-trips its fields', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await registerFolder(
      { path: '/photos', label: 'Photos', slug: 'photos', createdAt: '2026-01-01T00:00:00.000Z' },
      db,
    );
    expect(await findFolderById(id, db)).toEqual({
      _id: id,
      path: '/photos',
      slug: 'photos',
      label: 'Photos',
      last_scan: null,
      file_count: 0,
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  test('a library with no mirrors has no mirrors key at all', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await seed(db, 1);
    expect(await findFolderById(id, db)).not.toHaveProperty('mirrors');
  });

  test('an unknown id is null, not a throw', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await findFolderById(new ObjectId(), db)).toBeNull();
  });

  test('registering the same path twice is refused', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await registerFolder({ path: '/photos', label: 'A', slug: 'a' }, db);
    const error = await registerFolder({ path: '/photos', label: 'B', slug: 'b' }, db).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    // A duplicate path means "already registered", which the route answers with
    // a 409 naming the existing library — never a slug retry.
    expect(isSlugConflict(error)).toBe(false);
  });

  test('a duplicate slug is recognised as the collision worth retrying', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await registerFolder({ path: '/a', label: 'A', slug: 'shared' }, db);
    const error = await registerFolder({ path: '/b', label: 'B', slug: 'shared' }, db).catch(
      (e: unknown) => e,
    );
    expect(isSlugConflict(error)).toBe(true);
  });

  test('listFolderSlugs gives the registration route its taken set', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seed(db, 1);
    await seed(db, 2);
    expect((await listFolderSlugs(db)).sort()).toEqual(['library-1', 'library-2']);
  });

  test('findFolderByPath is how the route detects an existing registration', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await seed(db, 1);
    expect((await findFolderByPath('/libraries/1', db))?._id.toHexString()).toBe(id.toHexString());
    expect(await findFolderByPath('/libraries/9', db)).toBeNull();
  });
});

describe('listing', () => {
  test('listFolders is oldest first', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seed(db, 1, '2026-06-01T00:00:00.000Z');
    await seed(db, 2, '2026-01-01T00:00:00.000Z');
    expect((await listFolders(db)).map((f) => f.slug)).toEqual(['library-2', 'library-1']);
  });

  test('listLibraryRoots carries identity and root, and no mirror payload', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await seed(db, 1);
    await setFolderMirrors(id, [{ path: '/mirror', enabled: true }], db);
    const roots = await listLibraryRoots(db);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toEqual({
      id,
      path: '/libraries/1',
      slug: 'library-1',
      label: 'Library 1',
    });
  });
});

describe('mutations', () => {
  test('a scan stamps its completion time', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await seed(db, 1);
    await setFolderLastScan(id, '2026-09-18T10:00:00.000Z', db);
    expect((await findFolderById(id, db))?.last_scan).toBe('2026-09-18T10:00:00.000Z');
  });

  test('mirrors are replaced wholesale, disabled entries included', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await seed(db, 1);
    await setFolderMirrors(
      id,
      [
        { path: '/mirror-a', enabled: true },
        { path: '/mirror-b', enabled: false },
      ],
      db,
    );
    expect((await findFolderById(id, db))?.mirrors).toEqual([
      { path: '/mirror-a', enabled: true },
      { path: '/mirror-b', enabled: false },
    ]);

    await setFolderMirrors(id, [{ path: '/mirror-c', enabled: true }], db);
    expect((await findFolderById(id, db))?.mirrors).toEqual([{ path: '/mirror-c', enabled: true }]);
  });

  test('a library whose last mirror was removed drops out of the registry build', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const withMirror = await seed(db, 1);
    const emptied = await seed(db, 2);
    await seed(db, 3);
    await setFolderMirrors(withMirror, [{ path: '/mirror-a', enabled: true }], db);
    await setFolderMirrors(emptied, [], db);

    expect(await listFoldersWithMirrors(db)).toEqual([
      { path: '/libraries/1', mirrors: [{ path: '/mirror-a', enabled: true }] },
    ]);
  });
});

describe('the folder-path cache', () => {
  test('resolves a library root and serves the next lookup from memory', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await seed(db, 1);
    expect(await folderPath(id, db)).toBe('/libraries/1');

    // Prove the second call does not go to the database: remove the row and
    // ask again. A cache that re-read would answer null.
    await db.write(`DELETE FROM folders WHERE id = ?`, [id.toHexString()]);
    expect(await folderPath(id, db)).toBe('/libraries/1');
  });

  test('a miss is not cached, so a library registered afterwards is visible', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = new ObjectId();
    expect(await folderPath(id, db)).toBeNull();

    await db.write(
      `INSERT INTO folders (id, path, slug, label, file_count, created_at)
       VALUES (?, '/late', 'late', 'Late', 0, ?)`,
      [id.toHexString(), '2026-01-01T00:00:00.000Z'],
    );
    expect(await folderPath(id, db)).toBe('/late');
  });

  test('two libraries do not answer for each other', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const first = await seed(db, 1);
    const second = await seed(db, 2);
    expect(await folderPath(first, db)).toBe('/libraries/1');
    expect(await folderPath(second, db)).toBe('/libraries/2');
  });

  test('no exported function can change a path, which is what makes the cache safe', () => {
    // The guarantee is structural rather than runtime: this module owns every
    // write to `folders`, and none of them touches `path`. Adding one is what
    // would make a cached path go stale, so this list is where the
    // invalidation gets remembered — a new writer fails here first.
    const writers = Object.keys(foldersRepo).filter(
      (name) =>
        name.startsWith('set') ||
        name.startsWith('register') ||
        name.startsWith('insert') ||
        name.startsWith('delete'),
    );
    expect(writers.sort()).toEqual(['registerFolder', 'setFolderLastScan', 'setFolderMirrors']);
  });
});
