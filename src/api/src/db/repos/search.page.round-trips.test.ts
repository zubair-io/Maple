/**
 * How many sequential trips a search page makes through the reader queue (#4503): one statement
 * decides the rows, and one wave fills in their locations, captions, PhotoKit links and owner,
 * through the bulk lane so the fan-out always leaves a reader free for a grid page. A ranked
 * window's page (#4514) reads its columns in that same wave, every statement on the bulk lane.
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
import { searchPage, windowDocs } from './search.page.ts';
import { mapleIdWindow } from './search.ranked.ts';

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
  it('filters the in-process candidates in one read, then fills a page in one wave', async () => {
    const recorded = recordReadWaves(testSqliteDb(database.db));

    const window = await mapleIdWindow(
      where({ rating: '5' }),
      ['four', 'gone', 'two', 'three', 'one'],
      recorded.handle,
    );
    const docs = await windowDocs(window.slice(1, 3), recorded.handle);

    expect(window.map((row) => row.maple_id)).toEqual(['four', 'three', 'one']);
    expect(docs.map((doc) => doc.fileinfo?.[0]?.filename)).toEqual(['three.dng', 'one.dng']);
    expect(docs.map((doc) => doc.owner)).toEqual([
      { id: OWNER, email: 'owner@maple.local' },
      { id: OWNER, email: 'owner@maple.local' },
    ]);
    expect(recorded.waves.map((wave) => wave.length)).toEqual([1, 5]);
    expect(recorded.waves.flat().every((sql) => sql.startsWith('bulk: '))).toBe(true);
    expect(recorded.waves[1]!.some((sql) => sql.includes('FROM users'))).toBe(true);
  });

  it('answers an empty page without hydrating', async () => {
    const recorded = recordReadWaves(testSqliteDb(database.db));

    expect(await windowDocs([], recorded.handle)).toEqual([]);
    expect(recorded.waves).toEqual([]);
  });

  it('resolves owners alongside the other side tables on the database page', async () => {
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
  });
});
