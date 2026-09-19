/**
 * The Timeline histogram.
 *
 * The property worth pinning is the split: a bucketed month and an undated
 * asset are two different answers, and the histogram's own total counts only
 * what a bar can represent. Getting that wrong is how an asset with no capture
 * date becomes invisible in one view and double-counted in another.
 */

import { describe, expect, test } from 'bun:test';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import { searchBuckets } from './search.buckets.ts';
import { searchCount } from './search.page.ts';
import { buildSearchWhere, type SearchWhere } from './search.where.ts';
import { seedSearchLibrary } from './search.test-helpers.ts';
import type { SearchQuery } from '../../routes/search/query-schema.ts';

function translate(q: SearchQuery): SearchWhere {
  const built = buildSearchWhere(q);
  if ('error' in built) throw new Error(built.error);
  return built;
}

describe('searchBuckets', () => {
  test('one bucket per month that has photos, newest first', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    const result = await searchBuckets(translate({}), testSqliteDb(handle.db));

    expect(result.buckets[0]).toEqual({ year: 2024, month: 6, count: 2 });
    const keys = result.buckets.map((bucket) => `${bucket.year}-${bucket.month}`);
    expect(keys).toEqual(['2024-6', '2024-4', '2024-2', '2023-8', '2022-3', '2021-12']);
  });

  test('the dated total plus the undated count is the full match set', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    const db = testSqliteDb(handle.db);
    const where = translate({});

    const result = await searchBuckets(where, db);
    // `total` deliberately counts only what a bar can represent, which is why
    // the undated rows are reported separately rather than folded in.
    expect(result.untimed_count).toBe(1);
    expect(result.total + result.untimed_count).toBe(await searchCount(where, db));
  });

  test('a filter narrows the histogram with everything else', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    const db = testSqliteDb(handle.db);

    const result = await searchBuckets(translate({ camera: 'SONY' }), db);
    expect(result.buckets).toEqual([{ year: 2023, month: 8, count: 2 }]);
    expect(result.untimed_count).toBe(0);
  });

  test('the excluded assets are absent from the histogram too', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    const db = testSqliteDb(handle.db);

    // All three non-live fixtures carry the default June 2024 capture date, so
    // a histogram that leaked them would show up right here.
    const result = await searchBuckets(translate({ hidden: 'all' }), db);
    expect(result.buckets.find((b) => b.year === 2024 && b.month === 6)?.count).toBe(2);
  });

  test('a full-text query narrows the histogram to its matches', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    const db = testSqliteDb(handle.db);

    const result = await searchBuckets(translate({ placeQuery: 'lanterns' }), db);
    expect(result.buckets).toEqual([{ year: 2023, month: 8, count: 1 }]);
  });
});
