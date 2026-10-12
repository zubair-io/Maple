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
  mapleIdWindow,
  RANKED_WINDOW_BASE,
  RANKED_WINDOW_MAX,
  rankWindow,
  stepQuota,
  windowDepthFor,
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
      `SELECT rowid FROM assets_fts WHERE assets_fts MATCH ? ORDER BY bm25(assets_fts), rowid LIMIT ?`,
    )
    .all(where.match.expression, depth) as Array<{ rowid: number }>;
  const survivors = statement(
    `assets.rowid AS r, ${FTS_RANK_SQL}`,
    where,
    `ORDER BY ${FTS_RANK_ORDER}, asset_search.rowid`,
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

  test('a selective filter widens up the ladder, bounded, and never reads every match joined', async () => {
    await withLibrary(async (db) => {
      const where = translate({
        placeQuery: 'group of people standing in front of the ocean',
        flag: 'pick',
      });
      const { handle, issued } = recording(db);
      const window = (await rankWindow(ftsRanker(where, handle), RANKED_WINDOW_BASE))!;
      expect(window.rows).toHaveLength(2);
      expect(window.more).toBe(false);
      expect(issued.length).toBeLessThanOrEqual(4);
      expect(issued.every((sql) => sql.includes('WITH hit AS MATERIALIZED'))).toBe(true);
      expect(issued.some((sql) => /COUNT\(\*\)\s+AS n/.test(sql))).toBe(false);
    });
  });

  test('a lookahead hit is counted and read for its shot, but never served (#4543, #4557)', async () => {
    await withLibrary(async (db) => {
      const where = translate({ placeQuery: 'standing', hidden: 'all' });
      const ranker = ftsRanker(where, testSqliteDb(db));
      const matches = (await ranker(1_000))!.considered;
      expect(matches).toBeGreaterThan(5);
      for (const depth of [matches - 1, matches]) {
        const pass = (await ranker(depth, 1))!;
        expect(pass.considered).toBe(Math.min(depth + 1, matches));
        expect(pass.rows.map((row) => row.r)).toEqual(expectedWindow(db, where, depth));
        expect([...pass.rows, ...pass.beyond!].map((row) => row.r)).toEqual(
          expectedWindow(db, where, depth + 1),
        );
      }
    });
  });

  test('a text no row can match answers an empty window without a statement', async () => {
    await withLibrary(async (db) => {
      const { handle, issued } = recording(db);
      const window = await rankWindow(ftsRanker(translate({ placeQuery: '-ocean' }), handle), 30);
      expect(window).toEqual({
        rows: [],
        more: false,
        capped: false,
        semantic: new Set(),
        depth: RANKED_WINDOW_BASE,
      });
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
  const ranker: WindowRanker = async (depth, lookahead = 0) => {
    depths.push(depth);
    const considered = Math.min(depth + lookahead, matches);
    const rows = Array.from({ length: Math.min(depth, matches) }, (_, index) => index)
      .filter((index) => index % keepEvery === 0)
      .map((index) => ({
        r: index,
        id: `id${index}`,
        maple_id: `m${index}`,
        owner_id: null,
        captured_at: null,
        media_kind: 'image',
        filename: null,
      }));
    return { rows, considered } satisfies WindowPass;
  };
  return { ranker, depths };
}

describe('the window policy', () => {
  test('serves three quarters of each ladder step, keeping a quarter as headroom', () => {
    expect([100, 400, 1_600, RANKED_WINDOW_MAX].map(stepQuota)).toEqual([75, 300, 1_200, 3_750]);
    expect([1, 30, 75, 76, 300, 301, 1_200, 1_201, 5_000].map(windowDepthFor)).toEqual([
      100,
      100,
      100,
      400,
      400,
      1_600,
      1_600,
      RANKED_WINDOW_MAX,
      RANKED_WINDOW_MAX,
    ]);
  });

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
    expect(depths).toEqual([1_600]);
    expect(window.rows).toHaveLength(1_600);
  });

  test('a window the engine did not fill is every match: no more, no widening', async () => {
    const { ranker, depths } = syntheticRanker(40, 3);
    const window = (await rankWindow(ranker, 30))!;
    expect(depths).toEqual([RANKED_WINDOW_BASE]);
    expect(window.rows).toHaveLength(14);
    expect(window.more).toBe(false);
  });

  test('widens up the ladder until a full window fills the page', async () => {
    const { ranker, depths } = syntheticRanker(10_000, 10);
    const window = (await rankWindow(ranker, 75))!;
    expect(depths).toEqual([100, 400, 1_600]);
    expect(window.rows).toHaveLength(160);
    expect(window.more).toBe(true);
  });

  test('never goes past the cap, and says it stopped there with matches left', async () => {
    const { ranker, depths } = syntheticRanker(1_000_000, 1_000);
    const window = (await rankWindow(ranker, 75))!;
    expect(depths).toEqual([100, 400, 1_600, RANKED_WINDOW_MAX]);
    expect(window.rows).toHaveLength(5);
    expect(window).toMatchObject({ more: false, capped: true });

    const deep = syntheticRanker(1_000_000, 1);
    const capped = (await rankWindow(deep.ranker, 50_000))!;
    expect(deep.depths).toEqual([RANKED_WINDOW_MAX]);
    expect(capped).toMatchObject({ more: false, capped: true });
    expect(capped.rows).toHaveLength(RANKED_WINDOW_MAX);
  });

  test('is not capped when the engine ran out of matches before the cap', async () => {
    const { ranker } = syntheticRanker(4_000, 1);
    expect(await rankWindow(ranker, 5_000)).toMatchObject({ more: false, capped: false });
  });

  test('is not capped when the engine has exactly as many matches as the cap (#4543)', async () => {
    const { ranker } = syntheticRanker(RANKED_WINDOW_MAX, 1);
    const window = (await rankWindow(ranker, RANKED_WINDOW_MAX))!;
    expect(window.rows).toHaveLength(RANKED_WINDOW_MAX);
    expect(window).toMatchObject({ more: false, capped: false });
  });

  test('is capped by one match past the cap, which it counts but never serves (#4543)', async () => {
    const { ranker } = syntheticRanker(RANKED_WINDOW_MAX + 1, 1);
    const window = (await rankWindow(ranker, RANKED_WINDOW_MAX))!;
    expect(window.rows).toHaveLength(RANKED_WINDOW_MAX);
    expect(window.rows.at(-1)!.r).toBe(RANKED_WINDOW_MAX - 1);
    expect(window).toMatchObject({ more: false, capped: true });
  });

  test('an engine that cannot answer answers null; one that fails to widen keeps its first pass', async () => {
    expect(await rankWindow(async () => null, 30)).toBeNull();
    const calls: number[] = [];
    const flaky: WindowRanker = async (depth) => {
      calls.push(depth);
      return calls.length === 1
        ? {
            rows: [
              {
                r: 1,
                id: 'a',
                maple_id: 'a',
                owner_id: null,
                captured_at: null,
                media_kind: 'image',
                filename: null,
              },
            ],
            considered: depth,
          }
        : null;
    };
    const window = (await rankWindow(flaky, 100))!;
    expect(window.rows).toHaveLength(1);
    expect(window.more).toBe(true);
  });
});

describe('one row per shot (#4557)', () => {
  test("the database's window keeps the best-ranked copy of each shot", async () => {
    using handle = await createTestDatabase();
    const libraryId = insertFolder(handle.db, { slug: 'shots' });
    const capturedAt = '2018-07-07T13:30:40.000Z';
    const seed = (filename: string, searchBlob: string) =>
      seedSearchAsset(handle.db, libraryId, { filename, capturedAt, searchBlob });
    const raw = seed('_MG_4006.CR2', 'sunset beach sunset');
    seed('_MG_4006(2).jpg', 'sunset beach sunset sky');
    seed('_MG_4006(1)(1).jpg', 'sunset beach sunset sky sand');
    const neighbour = seed('_MG_4007.CR2', 'sunset beach sunset sky sand sea');
    seed('lake.dng', 'lake');

    const window = (await rankWindow(
      ftsRanker(translate({ placeQuery: 'sunset' }), testSqliteDb(handle.db)),
      RANKED_WINDOW_BASE,
    ))!;

    expect(window.rows.map((row) => row.id)).toEqual([raw, neighbour]);
    expect(window.rows[0]).toMatchObject({
      captured_at: capturedAt,
      media_kind: 'image',
      filename: '_MG_4006.CR2',
    });
  });

  test("names a shot by a live entry's filename when the canonical entry is gone", async () => {
    using handle = await createTestDatabase();
    const libraryId = insertFolder(handle.db, { slug: 'moved' });
    const capturedAt = '2017-05-21T17:50:35.000Z';
    const best = seedSearchAsset(handle.db, libraryId, {
      filename: '20170521_175035.mp4',
      mediaKind: 'video',
      capturedAt,
      searchBlob: 'fireworks fireworks',
    });
    const copy = seedSearchAsset(handle.db, libraryId, {
      mapleId: 'moved-copy',
      filename: 'old-name.mp4',
      locationMissingSince: '2026-01-01T00:00:00.000Z',
      mediaKind: 'video',
      capturedAt,
      searchBlob: 'fireworks fireworks night',
    });
    handle.db
      .query(
        `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename)
         VALUES (?, 1, ?, '2017/05', '20170521_175035(1).mp4')`,
      )
      .run(copy, libraryId);

    const pass = (await ftsRanker(
      translate({ placeQuery: 'fireworks' }),
      testSqliteDb(handle.db),
    )(RANKED_WINDOW_BASE))!;
    const window = (await rankWindow(
      ftsRanker(translate({ placeQuery: 'fireworks' }), testSqliteDb(handle.db)),
      RANKED_WINDOW_BASE,
    ))!;

    expect(pass.rows.find((row) => row.id === copy)?.filename).toBe('20170521_175035(1).mp4');
    const [byMapleId] = await mapleIdWindow(
      translate({ placeQuery: 'fireworks' }),
      ['moved-copy'],
      testSqliteDb(handle.db),
    );
    expect(byMapleId?.filename).toBe('20170521_175035(1).mp4');
    expect(window.rows.map((row) => row.id)).toEqual([best]);
  });

  test('a step whose copies stay inside its headroom ranks once (#4557 latency)', async () => {
    const depths: number[] = [];
    const ranker: WindowRanker = async (depth) => {
      depths.push(depth);
      const rows = Array.from({ length: depth }, (_, index) => ({
        r: index,
        id: `id${index}`,
        maple_id: `m${index}`,
        owner_id: null,
        captured_at: '2024-01-01T00:00:00.000Z',
        media_kind: 'image',
        filename: index % 9 === 1 ? `IMG_${index - 1}.JPG` : `IMG_${index}.CR2`,
      }));
      return { rows, considered: depth };
    };

    const window = (await rankWindow(ranker, 60))!;

    expect(depths).toEqual([RANKED_WINDOW_BASE]);
    expect(window.rows).toHaveLength(89);
    expect(window.more).toBe(true);
  });

  test('widens when collapsed copies leave a full window short of the page', async () => {
    const depths: number[] = [];
    const ranker: WindowRanker = async (depth) => {
      depths.push(depth);
      const rows = Array.from({ length: depth }, (_, index) => ({
        r: index,
        id: `id${index}`,
        maple_id: `m${index}`,
        owner_id: null,
        captured_at: '2024-01-01T00:00:00.000Z',
        media_kind: 'image',
        filename: `IMG_${Math.floor(index / 2)}${index % 2 === 0 ? '.CR2' : '.JPG'}`,
      }));
      return { rows, considered: depth };
    };

    const window = (await rankWindow(ranker, 75))!;

    expect(depths).toEqual([100, 400]);
    expect(window.rows).toHaveLength(200);
    expect(window.rows.every((row) => row.filename!.endsWith('.CR2'))).toBe(true);
    expect(window.more).toBe(true);
  });

  test('stops at the cap with copies collapsed, capped and with no more paging', async () => {
    const depths: number[] = [];
    const ranker: WindowRanker = async (depth, lookahead = 0) => {
      depths.push(depth);
      const rows = Array.from({ length: depth }, (_, index) => ({
        r: index,
        id: `id${index}`,
        maple_id: `m${index}`,
        owner_id: null,
        captured_at: '2024-01-01T00:00:00.000Z',
        media_kind: 'image',
        filename: `IMG_${Math.floor(index / 10)}(${index % 10}).JPG`,
      }));
      return { rows, considered: depth + lookahead };
    };

    const window = (await rankWindow(ranker, 1_000))!;

    expect(depths).toEqual([1_600, RANKED_WINDOW_MAX]);
    expect(window.rows).toHaveLength(RANKED_WINDOW_MAX / 10);
    expect(window).toMatchObject({ more: false, capped: true });
  });
});

describe('the cap counts shots past it, not files (#4543, #4557)', () => {
  const shot = (index: number, filename = `IMG_${index}.CR2`) => ({
    r: index,
    id: `id${index}`,
    maple_id: `m${index}`,
    owner_id: null,
    captured_at: '2024-01-01T00:00:00.000Z',
    media_kind: 'image',
    filename,
  });
  /** Exactly the cap's worth of distinct shots, then `beyond` as the one lookahead hit. */
  const atTheCap =
    (beyond: ReturnType<typeof shot>[]): WindowRanker =>
    async (depth, lookahead = 0) => ({
      rows: Array.from({ length: depth }, (_, index) => shot(index)),
      considered: depth + lookahead,
      beyond: lookahead > 0 ? beyond : [],
    });

  test('another copy of a shot already in the window does not cap it', async () => {
    const window = (await rankWindow(atTheCap([shot(5_000, 'IMG_17.JPG')]), RANKED_WINDOW_MAX))!;
    expect(window.rows).toHaveLength(RANKED_WINDOW_MAX);
    expect(window).toMatchObject({ more: false, capped: false });
  });

  test('a new shot past the cap caps it', async () => {
    const window = (await rankWindow(atTheCap([shot(5_000)]), RANKED_WINDOW_MAX))!;
    expect(window.rows).toHaveLength(RANKED_WINDOW_MAX);
    expect(window).toMatchObject({ more: false, capped: true });
  });

  test('a hit past the cap the filters reject still caps it, as before', async () => {
    const window = (await rankWindow(atTheCap([]), RANKED_WINDOW_MAX))!;
    expect(window).toMatchObject({ more: false, capped: true });
  });
});
