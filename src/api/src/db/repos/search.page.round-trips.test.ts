/**
 * How many sequential trips a search page makes through the reader queue (#4503): one statement
 * decides the rows, and one wave fills in their locations, captions, PhotoKit links and owner,
 * through the bulk lane so the fan-out always leaves a reader free for a grid page.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createTestDatabase,
  insertFolder,
  run,
  testSqliteDb,
  type TestDatabase,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { recordReadWaves } from '../sqlite/read-waves.test-helpers.ts';
import { seedSearchAsset } from './search.test-helpers.ts';
import { buildSearchWhere } from './search.where.ts';
import { rankedMapleIdPage, searchByMapleIds, searchPage } from './search.page.ts';

const OWNER = 'a'.repeat(24);
let database: TestDatabase;

beforeEach(async () => {
  database = await createTestDatabase();
  const libraryId = insertFolder(database.db, { slug: 'waves', path: '/lib' });
  for (const [mapleId, rating] of [
    ['one', 5],
    ['two', 1],
    ['three', 5],
    ['four', 5],
  ] as const) {
    seedSearchAsset(database.db, libraryId, { mapleId, rating, filename: `${mapleId}.dng` });
  }
  run(
    database.db,
    `INSERT INTO users (id, email, email_key, role, created_at) VALUES (?, ?, ?, 'owner', ?)`,
    OWNER,
    'owner@maple.local',
    'owner@maple.local',
    '2026-01-01T00:00:00Z',
  );
  run(database.db, `UPDATE assets SET owner_id = ? WHERE maple_id <> 'four'`, OWNER);
});

afterEach(() => database.close());

function where(query: Record<string, string> = {}) {
  const built = buildSearchWhere(query);
  if ('error' in built) throw new Error(built.error);
  return built;
}

describe('search page round trips', () => {
  it('pages the in-process candidates from one read of them, then hydrates in one wave', async () => {
    const recorded = recordReadWaves(testSqliteDb(database.db));

    const page = await rankedMapleIdPage(
      where({ rating: '5' }),
      ['four', 'gone', 'two', 'three', 'one'],
      { skip: 1, limit: 2 },
      recorded.handle,
    );

    expect(page.total).toBe(3);
    expect(page.mapleIds).toEqual(['three', 'one']);
    expect(page.docs.map((doc) => doc.fileinfo?.[0]?.filename)).toEqual(['three.dng', 'one.dng']);
    expect(page.docs.map((doc) => doc.owner)).toEqual([
      { id: OWNER, email: 'owner@maple.local' },
      { id: OWNER, email: 'owner@maple.local' },
    ]);
    expect(recorded.waves.map((wave) => wave.length)).toEqual([1, 4]);
    expect(recorded.waves[0]!.every((sql) => !sql.startsWith('bulk: '))).toBe(true);
    expect(recorded.waves[1]!.every((sql) => sql.startsWith('bulk: '))).toBe(true);
    expect(recorded.waves[1]!.some((sql) => sql.includes('FROM users'))).toBe(true);
  });

  it('answers an empty page without hydrating', async () => {
    const recorded = recordReadWaves(testSqliteDb(database.db));

    const page = await rankedMapleIdPage(where(), ['two'], { skip: 1, limit: 2 }, recorded.handle);

    expect(page).toEqual({ total: 1, mapleIds: [], docs: [] });
    expect(recorded.waves.map((wave) => wave.length)).toEqual([1]);
  });

  it('resolves owners alongside the other side tables on the database and Meilisearch pages', async () => {
    const pageWaves = recordReadWaves(testSqliteDb(database.db));
    const docs = await searchPage(
      where(),
      { sort: 'captured_desc', limit: 10, skip: 0 },
      pageWaves.handle,
    );

    expect(docs).toHaveLength(4);
    expect(docs.filter((doc) => doc.owner?.id === OWNER)).toHaveLength(3);
    expect(docs.find((doc) => doc.owner_id === null)?.owner).toBeNull();
    expect(pageWaves.waves.map((wave) => wave.length)).toEqual([1, 4]);

    const meiliWaves = recordReadWaves(testSqliteDb(database.db));
    const ranked = await searchByMapleIds(where(), ['four', 'one'], meiliWaves.handle);

    expect(ranked.map((doc) => doc.owner?.email ?? null)).toEqual([null, 'owner@maple.local']);
    expect(meiliWaves.waves.map((wave) => wave.length)).toEqual([1, 4]);
  });
});
