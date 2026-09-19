/**
 * End-to-end seek pagination over `GET /api/search` (#2129).
 *
 * The interesting property is *equivalence*: walking the whole result set
 * with cursors has to produce exactly the same rows, in exactly the same
 * order, as walking it with `page`/`limit`. The seeded fixture is built to
 * break a naive implementation:
 *
 *   - duplicate `captured_at` values, so the `id` tiebreak actually fires
 *     at a page boundary rather than only in theory;
 *   - rows with no capture date at all — the group a seek silently drops if
 *     it doesn't span the dated→undated boundary explicitly;
 *   - a page size that puts the boundary mid-page in one direction and on a
 *     page edge in the other.
 *
 * Real SQLite, installed as the process-wide handle so the route reaches it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { listRoute } from './list.ts';
import { _resetCacheForTests } from './total-cache.ts';
import { encodeCursor } from './cursor.ts';
import { seedSearchAsset } from '../../db/sqlite/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let libraryId: string;

/** `captured_at` for each seeded row, in seed order. Deliberately not
 * sorted, with two repeated timestamps so the `id` tiebreak matters. The
 * trailing nulls are the undated group the seek has to reach. */
const TIMESTAMPS: Array<string | null> = [
  '2024-01-05T00:00:00.000Z',
  '2024-01-03T00:00:00.000Z',
  '2024-01-09T00:00:00.000Z',
  '2024-01-03T00:00:00.000Z', // duplicate of index 1
  '2024-01-07T00:00:00.000Z',
  '2024-01-01T00:00:00.000Z',
  '2024-01-03T00:00:00.000Z', // duplicate again — three rows share this
  '2024-01-08T00:00:00.000Z',
  '2024-01-02T00:00:00.000Z',
  '2024-01-06T00:00:00.000Z',
  null,
  null,
  null,
  null,
  null,
  null,
];

const TOTAL_SEEDED = TIMESTAMPS.length;
/** Index of the first undated row; everything from here up is untimed. */
const FIRST_UNTIMED = TIMESTAMPS.findIndex((ts) => ts === null);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { slug: 'cursor-paging', path: '/lib' });
  // Ids ascend with the seed index, so the `id` tiebreak inside a tie group
  // is predictable and the expected orders below can be written out.
  TIMESTAMPS.forEach((capturedAt, index) => {
    const suffix = String(index).padStart(3, '0');
    seedSearchAsset(live.db, libraryId, {
      id: String(index).padStart(24, '0'),
      filename: `cursor-${suffix}.dng`,
      capturedAt,
    });
  });
  _resetCacheForTests();
});

afterEach(() => {
  live.close();
  _resetCacheForTests();
});

const app = new Elysia().use(listRoute);

interface PageBody {
  total: number;
  results: Array<{ filename: string }>;
  cursorPaging: boolean;
  nextCursor: string | null;
  error?: string;
}

async function fetchPage(qs: string): Promise<{ status: number; body: PageBody }> {
  const res = await app.handle(new Request(`http://localhost/?libraryId=${libraryId}&${qs}`));
  return { status: res.status, body: (await res.json()) as PageBody };
}

/** Walk the whole set with `page`/`limit`. */
async function walkBySkip(sort: string, limit: number): Promise<string[]> {
  const names: string[] = [];
  for (let page = 0; page < 50; page += 1) {
    const { body } = await fetchPage(`sort=${sort}&limit=${limit}&page=${page}`);
    names.push(...body.results.map((r) => r.filename));
    if (body.results.length < limit) break;
  }
  return names;
}

/** Walk the whole set with `cursor`, asserting the cursor is only absent
 * on the final page. Returns the row names plus the number of requests. */
async function walkByCursor(
  sort: string,
  limit: number,
): Promise<{ names: string[]; requests: number }> {
  const names: string[] = [];
  const first = await fetchPage(`sort=${sort}&limit=${limit}`);
  expect(first.status).toBe(200);
  names.push(...first.body.results.map((r) => r.filename));
  const walk = async (cursor: string | null, requests: number): Promise<number> => {
    if (cursor === null) return requests;
    const { status, body } = await fetchPage(
      `sort=${sort}&limit=${limit}&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(status).toBe(200);
    names.push(...body.results.map((r) => r.filename));
    return walk(body.nextCursor, requests + 1);
  };
  const requests = await walk(first.body.nextCursor, 1);
  return { names, requests };
}

describe('GET /api/search — seek pagination (#2129)', () => {
  it('captured_desc: cursor walk matches the skip walk exactly', async () => {
    const bySkip = await walkBySkip('captured_desc', 4);
    const byCursor = await walkByCursor('captured_desc', 4);
    expect(byCursor.names).toEqual(bySkip);
    expect(bySkip.length).toBe(TOTAL_SEEDED);
  });

  it('captured_asc: cursor walk matches the skip walk exactly', async () => {
    const bySkip = await walkBySkip('captured_asc', 4);
    const byCursor = await walkByCursor('captured_asc', 4);
    expect(byCursor.names).toEqual(bySkip);
    expect(bySkip.length).toBe(TOTAL_SEEDED);
  });

  it('reaches every untimed row', async () => {
    // The regression this guards: a seek that compares only dated values
    // walks off the end of them and loses this whole group.
    const { names } = await walkByCursor('captured_desc', 4);
    const untimed = names.filter((n) => {
      const i = Number(n.slice('cursor-'.length, -'.dng'.length));
      return i >= FIRST_UNTIMED;
    });
    expect(untimed.length).toBe(TOTAL_SEEDED - FIRST_UNTIMED);
    expect(new Set(names).size).toBe(TOTAL_SEEDED);
  });

  it('never repeats a row across the tie-broken timestamp', async () => {
    // Three rows share 2024-01-03; limit 2 forces a page boundary inside
    // that tie group in at least one direction.
    for (const sort of ['captured_desc', 'captured_asc']) {
      const { names } = await walkByCursor(sort, 2);
      expect(new Set(names).size).toBe(names.length);
      expect(names.length).toBe(TOTAL_SEEDED);
    }
  });

  it('stops paging with a null cursor on a short final page', async () => {
    const { body } = await fetchPage('sort=captured_desc&limit=100');
    expect(body.results.length).toBe(TOTAL_SEEDED);
    expect(body.nextCursor).toBeNull();
    // `cursorPaging: true` alongside a null cursor is what tells the client
    // the chain is *exhausted* rather than unavailable — without it a stale
    // cached `total` sends the grid back to deep SKIP paging.
    expect(body.cursorPaging).toBe(true);
  });

  it('keeps `total` unshrunk as the cursor advances', async () => {
    const first = await fetchPage('sort=captured_desc&limit=4');
    expect(first.body.total).toBe(TOTAL_SEEDED);
    const second = await fetchPage(
      `sort=captured_desc&limit=4&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
    );
    expect(second.body.total).toBe(TOTAL_SEEDED);
  });

  it('honours structured filters alongside the seek', async () => {
    // A `from` bound already narrows `captured_at`; the seek must be
    // conjoined with it rather than replace it.
    const qs = 'sort=captured_desc&limit=2&from=2024-01-06&to=2024-01-09';
    const first = await fetchPage(qs);
    expect(first.body.results.length).toBe(2);
    const second = await fetchPage(`${qs}&cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    const all = [...first.body.results, ...second.body.results].map((r) => r.filename);
    expect(all).toEqual([
      'cursor-002.dng', // 01-09
      'cursor-007.dng', // 01-08
      'cursor-004.dng', // 01-07
      'cursor-009.dng', // 01-06
    ]);
    // The second page was full, so a cursor is still minted (see the
    // `nextCursor` comment in list.ts); the third fetch is what comes back
    // empty and terminates the walk.
    const third = await fetchPage(`${qs}&cursor=${encodeURIComponent(second.body.nextCursor!)}`);
    expect(third.body.results).toEqual([]);
    expect(third.body.nextCursor).toBeNull();
  });
});

describe('GET /api/search — sorts without a seek story (#2129)', () => {
  it('mints no cursor for `name` or `rating`', async () => {
    for (const sort of ['name', 'rating']) {
      const { body } = await fetchPage(`sort=${sort}&limit=4`);
      expect(body.results.length).toBe(4);
      expect(body.nextCursor).toBeNull();
      // `false` here means "not available", not "exhausted" — the client
      // keeps paging with `page`.
      expect(body.cursorPaging).toBe(false);
    }
  });

  it('400s rather than silently restarting when a cursor is sent anyway', async () => {
    const cursor = encodeCursor({
      v: '2024-01-05T00:00:00.000Z',
      i: new ObjectId().toHexString(),
      d: 'desc',
    });
    const { status, body } = await fetchPage(
      `sort=name&limit=4&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(status).toBe(400);
    expect(body.error).toContain('not available for this sort');
  });

  it('400s when the cursor direction disagrees with the sort', async () => {
    const cursor = encodeCursor({
      v: '2024-01-05T00:00:00.000Z',
      i: new ObjectId().toHexString(),
      d: 'desc',
    });
    const { status, body } = await fetchPage(
      `sort=captured_asc&limit=4&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(status).toBe(400);
    expect(body.error).toBe('invalid cursor');
  });

  it('400s on a forged cursor rather than resuming from somewhere arbitrary', async () => {
    const forged = Buffer.from(
      JSON.stringify({ v: { $ne: null }, i: new ObjectId().toHexString(), d: 'desc' }),
      'utf8',
    ).toString('base64url');
    const { status, body } = await fetchPage(
      `sort=captured_desc&limit=4&cursor=${encodeURIComponent(forged)}`,
    );
    expect(status).toBe(400);
    expect(body.error).toBe('invalid cursor');
  });
});
