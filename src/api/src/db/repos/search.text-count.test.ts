/**
 * A text search's total without a join per match (#4431) equals the joined
 * count, for every visibility case the fixture library carries: hidden,
 * trashed, replaced in place and missing from disk.
 */

import { expect, test } from 'bun:test';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import { countSql } from './search.sql.ts';
import { textCount, textOnlyCountSql } from './search.text-count.ts';
import { buildSearchWhere } from './search.where.ts';
import { seedSearchAsset, seedSearchLibrary } from './search.test-helpers.ts';
import type { SearchQuery } from '../../routes/search/query-schema.ts';

const QUERIES: SearchQuery[] = [
  { placeQuery: 'harbour' },
  { placeQuery: 'a private frame' },
  { placeQuery: 'new york' },
  { placeQuery: 'zeppelin' },
  { placeQuery: 'harbour', month: '6' },
  { placeQuery: 'private', hidden: 'all' },
  { placeQuery: 'private', hidden: 'only' },
  { placeQuery: 'new york', rating: '4' },
];

test('equals the joined count for every query and visibility case', async () => {
  using handle = await createTestDatabase();
  const { libraryId } = seedSearchLibrary(handle.db);
  for (const blob of ['harbour trashed', 'harbour vanished', 'harbour hidden']) {
    seedSearchAsset(handle.db, libraryId, {
      searchBlob: blob,
      deletedAt: blob.endsWith('trashed') ? '2024-07-01T00:00:00.000Z' : null,
      locationMissingSince: blob.endsWith('vanished') ? '2024-07-01T00:00:00.000Z' : null,
      hidden: blob.endsWith('hidden'),
      capturedAt: '2024-06-03T10:00:00.000Z',
    });
  }
  for (const q of QUERIES) {
    const where = buildSearchWhere(q);
    if ('error' in where) throw new Error(where.error);
    const joined = countSql(where);
    const expected = (
      handle.db.query(joined.sql).get(...(joined.params as never[])) as { n: number }
    ).n;
    expect({ q, n: await textCount(testSqliteDb(handle.db), where) }).toEqual({ q, n: expected });
  }
});

test('the join-free form is the one a text-only search uses', () => {
  const where = buildSearchWhere({ placeQuery: 'harbour' });
  if ('error' in where) throw new Error(where.error);
  expect(textOnlyCountSql(where).sql).toContain('assets_unlisted');
  expect(textOnlyCountSql(where).sql).not.toContain('JOIN assets ON');
});
