/**
 * The grid page and the total beside it.
 *
 * The centrepiece is {@link FILTER_CASES}: every filter the query string
 * accepts, and a few combinations of them, each paged to exhaustion and checked
 * against its own count. That is the ticket's third exit criterion, and it is
 * the property whose absence produced the bug this slice must not repeat — the
 * Meilisearch branch once post-filtered a single page and reported a count from
 * a different predicate, so the grid showed a large number above no photos.
 *
 * Paging is done twice for the sorts that support a cursor: once with
 * `page`/`limit` skips and once by following cursors, because those are two
 * different predicates that have to walk the same rows in the same order.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import { testSqliteDb } from './assets.test-helpers.ts';
import { searchCount, searchPage, type SeekPosition } from './search.page.ts';
import { buildSearchWhere, type SearchWhere } from './search.where.ts';
import { seedSearchLibrary, type SeededLibrary } from './search.test-helpers.ts';
import type { SqliteDb } from './db-handle.ts';
import type { SearchQuery } from '../../../routes/search/query-schema.ts';

/** One named filter combination, resolved against the seeded library. */
interface FilterCase {
  name: string;
  query: (library: SeededLibrary) => SearchQuery;
  excluded?: (library: SeededLibrary) => string[];
  people?: (library: SeededLibrary) => string[];
}

const FILTER_CASES: FilterCase[] = [
  { name: 'no filters', query: () => ({}) },
  { name: 'filename substring', query: () => ({ q: 'har' }) },
  { name: 'filename substring matching nothing', query: () => ({ q: 'no-such-file' }) },
  { name: 'library scope', query: (lib) => ({ libraryId: lib.libraryId }) },
  { name: 'camera substring', query: () => ({ camera: 'iPhone' }) },
  { name: 'lens substring', query: () => ({ lens: '24-70' }) },
  { name: 'place label', query: () => ({ place: 'Albany, New York' }) },
  { name: 'two place labels', query: () => ({ place: 'Albany, New York|Kyoto, Kansai' }) },
  { name: 'iso range', query: () => ({ isoMin: '200', isoMax: '1600' }) },
  { name: 'aperture range', query: () => ({ apertureMin: '2', apertureMax: '8' }) },
  { name: 'focal range', query: () => ({ focalMin: '30', focalMax: '80' }) },
  { name: 'date window', query: () => ({ from: '2024-01-01', to: '2024-06-01' }) },
  { name: 'open-ended from', query: () => ({ from: '2023-01-01' }) },
  { name: 'has a capture date', query: () => ({ hasCapturedAt: 'true' }) },
  { name: 'month of year', query: () => ({ month: '8' }) },
  { name: 'rating threshold', query: () => ({ rating: '4' }) },
  { name: 'flag', query: () => ({ flag: 'pick' }) },
  { name: 'colour label', query: () => ({ color: 'blue' }) },
  { name: 'no colour label', query: () => ({ color: '' }) },
  { name: 'path prefix', query: () => ({ pathPrefix: '/trips/2023' }) },
  { name: 'scene type', query: () => ({ sceneType: 'outdoor' }) },
  { name: 'activity', query: () => ({ activity: 'cooking' }) },
  { name: 'subjects', query: () => ({ subjects: 'boat,bridge' }) },
  { name: 'screenshots only', query: () => ({ isScreenshot: 'true' }) },
  { name: 'photographs only', query: () => ({ isScreenshot: 'false' }) },
  { name: 'hidden only', query: () => ({ hidden: 'only' }) },
  { name: 'hidden included', query: () => ({ hidden: 'all' }) },
  { name: 'extensions', query: () => ({ ext: 'dng,jpg' }) },
  { name: 'scope places', query: () => ({ scope: 'places' }) },
  { name: 'scope people', query: () => ({ scope: 'people' }) },
  { name: 'full text', query: () => ({ placeQuery: 'harbour' }) },
  { name: 'full text, two terms', query: () => ({ placeQuery: 'harbour lanterns' }) },
  { name: 'full text, quoted phrase', query: () => ({ placeQuery: '"paper lanterns"' }) },
  { name: 'full text, negated term', query: () => ({ placeQuery: 'new york -bridge' }) },
  { name: 'full text matching nothing', query: () => ({ placeQuery: 'unfindable' }) },
  // A text query that cannot match is still a text query, and the count has to
  // agree with the empty page rather than report the whole library.
  { name: 'full text, negations only', query: () => ({ placeQuery: '-boat' }) },
  { name: 'full text, punctuation only', query: () => ({ placeQuery: '???' }) },
  {
    name: 'full text, longer than the old 500-character cap',
    query: () => ({ placeQuery: `harbour ${'filler '.repeat(80)}` }),
  },
  { name: 'path prefix, exact case', query: () => ({ pathPrefix: 'trips' }) },
  { name: 'path prefix, wrong case', query: () => ({ pathPrefix: 'Trips' }) },
  {
    name: 'people filter',
    query: () => ({}),
    people: (lib) => [lib.people.get('Ada')!],
  },
  {
    name: 'excluded person',
    query: () => ({}),
    excluded: (lib) => [lib.people.get('Ada')!],
  },
  {
    name: 'people filter naming nobody',
    query: () => ({}),
    people: () => [],
  },
  {
    name: 'full text plus a structured filter',
    query: () => ({ placeQuery: 'new york', camera: 'SONY' }),
  },
  {
    name: 'camera, rating, date window and extension together',
    query: () => ({ camera: 'Apple', rating: '1', from: '2024-01-01', ext: 'dng,jpg' }),
  },
  {
    name: 'library scope with a path prefix and a scene type',
    query: (lib) => ({ libraryId: lib.libraryId, pathPrefix: 'trips', sceneType: 'indoor' }),
  },
];

/** Sorts whose page order a cursor can resume. */
const CURSOR_SORTS = ['captured_desc', 'captured_asc'] as const;
const ALL_SORTS = [...CURSOR_SORTS, 'name', 'rating'] as const;

function translate(testCase: FilterCase, library: SeededLibrary): SearchWhere {
  const built = buildSearchWhere(
    testCase.query(library),
    testCase.excluded?.(library) ?? [],
    testCase.people ? testCase.people(library) : null,
  );
  if ('error' in built) throw new Error(`unexpected validation error: ${built.error}`);
  return built;
}

/** Every id the grid hands out, walked a page at a time with skip paging. */
async function pageThroughBySkip(
  db: SqliteDb,
  where: SearchWhere,
  sort: string,
  limit = 3,
): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 0; page < 50; page += 1) {
    const rows = await searchPage(where, { sort, limit, skip: page * limit }, db);
    ids.push(...rows.map((row) => row._id.toHexString()));
    if (rows.length < limit) return ids;
  }
  throw new Error('skip paging did not terminate');
}

/** The same walk, following the cursor the previous page would have minted. */
async function pageThroughByCursor(
  db: SqliteDb,
  where: SearchWhere,
  sort: (typeof CURSOR_SORTS)[number],
  limit = 3,
): Promise<string[]> {
  const direction = sort === 'captured_asc' ? 'asc' : 'desc';
  const ids: string[] = [];
  let cursor: SeekPosition | null = null;
  for (let page = 0; page < 50; page += 1) {
    const rows: Awaited<ReturnType<typeof searchPage>> = await searchPage(
      where,
      { sort, limit, skip: 0, cursor },
      db,
    );
    ids.push(...rows.map((row) => row._id.toHexString()));
    if (rows.length < limit) return ids;
    const last = rows[rows.length - 1]!;
    cursor = {
      v: typeof last.exif?.captured_at === 'string' ? last.exif.captured_at : null,
      i: last._id.toHexString(),
      d: direction,
    };
  }
  throw new Error('cursor paging did not terminate');
}

async function withLibrary<T>(
  body: (db: SqliteDb, library: SeededLibrary, raw: Database) => Promise<T>,
): Promise<T> {
  using handle = await createTestDatabase();
  const library = seedSearchLibrary(handle.db);
  return await body(testSqliteDb(handle.db), library, handle.db);
}

describe('count and page agree', () => {
  for (const testCase of FILTER_CASES) {
    test(testCase.name, async () => {
      await withLibrary(async (db, library) => {
        const where = translate(testCase, library);
        const total = await searchCount(where, db);
        for (const sort of ALL_SORTS) {
          const ids = await pageThroughBySkip(db, where, sort);
          expect(ids.length).toBe(total);
          expect(new Set(ids).size).toBe(total);
        }
      });
    });
  }
});

describe('cursor paging walks the same rows as skip paging', () => {
  for (const testCase of FILTER_CASES) {
    test(testCase.name, async () => {
      await withLibrary(async (db, library) => {
        const where = translate(testCase, library);
        // A text query is ranked by bm25, which is not a stored column and so
        // not seekable — the route keeps those on skip paging and says so with
        // `cursorPaging: false`, and `searchPage` refuses the pair outright.
        // Everything else must match id for id.
        if (where.match.kind === 'match') return;
        for (const sort of CURSOR_SORTS) {
          const bySkip = await pageThroughBySkip(db, where, sort);
          const byCursor = await pageThroughByCursor(db, where, sort);
          expect(byCursor).toEqual(bySkip);
        }
      });
    });
  }
});

describe('searchPage — ordering', () => {
  test('newest capture first, undated rows last', async () => {
    await withLibrary(async (db, library) => {
      const where = translate({ name: 'all', query: () => ({}) }, library);
      const rows = await searchPage(where, { sort: 'captured_desc', limit: 20, skip: 0 }, db);
      const captured = rows.map((row) => row.exif?.captured_at ?? null);
      expect(captured[0]).toBe('2024-06-02T12:00:00.000Z');
      expect(captured[captured.length - 1]).toBe(null);
    });
  });

  test('oldest capture first puts the undated row at the head', async () => {
    await withLibrary(async (db, library) => {
      const where = translate({ name: 'all', query: () => ({}) }, library);
      const rows = await searchPage(where, { sort: 'captured_asc', limit: 20, skip: 0 }, db);
      expect(rows[0]!.exif?.captured_at ?? null).toBe(null);
      expect(rows[1]!.exif?.captured_at).toBe('2021-12-25T12:00:00.000Z');
    });
  });

  test('the name sort orders by the canonical filename', async () => {
    await withLibrary(async (db, library) => {
      const where = translate({ name: 'all', query: () => ({}) }, library);
      const rows = await searchPage(where, { sort: 'name', limit: 20, skip: 0 }, db);
      const names = rows.map((row) => row.fileinfo?.[0]?.filename ?? '');
      expect(names).toEqual([...names].sort());
    });
  });

  test('the rating sort leads with the highest rating', async () => {
    await withLibrary(async (db, library) => {
      const where = translate({ name: 'all', query: () => ({}) }, library);
      const rows = await searchPage(where, { sort: 'rating', limit: 20, skip: 0 }, db);
      expect(rows.map((row) => row.rating)).toEqual(
        [...rows.map((row) => row.rating)].sort((a, b) => b - a),
      );
    });
  });

  test('a full-text page leads with the best bm25 match', async () => {
    await withLibrary(async (db, library) => {
      const where = translate(
        { name: 'harbour', query: () => ({ placeQuery: 'harbour' }) },
        library,
      );
      const rows = await searchPage(where, { sort: 'captured_desc', limit: 20, skip: 0 }, db);
      // Two assets mention the harbour; the one whose blob is shorter and
      // mentions it once scores better than the long caption around it.
      expect(rows.length).toBe(2);
      expect(rows[0]!.fileinfo?.[0]?.filename).toBe('clip.mp4');
    });
  });
});

describe('searchPage — the combinations it refuses', () => {
  test('a cursor cannot resume a relevance-ordered text query', async () => {
    await withLibrary(async (db, library) => {
      const where = translate(
        { name: 'harbour', query: () => ({ placeQuery: 'harbour' }) },
        library,
      );
      const cursor: SeekPosition = { v: '2024-06-01T12:00:00.000Z', i: 'a'.repeat(24), d: 'desc' };
      // A bm25 page resumed from a capture date lands somewhere arbitrary in
      // it — rows the user has not seen are skipped and rows they have are
      // repeated. The route answers 400 for the pair; this layer refuses to
      // build a page from it rather than inherit that guarantee.
      await expect(
        searchPage(where, { sort: 'captured_desc', limit: 3, skip: 0, cursor }, db),
      ).rejects.toThrow(/relevance-ordered/);
    });
  });

  test('a cursor is still fine on a text query that matches nothing', async () => {
    await withLibrary(async (db, library) => {
      const where = translate({ name: 'none', query: () => ({ placeQuery: '-boat' }) }, library);
      const cursor: SeekPosition = { v: '2024-06-01T12:00:00.000Z', i: 'a'.repeat(24), d: 'desc' };
      expect(
        await searchPage(where, { sort: 'captured_desc', limit: 3, skip: 0, cursor }, db),
      ).toEqual([]);
    });
  });
});

describe('searchPage — the timeline subtree scope', () => {
  test('matches the directory and its descendants, and matches case exactly', async () => {
    await withLibrary(async (db, library) => {
      // Every fixture asset is filed under `trips/`, so the parent answers the
      // whole unhidden live set while each year answers its own share — and
      // nothing answers a prefix that only differs in case. The Mongo regex
      // `^trips(\/|$)` carries no `i` flag; an ASCII-case-insensitive `LIKE`
      // used to make the descendant arm disagree with both it and the `=` arm
      // beside it.
      const found = async (pathPrefix: string): Promise<number> => {
        const where = translate({ name: pathPrefix, query: () => ({ pathPrefix }) }, library);
        const rows = await searchPage(where, { sort: 'captured_desc', limit: 50, skip: 0 }, db);
        return rows.length;
      };
      expect(await found('trips')).toBe(9);
      expect(await found('trips/2024')).toBe(7);
      expect(await found('trips/2023')).toBe(2);
      expect(await found('Trips')).toBe(0);
      expect(await found('TRIPS/2024')).toBe(0);
      // And the boundary the regex insists on: a sibling sharing the prefix
      // without a separator is not a subtree.
      expect(await found('trip')).toBe(0);
    });
  });
});

describe('searchPage — the document a result is projected from', () => {
  test('carries the fields the wire projection reads', async () => {
    await withLibrary(async (db, library) => {
      const where = translate({ name: 'harbour', query: () => ({ q: 'harbour.dng' }) }, library);
      const rows = await searchPage(where, { sort: 'captured_desc', limit: 1, skip: 0 }, db);
      const doc = rows[0]!;
      expect(doc._id.toHexString()).toBe(library.assets.get('harbour')!);
      expect(doc.fileinfo?.[0]?.filename).toBe('harbour.dng');
      expect(doc.fileinfo?.[0]?.library_id.toHexString()).toBe(library.libraryId);
      expect(doc.exif?.camera_make).toBe('Apple');
      expect(doc.exif?.aperture).toBe(1.8);
      expect(doc.place?.rollups?.locality).toBe('Albany');
      expect(doc.description).toBe('a quiet harbour at dawn');
      expect(doc.rating).toBe(5);
      expect(doc.has_xmp).toBe(true);
      expect(doc.hidden).toBe(false);
    });
  });

  test('leaves an unenriched asset with a null caption rather than a missing key', async () => {
    await withLibrary(async (db, library) => {
      const where = translate({ name: 'undated', query: () => ({ q: 'undated' }) }, library);
      const rows = await searchPage(where, { sort: 'captured_desc', limit: 1, skip: 0 }, db);
      expect(rows[0]!.description).toBe(null);
      expect(rows[0]!.phasset_links).toEqual([]);
    });
  });
});

describe('searchCount — the three excluded assets', () => {
  test('a soft-deleted asset, a replaced file and a missing file are all out', async () => {
    await withLibrary(async (db, library) => {
      const where = translate({ name: 'all', query: () => ({ hidden: 'all' }) }, library);
      const ids = new Set(
        (await searchPage(where, { sort: 'captured_desc', limit: 50, skip: 0 }, db)).map((row) =>
          row._id.toHexString(),
        ),
      );
      for (const name of ['trashed', 'replaced', 'vanished']) {
        expect(ids.has(library.assets.get(name)!)).toBe(false);
      }
      expect(ids.size).toBe(10);
    });
  });
});
