/**
 * The ranked window (#4514): which rows it holds, how far it widens, and what `more` says.
 *
 * The bound is the point. A window never counts or joins the whole match set: it ranks the text
 * on the inverted index alone, joins only its best hits, widens at most once and never past
 * `RANKED_WINDOW_MAX` — so a filter that keeps almost nothing answers a short window, not a
 * statement over every match (the fallback #4431 had, and the shape that pinned production).
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createTestDatabase,
  insertFolder,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { FTS_RANK_ORDER, FTS_RANK_SQL } from './search.fts.ts';
import {
  ftsRanker,
  RANKED_WINDOW_BASE,
  RANKED_WINDOW_MAX,
  rankWindow,
  type WindowPass,
  type WindowRanker,
} from './search.ranked.ts';
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

/** The best `depth` hits on the inverted index that pass `where`, by the window's own order. */
function expectedWindow(db: Database, where: SearchWhere, depth: number): number[] {
  if (where.match.kind !== 'match') return [];
  const hits = db
    .query(
      `SELECT rowid FROM assets_fts WHERE assets_fts MATCH ? ORDER BY bm25(assets_fts) LIMIT ?`,
    )
    .all(where.match.expression, depth) as Array<{ rowid: number }>;
  const survivors = statement(
    `assets.rowid AS r, ${FTS_RANK_SQL}`,
    where,
    `ORDER BY ${FTS_RANK_ORDER}, assets.captured_at DESC, assets.id`,
    { sql: 'asset_search.rowid IN (SELECT value FROM json_each(?))', params: [] },
    [JSON.stringify(hits.map((hit) => hit.rowid))],
  );
  return (
    db.query(survivors.sql).all(...(survivors.params as never[])) as Array<{ r: number }>
  ).map((row) => row.r);
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

describe("the database's window", () => {
  for (const q of [
    { placeQuery: 'group of people standing in front of the ocean' },
    { placeQuery: 'group of people', rating: '4' },
    { placeQuery: 'standing', hidden: 'all' },
  ] as SearchQuery[]) {
    test(`is the best hits that pass the filters, in rank order: ${JSON.stringify(q)}`, async () => {
      await withLibrary(async (db) => {
        const where = translate(q);
        for (const depth of [1, 7, 50, 400]) {
          const pass = (await ftsRanker(where, testSqliteDb(db))(depth))!;
          expect({ depth, rows: pass.rows.map((row) => row.r) }).toEqual({
            depth,
            rows: expectedWindow(db, where, depth),
          });
          expect(pass.considered).toBeLessThanOrEqual(depth);
        }
      });
    });
  }

  test('a selective filter widens once, bounded, and never reads every match joined', async () => {
    await withLibrary(async (db) => {
      const where = translate({
        placeQuery: 'group of people standing in front of the ocean',
        flag: 'pick',
      });
      const { handle, issued } = recording(db);
      const window = (await rankWindow(ftsRanker(where, handle), RANKED_WINDOW_BASE))!;
      expect(window.rows).toHaveLength(2);
      expect(window.more).toBe(false);
      expect(issued).toHaveLength(2);
      expect(issued.every((sql) => sql.includes('WITH hit AS MATERIALIZED'))).toBe(true);
      expect(issued.some((sql) => /COUNT\(\*\)\s+AS n/.test(sql))).toBe(false);
    });
  });

  test('a text no row can match answers an empty window without a statement', async () => {
    await withLibrary(async (db) => {
      const { handle, issued } = recording(db);
      const window = await rankWindow(ftsRanker(translate({ placeQuery: '-ocean' }), handle), 30);
      expect(window).toEqual({ rows: [], more: false, semantic: new Set() });
      expect(issued).toEqual([]);
    });
  });
});

/** A ranker over `matches` hits of which every `keepEvery`-th passes the filters. */
function syntheticRanker(
  matches: number,
  keepEvery: number,
): { ranker: WindowRanker; depths: number[] } {
  const depths: number[] = [];
  const ranker: WindowRanker = async (depth) => {
    depths.push(depth);
    const considered = Math.min(depth, matches);
    const rows = Array.from({ length: considered }, (_, index) => index)
      .filter((index) => index % keepEvery === 0)
      .map((index) => ({ r: index, id: `id${index}`, maple_id: `m${index}`, owner_id: null }));
    return { rows, considered } satisfies WindowPass;
  };
  return { ranker, depths };
}

describe('the window policy', () => {
  test('starts at the base depth and reports more when the engine filled it', async () => {
    const { ranker, depths } = syntheticRanker(10_000, 1);
    const window = (await rankWindow(ranker, 30))!;
    expect(depths).toEqual([RANKED_WINDOW_BASE]);
    expect(window.rows).toHaveLength(RANKED_WINDOW_BASE);
    expect(window.more).toBe(true);
  });

  test('goes as deep as the page asked for', async () => {
    const { ranker, depths } = syntheticRanker(10_000, 1);
    const window = (await rankWindow(ranker, 700))!;
    expect(depths).toEqual([700]);
    expect(window.rows).toHaveLength(700);
  });

  test('a window the engine did not fill is every match: no more, no widening', async () => {
    const { ranker, depths } = syntheticRanker(40, 3);
    const window = (await rankWindow(ranker, 30))!;
    expect(depths).toEqual([RANKED_WINDOW_BASE]);
    expect(window.rows).toHaveLength(14);
    expect(window.more).toBe(false);
  });

  test('widens once by the survival rate when a full window leaves the page short', async () => {
    const { ranker, depths } = syntheticRanker(10_000, 10);
    const window = (await rankWindow(ranker, 100))!;
    expect(depths).toEqual([100, 1_500]);
    expect(window.rows).toHaveLength(150);
    expect(window.more).toBe(true);
  });

  test('never goes past the cap, and says there is no more to widen into there', async () => {
    const { ranker, depths } = syntheticRanker(1_000_000, 1_000);
    const window = (await rankWindow(ranker, 100))!;
    expect(depths).toEqual([100, RANKED_WINDOW_MAX]);
    expect(window.rows).toHaveLength(5);
    expect(window.more).toBe(false);

    const deep = syntheticRanker(1_000_000, 1);
    const capped = (await rankWindow(deep.ranker, 50_000))!;
    expect(deep.depths).toEqual([RANKED_WINDOW_MAX]);
    expect(capped.more).toBe(false);
  });

  test('an engine that cannot answer answers null; one that fails to widen keeps its first pass', async () => {
    expect(await rankWindow(async () => null, 30)).toBeNull();
    const calls: number[] = [];
    const flaky: WindowRanker = async (depth) => {
      calls.push(depth);
      return calls.length === 1
        ? { rows: [{ r: 1, id: 'a', maple_id: 'a', owner_id: null }], considered: depth }
        : null;
    };
    const window = (await rankWindow(flaky, 100))!;
    expect(window.rows).toHaveLength(1);
    expect(window.more).toBe(true);
  });
});
