/**
 * How far the score-only pass widens before it gives up (#4431).
 *
 * On the production snapshot a selective filter (`rating=4`, 1 survivor among
 * 4,000 hits) widened by its survival rate twice, ranking and probing most of
 * the library each time: 9.4 s against 0.55 s for the full statement. A filter
 * that keeps a fair share of the hits should still be answered by one wider
 * pass; one that keeps almost none should go straight to the full statement.
 * Either way the rows are the list's first rows.
 */

import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createTestDatabase,
  insertFolder,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { FTS_RANK_SQL } from './search.fts.ts';
import { firstRanked } from './search.ranked.ts';
import { searchFacets } from './search.facets.ts';
import { facetStatements } from './search.facets.sql.ts';
import { statement } from './search.sql.ts';
import { buildSearchWhere, type SearchWhere } from './search.where.ts';
import { seedSearchAsset } from './search.test-helpers.ts';
import type { SqliteDb } from './db-handle.ts';
import type { SearchQuery } from '../../routes/search/query-schema.ts';

// Each query word in a minority of blobs, so `bm25()` tells them apart: a word
// in more than half the rows scores next to nothing and every hit ties.
const BLOBS = [
  'ocean group people',
  'group',
  'people standing',
  'lake',
  'forest group',
  'city people',
  'snow',
  'desert standing',
];

async function withLibrary(body: (db: Database) => Promise<void>): Promise<void> {
  using handle = await createTestDatabase();
  const libraryId = insertFolder(handle.db, { slug: 'wide' });
  for (let index = 0; index < 600; index++) {
    seedSearchAsset(handle.db, libraryId, {
      // A token of its own varies each blob's length, so scores rarely tie.
      searchBlob: `${BLOBS[index % BLOBS.length]!} ${'x'.repeat(1 + (index % 37))}${index}`,
      capturedAt: `2024-0${(index % 9) + 1}-1${index % 10}T10:00:00.000Z`,
      rating: index % 3 === 0 ? 4 : 1,
      flag: index === 7 || index === 311 ? 1 : 0,
    });
  }
  await body(handle.db);
}

function translate(q: SearchQuery): SearchWhere {
  const built = buildSearchWhere(q);
  if ('error' in built) throw new Error(built.error);
  return built;
}

function listHead(db: Database, where: SearchWhere, k: number): number[] {
  const head = statement(
    `assets.rowid AS r, ${FTS_RANK_SQL}`,
    where,
    'ORDER BY rank ASC, assets.captured_at DESC, assets.id LIMIT ?',
    undefined,
    [k],
  );
  const rows = db.query(head.sql).all(...(head.params as never[])) as Array<{ r: number }>;
  return rows.map((row) => row.r).sort((a, b) => a - b);
}

function recording(db: Database): { handle: SqliteDb; issued: string[] } {
  const inner = testSqliteDb(db);
  const issued: string[] = [];
  return {
    issued,
    handle: {
      read: (sql, params) => {
        issued.push(sql);
        return inner.read(sql, params);
      },
      write: (sql, params) => inner.write(sql, params),
      transaction: (statements) => inner.transaction(statements),
    },
  };
}

const passes = (issued: string[]) => issued.filter((sql) => sql.includes('WITH hit AS')).length;
const fullStatements = (issued: string[]) =>
  issued.filter((sql) => sql.includes('WITH ranked AS')).length;

test('a selective filter goes straight to the full statement after one pass', async () => {
  await withLibrary(async (db) => {
    const where = translate({
      placeQuery: 'group of people standing in front of the ocean',
      flag: 'pick',
    });
    const { handle, issued } = recording(db);
    const rows = await firstRanked(handle, where, 50);
    expect(rows.map((row) => row.r).sort((a, b) => a - b)).toEqual(listHead(db, where, 50));
    expect(rows).toHaveLength(2);
    expect({ passes: passes(issued), full: fullStatements(issued) }).toEqual({
      passes: 1,
      full: 1,
    });
  });
});

test('a filter keeping a fair share of the hits is answered by one wider pass', async () => {
  await withLibrary(async (db) => {
    const where = translate({
      placeQuery: 'group of people standing in front of the ocean',
      rating: '4',
    });
    const { handle, issued } = recording(db);
    const rows = await firstRanked(handle, where, 50);
    expect(rows.map((row) => row.r).sort((a, b) => a - b)).toEqual(listHead(db, where, 50));
    expect(rows).toHaveLength(50);
    expect({ passes: passes(issued), full: fullStatements(issued) }).toEqual({
      passes: 2,
      full: 0,
    });
  });
});

test('no filter: one pass', async () => {
  await withLibrary(async (db) => {
    const where = translate({ placeQuery: 'group of people standing in front of the ocean' });
    const { handle, issued } = recording(db);
    const rows = await firstRanked(handle, where, 50);
    expect(rows.map((row) => row.r).sort((a, b) => a - b)).toEqual(listHead(db, where, 50));
    expect({ passes: passes(issued), full: fullStatements(issued) }).toEqual({
      passes: 1,
      full: 0,
    });
  });
});

test("a selective filter's facets are its matches, read once, with no ranking", async () => {
  await withLibrary(async (db) => {
    const where = translate({
      placeQuery: 'group of people standing in front of the ocean',
      flag: 'pick',
    });
    const { handle, issued } = recording(db);
    const facets = await searchFacets(where, handle, 50);
    expect(facets.total).toBe(2);
    expect(facets.scope).toEqual({ kind: 'all' });
    const direct = facetStatements(where).cameras;
    const cameras = db.query(direct.sql).all(...(direct.params as never[])) as Array<{
      count: number;
    }>;
    expect(facets.cameras.reduce((sum, row) => sum + row.count, 0)).toBe(
      cameras.reduce((sum, row) => sum + row.count, 0),
    );
    // One read of the matches, then `assets` and the four side tables.
    expect({ passes: passes(issued), full: fullStatements(issued), all: issued.length }).toEqual({
      passes: 0,
      full: 0,
      all: 6,
    });
  });
});

test('a tie thousands wide at the cutoff goes to the full statement after one pass', async () => {
  using handle = await createTestDatabase();
  const libraryId = insertFolder(handle.db, { slug: 'tied' });
  // Thirty short captions score best; then two thousand assets share one
  // caption and score exactly alike; a few hundred others match one word.
  // A first pass of 100 hits keeps the thirty and stops inside the tie, so
  // widening by the survival rate would land inside it again.
  for (let index = 0; index < 2_330; index++) {
    seedSearchAsset(handle.db, libraryId, {
      searchBlob:
        index < 30
          ? 'harbour lantern'
          : index < 2_030
            ? 'harbour lantern night'
            : `harbour ${'x'.repeat(1 + (index % 29))}${index}`,
      capturedAt: `2024-0${(index % 9) + 1}-1${index % 10}T10:00:00.000Z`,
    });
  }
  for (let index = 0; index < 400; index++) {
    seedSearchAsset(handle.db, libraryId, { searchBlob: `meadow ${index}` });
  }
  const where = translate({ placeQuery: 'harbour lantern' });
  const { handle: recorded, issued } = recording(handle.db);
  const rows = await firstRanked(recorded, where, 50);
  expect(rows.map((row) => row.r).sort((a, b) => a - b)).toEqual(listHead(handle.db, where, 50));
  expect({ passes: passes(issued), full: fullStatements(issued) }).toEqual({ passes: 1, full: 1 });
});
