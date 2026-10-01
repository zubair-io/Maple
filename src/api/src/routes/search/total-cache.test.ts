import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { makeTotalCacheKey, getCachedTotal, _resetCacheForTests } from './total-cache.ts';
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
