/**
 * The slowest shape `requestWindow` can take, timed (#4545): the in-process engine climbs the
 * whole ladder and every hit is filtered out, so the database is asked too — up to four bounded
 * statements per engine plus the child's round trips. The incident that motivated the window
 * (#4514) was a caption-style text query with a month filter on a large library; this is that
 * shape on a library big enough that a per-match plan would show, and small enough to seed in CI.
 *
 * The budget is wall time with generous headroom for a loaded CI runner. A plan that reads one
 * row per match, or a ladder that stops being bounded, costs orders of magnitude more than it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { setSqliteHandleForTests } from '../../db/sqlite/index.ts';
import { buildSearchWhere } from '../../db/repos/search.where.ts';
import { RANKED_WINDOW_BASE, RANKED_WINDOW_MAX } from '../../db/repos/search.ranked.ts';
import { setInProcessSearchForTests } from '../../search/search-pool.ts';
import { fakeInProcessSearch } from '../../search/search.test-helpers.ts';
import type { SearchQuery } from './query-schema.ts';
import { requestWindow, windowPage } from './ranked-window.ts';

const LIBRARY_SIZE = 30_000;
const CAPTION = 'busy city streets tall buildings and urban cityscapes';
const BUDGET_MS = 1_000;

let live: LiveTestDatabase;
const outsideJune: string[] = [];
const issued: string[] = [];
let child: ReturnType<typeof fakeInProcessSearch>;

beforeAll(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { slug: 'city', path: '/lib' });
  seedCity(live.db, libraryId);
  outsideJune.push(
    ...Array.from({ length: LIBRARY_SIZE }, (_, index) => index)
      .filter((index) => monthOf(index) !== 6)
      .map((index) => `city${index}`),
  );
  live.db.exec('ANALYZE');
  const inner = live.handle;
  setSqliteHandleForTests({
    read: (sql, params) => (issued.push(sql), inner.read(sql, params)),
    write: (sql, params) => inner.write(sql, params),
    transaction: (statements) => inner.transaction(statements),
  });
  // Every hit the child ranks is outside June, so each step of the ladder filters to nothing, and
  // it ranks one short of the cap, so its empty window does not settle the request.
  child = fakeInProcessSearch(outsideJune.slice(0, RANKED_WINDOW_MAX - 1));
  setInProcessSearchForTests(child);
});

afterAll(() => {
  setInProcessSearchForTests(null);
  live.close();
});

const monthOf = (index: number): number => (index % 12) + 1;

/**
 * The library in three set-based statements: a row-at-a-time seed of this size takes longer than
 * a hook may. Each asset has one live location, a capture date spread over 14 years and every
 * month, a search blob that is the caption plus a token of its own, and one in 97 is rated 5.
 */
function seedCity(db: Database, libraryId: string): void {
  const numbered = `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${LIBRARY_SIZE - 1})`;
  const id = `printf('%024x', i + 1)`;
  db.transaction(() => {
    db.run(
      `${numbered}
       INSERT INTO assets (id, size, mtime, indexed_at, rating, flag, color_label, has_xmp,
                           media_kind, hidden, is_screenshot, maple_id, exif)
       SELECT ${id}, 1024, 1700000000000, '2024-01-01T00:00:00.000Z',
              CASE WHEN i % 97 = 0 THEN 5 ELSE 1 END, 0, '', 0, 'image', 0, 0, 'city' || i,
              json_object('captured_at', printf('20%02d-%02d-15T12:00:00.000Z', 10 + i % 14, i % 12 + 1),
                          'captured_year', 2010 + i % 14, 'captured_month', i % 12 + 1)
         FROM n`,
    );
    db.run(
      `${numbered}
       INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename)
       SELECT ${id}, 0, ?, '/lib/city' || i || '.dng', 'city' || i || '.dng' FROM n`,
      [libraryId],
    );
    db.run(
      `${numbered}
       INSERT INTO asset_search (asset_id, search_blob)
       SELECT ${id}, ? || ' ' || substr('xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 1, 1 + i % 29) || i FROM n`,
      [CAPTION],
    );
  })();
}

function where(q: SearchQuery) {
  const built = buildSearchWhere(q);
  if ('error' in built) throw new Error(built.error);
  return built;
}

/** One list request's work, timed whole: the window, then its first page hydrated. */
async function timed(q: SearchQuery) {
  issued.length = 0;
  child.queries.length = 0;
  const started = performance.now();
  const window = await requestWindow({ where: where(q), text: CAPTION, need: RANKED_WINDOW_BASE });
  const ranking = issued.length;
  const page = await windowPage(window, { where: where(q), skip: 0, limit: RANKED_WINDOW_BASE });
  const elapsedMs = performance.now() - started;
  console.log(
    JSON.stringify({
      query: q,
      ranking,
      statements: issued.length,
      elapsedMs: Math.round(elapsedMs),
    }),
  );
  return { window, page, elapsedMs, ranking, depths: child.queries.map((query) => query.k) };
}

describe('requestWindow when the engines come back empty short of the cap (#4545)', () => {
  it('answers a caption-style query with a month filter inside the budget', async () => {
    const { window, page, elapsedMs, ranking, depths } = await timed({
      placeQuery: CAPTION,
      month: '6',
    });

    expect(depths).toHaveLength(4);
    expect(window.engine).toBe('database');
    expect(page.results).toHaveLength(RANKED_WINDOW_BASE);
    expect(ranking).toBeLessThanOrEqual(2 * 4);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it('stays inside the budget when a further filter makes the database climb its ladder too', async () => {
    const { window, elapsedMs, ranking, depths } = await timed({
      placeQuery: CAPTION,
      month: '6',
      rating: '5',
    });

    expect(depths).toHaveLength(4);
    expect(window.engine).toBe('database');
    expect(window.rows.length).toBeGreaterThan(0);
    expect(window.rows.length).toBeLessThan(RANKED_WINDOW_BASE);
    expect(ranking).toBeLessThanOrEqual(2 * 4);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });
});
