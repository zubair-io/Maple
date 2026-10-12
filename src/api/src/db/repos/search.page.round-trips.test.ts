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
import { searchByIds, searchPage, windowDocs } from './search.page.ts';
import { projectAssets } from '../../routes/search/project.ts';
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

  it('keeps a candidate repeated by the engine repeated through the window and its page', async () => {
    const handle = testSqliteDb(database.db);

    const window = await mapleIdWindow(where({ rating: '5' }), ['one', 'one', 'three'], handle);
    const docs = await windowDocs(window, handle);

    expect(window.map((row) => row.maple_id)).toEqual(['one', 'one', 'three']);
    expect(docs.map((doc) => doc.fileinfo?.[0]?.filename)).toEqual([
      'one.dng',
      'one.dng',
      'three.dng',
    ]);
  });

  it('renders rows whose owner_id is corrupt or empty with no owner rather than failing the page', async () => {
    database.db.exec('PRAGMA foreign_keys = OFF');
    run(database.db, `UPDATE assets SET owner_id = 'not-an-object-id' WHERE maple_id = 'three'`);
    run(database.db, `UPDATE assets SET owner_id = '' WHERE maple_id = 'two'`);
    const handle = testSqliteDb(database.db);

    const window = await mapleIdWindow(where(), ['three', 'two', 'one'], handle);
    const ranked = await windowDocs(window, handle);
    const paged = await searchPage(where(), { sort: 'captured_desc', limit: 10, skip: 0 }, handle);
    const results = projectAssets(paged, new Map(), new Map());

    expect(ranked.map((doc) => doc.owner?.id ?? null)).toEqual([null, null, OWNER]);
    expect(ranked.map((doc) => doc.owner_id)).toEqual(['not-an-object-id', '', expect.anything()]);
    expect(paged).toHaveLength(4);
    expect(paged.find((doc) => doc.owner_id === '')?.owner).toBeNull();
    const corrupt = results.find((result) => result.filename === 'three.dng');
    expect(corrupt?.owner).toBeNull();
    expect(corrupt?.owner_id).toBe('not-an-object-id');
  });

  it('resolves the owner of a valid id stored in uppercase', async () => {
    database.db.exec('PRAGMA foreign_keys = OFF');
    run(database.db, `UPDATE assets SET owner_id = ? WHERE maple_id = 'one'`, OWNER.toUpperCase());
    const handle = testSqliteDb(database.db);

    const [ranked] = await windowDocs(await mapleIdWindow(where(), ['one'], handle), handle);
    const paged = await searchPage(where(), { sort: 'captured_desc', limit: 10, skip: 0 }, handle);

    expect(ranked?.owner).toEqual({ id: OWNER, email: 'owner@maple.local' });
    expect(paged.filter((doc) => doc.owner?.id === OWNER)).toHaveLength(3);
  });

  it('keeps owner_id and owner from the same read when the owner changes between the two', async () => {
    const OTHER = 'b'.repeat(24);
    run(
      database.db,
      `INSERT INTO users (id, email, email_key, role, created_at) VALUES (?, ?, ?, 'member', ?)`,
      OTHER,
      'other@maple.local',
      'other@maple.local',
      '2026-01-01T00:00:00Z',
    );
    const handle = testSqliteDb(database.db);
    const window = await mapleIdWindow(where(), ['one'], handle);
    run(database.db, `UPDATE assets SET owner_id = ? WHERE maple_id = 'one'`, OTHER);

    const [doc] = await windowDocs(window, handle);

    expect(doc?.owner).not.toBeNull();
    expect(doc?.owner?.id).toBe(
      typeof doc?.owner_id === 'string' ? doc.owner_id : doc?.owner_id?.toHexString(),
    );
  });

  it('projects stored-id pages with their owners', async () => {
    const recorded = recordReadWaves(testSqliteDb(database.db));
    const [one, four] = database.db
      .query(`SELECT id FROM assets WHERE maple_id IN ('one', 'four') ORDER BY maple_id DESC`)
      .all() as Array<{ id: string }>;

    const docs = await searchByIds(where(), [one!.id, 'f'.repeat(24), four!.id], recorded.handle);
    const results = projectAssets(docs, new Map(), new Map());

    expect(results.map((result) => [result.filename, result.owner])).toEqual([
      ['one.dng', { id: OWNER, email: 'owner@maple.local' }],
      ['four.dng', null],
    ]);
    expect(recorded.waves.map((wave) => wave.length)).toEqual([1, 4]);
  });
});
