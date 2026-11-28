import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  makeTotalCacheKey,
  getCachedTotal,
  getCachedSavedSearchTotal,
  savedSearchCountKey,
  _resetCacheForTests,
} from './total-cache.ts';
import { assetsDb } from '../../db/repos/db-handle.ts';
import type { SearchQuery } from './query.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { buildSearchWhere } from '../../db/repos/search.repo.ts';

describe('makeTotalCacheKey — owner isolation', () => {
  it('produces distinct keys for different owners and absent owner', () => {
    const ownerA = '664000000000000000000001';
    const ownerB = '664000000000000000000002';
    const keyA = makeTotalCacheKey({ ownerId: ownerA } as SearchQuery);
    const keyB = makeTotalCacheKey({ ownerId: ownerB } as SearchQuery);
    const keyAbsent = makeTotalCacheKey({} as SearchQuery);

    expect(new Set([keyA, keyB, keyAbsent]).size).toBe(3);
  });

  it('produces identical keys for ownerId and owner_id with same value', () => {
    const owner = '664000000000000000000001';
    const keyCamel = makeTotalCacheKey({ ownerId: owner } as SearchQuery);
    const keySnake = makeTotalCacheKey({ owner_id: owner } as SearchQuery);
    expect(keyCamel).toBe(keySnake);
  });

  it('normalizes uppercase owner hex in the cache key', () => {
    const keyLower = makeTotalCacheKey({ ownerId: '66400000000000000000000a' } as SearchQuery);
    const keyUpper = makeTotalCacheKey({ ownerId: '66400000000000000000000A' } as SearchQuery);
    expect(keyLower).toBe(keyUpper);
  });
});

describe('getCachedTotal — cross-owner cache isolation', () => {
  let live: LiveTestDatabase;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    _resetCacheForTests();
  });

  afterEach(() => {
    _resetCacheForTests();
    live.close();
  });

  it('does not share cached count across different owners', async () => {
    const ownerA = '664000000000000000000001';
    const ownerB = '664000000000000000000002';

    run(
      live.db,
      `INSERT INTO users (id, email, email_key, role, created_at) VALUES (?, ?, ?, 'owner', ?)`,
      ownerA,
      'a@example.com',
      'a@example.com',
      new Date().toISOString(),
    );
    run(
      live.db,
      `INSERT INTO users (id, email, email_key, role, created_at) VALUES (?, ?, ?, 'member', ?)`,
      ownerB,
      'b@example.com',
      'b@example.com',
      new Date().toISOString(),
    );

    const folderId = insertFolder(live.db, { path: '/test-lib' });

    // 1 asset for owner A, 2 assets for owner B
    const a1 = insertAsset(live.db);
    insertLocation(live.db, { assetId: a1, libraryId: folderId, path: '', filename: 'a1.dng' });
    run(live.db, `UPDATE assets SET owner_id = ? WHERE id = ?`, ownerA, a1);

    const b1 = insertAsset(live.db);
    insertLocation(live.db, { assetId: b1, libraryId: folderId, path: '', filename: 'b1.dng' });
    const b2 = insertAsset(live.db);
    insertLocation(live.db, { assetId: b2, libraryId: folderId, path: '', filename: 'b2.dng' });
    run(live.db, `UPDATE assets SET owner_id = ? WHERE id = ?`, ownerB, b1);
    run(live.db, `UPDATE assets SET owner_id = ? WHERE id = ?`, ownerB, b2);

    const queryA = { ownerId: ownerA } as SearchQuery;
    const whereA = buildSearchWhere(queryA);
    if ('error' in whereA) throw new Error(whereA.error);

    const queryB = { ownerId: ownerB } as SearchQuery;
    const whereB = buildSearchWhere(queryB);
    if ('error' in whereB) throw new Error(whereB.error);

    const countA = await getCachedTotal(queryA, whereA);
    expect(countA).toBe(1);

    // If cache keys collided, this would mistakenly return 1 instead of 2.
    const countB = await getCachedTotal(queryB, whereB);
    expect(countB).toBe(2);
  });
});

describe('getCachedSavedSearchTotal — a saved search counts once per 30 s (#6176)', () => {
  let live: LiveTestDatabase;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    _resetCacheForTests();
  });

  afterEach(() => {
    _resetCacheForTests();
    live.close();
  });

  function addPhoto(libraryId: string, filename: string): void {
    const assetId = insertAsset(live.db);
    insertLocation(live.db, { assetId, libraryId, path: '', filename });
  }

  function whereFor(query: SearchQuery) {
    const where = buildSearchWhere(query);
    if ('error' in where) throw new Error(where.error);
    return where;
  }

  it('answers a repeat page from the first count until 30 s have passed', async () => {
    const trips = insertFolder(live.db, { path: '/trips', slug: 'trips' });
    addPhoto(trips, 'a.dng');
    const where = whereFor({ libraryId: trips } as SearchQuery);
    const now = spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      expect(await getCachedSavedSearchTotal(where, assetsDb())).toBe(1);
      addPhoto(trips, 'b.dng');
      now.mockReturnValue(1_000_000 + 29_999);
      expect(await getCachedSavedSearchTotal(where, assetsDb())).toBe(1);
      now.mockReturnValue(1_000_000 + 30_000);
      expect(await getCachedSavedSearchTotal(where, assetsDb())).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  it('never shares a count between libraries or filters', async () => {
    const trips = insertFolder(live.db, { path: '/trips', slug: 'trips' });
    const home = insertFolder(live.db, { path: '/home', slug: 'home' });
    addPhoto(trips, 'a.dng');
    addPhoto(home, 'b.dng');
    addPhoto(home, 'c.dng');
    run(
      live.db,
      `UPDATE assets SET exif = json_object('captured_at', '2020-06-01T00:00:00Z', 'captured_year', 2020, 'captured_month', 6)`,
    );

    expect(
      await getCachedSavedSearchTotal(whereFor({ libraryId: trips } as SearchQuery), assetsDb()),
    ).toBe(1);
    expect(
      await getCachedSavedSearchTotal(whereFor({ libraryId: home } as SearchQuery), assetsDb()),
    ).toBe(2);
    const homeLater = whereFor({ libraryId: home, from: '2021-01-01' } as SearchQuery);
    expect(await getCachedSavedSearchTotal(homeLater, assetsDb())).toBe(0);
  });

  it('keeps the saved-search count apart from a search total over the same filter', async () => {
    const trips = insertFolder(live.db, { path: '/trips', slug: 'trips' });
    addPhoto(trips, 'a.dng');
    const query = { libraryId: trips } as SearchQuery;
    expect(await getCachedTotal(query, whereFor(query))).toBe(1);
    addPhoto(trips, 'b.dng');
    expect(await getCachedSavedSearchTotal(whereFor(query), assetsDb())).toBe(2);
  });
});

describe('savedSearchCountKey (#6176)', () => {
  it('gives values that print alike but differ in type their own keys', () => {
    const keys = [
      '5',
      5,
      5n,
      '5n',
      true,
      'true',
      1,
      null,
      'null',
      new Uint8Array([5]),
      '05',
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ].map((value) => savedSearchCountKey({ sql: 'SELECT ?', params: [value] }));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('cachedTotal bounds (#6176)', () => {
  let live: LiveTestDatabase;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    _resetCacheForTests();
  });

  afterEach(() => {
    _resetCacheForTests();
    live.close();
  });

  it('does not keep a count that failed', async () => {
    const where = buildSearchWhere({} as SearchQuery);
    if ('error' in where) throw new Error(where.error);
    const failing = {
      ...assetsDb(),
      read: () => Promise.reject(new Error('reader closed')),
    };
    await expect(getCachedSavedSearchTotal(where, failing)).rejects.toThrow('reader closed');
    expect(await getCachedSavedSearchTotal(where, assetsDb())).toBe(0);
  });

  it('refreshing an expired entry in a full cache keeps the live ones', async () => {
    const where = (query: SearchQuery) => {
      const built = buildSearchWhere(query);
      if ('error' in built) throw new Error(built.error);
      return built;
    };
    const kept = { libraryId: insertFolder(live.db, { path: '/kept' }) } as SearchQuery;
    const expiring = { libraryId: 'f'.repeat(24) } as SearchQuery;
    const now = spyOn(Date, 'now').mockReturnValue(0);
    try {
      await getCachedTotal(kept, where(kept));
      now.mockReturnValue(1);
      await getCachedTotal(expiring, where(expiring));
      now.mockReturnValue(31_000);
      await getCachedTotal(kept, where(kept));
      for (let i = 0; i < 498; i++) {
        const filler = { libraryId: (i + 1).toString(16).padStart(24, '0') } as SearchQuery;
        await getCachedTotal(filler, where(filler));
      }
      now.mockReturnValue(32_000);
      await getCachedTotal(expiring, where(expiring));
      const asset = insertAsset(live.db);
      insertLocation(live.db, {
        assetId: asset,
        libraryId: kept.libraryId!,
        path: '',
        filename: 'a.dng',
      });
      expect(await getCachedTotal(kept, where(kept))).toBe(0);
    } finally {
      now.mockRestore();
    }
  });
});
