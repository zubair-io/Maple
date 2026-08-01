/**
 * End-to-end seek pagination over `GET /api/search` (#2129).
 *
 * The interesting property is *equivalence*: walking the whole result set
 * with cursors has to produce exactly the same rows, in exactly the same
 * order, as walking it with `page`/`limit`. The seeded fixture is built to
 * break a naive implementation:
 *
 *   - duplicate `captured_at` values, so the `_id` tiebreak actually fires
 *     at a page boundary rather than only in theory;
 *   - rows with `captured_at: null`, rows with `exif` present but no
 *     `captured_at`, and rows with no `exif` at all — the three shapes that
 *     MongoDB's type-bracketed range predicates silently drop if the seek
 *     doesn't span the String→Null boundary explicitly;
 *   - a page size that puts the boundary mid-page in one direction and on a
 *     page edge in the other.
 *
 * Real Mongo required (localhost:27017 by default, override via
 * `MAPLE_MONGO_URI`) — soft-skips when unreachable, matching `list.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { listRoute } from './list.ts';
import { _resetCacheForTests } from './total-cache.ts';
import { encodeCursor } from './cursor.ts';
import { getDb, isDbConnected } from '../../db/client.ts';

let db: Db | null = null;
let mongoReachable = false;
const LIBRARY = new ObjectId();

/** `captured_at` for each seeded row, in seed order. Deliberately not
 * sorted, with two repeated timestamps so the `_id` tiebreak matters. */
const TIMESTAMPS: Array<string | null | undefined> = [
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
  null, // explicit null
  undefined, // `exif` present, `captured_at` absent
  null,
  undefined,
];
/** Rows seeded with no `exif` sub-document at all. */
const NO_EXIF_COUNT = 2;

function docFor(index: number, capturedAt: string | null | undefined): Record<string, unknown> {
  const base = {
    maple_id: `cursor-fixture-${String(index).padStart(3, '0')}`,
    fileinfo: [
      {
        path: '',
        filename: `cursor-${String(index).padStart(3, '0')}.dng`,
        library_id: LIBRARY,
        deleted_at: null,
      },
    ],
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: 'now',
    deleted_at: null,
    hidden: false,
  };
  if (capturedAt === undefined) return { ...base, exif: {} };
  return { ...base, exif: { captured_at: capturedAt } };
}

const TOTAL_SEEDED = TIMESTAMPS.length + NO_EXIF_COUNT;

beforeAll(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
  const docs = TIMESTAMPS.map((ts, i) => docFor(i, ts));
  for (let i = 0; i < NO_EXIF_COUNT; i += 1) {
    const { exif: _exif, ...withoutExif } = docFor(TIMESTAMPS.length + i, null) as {
      exif?: unknown;
    } & Record<string, unknown>;
    docs.push(withoutExif as Record<string, unknown>);
  }
  await db.collection('assets').insertMany(docs as never);
  _resetCacheForTests();
});

afterAll(async () => {
  if (db) await db.collection('assets').deleteMany({});
  _resetCacheForTests();
});

const app = new Elysia().use(listRoute);

interface PageBody {
  total: number;
  results: Array<{ filename: string }>;
  nextCursor: string | null;
  error?: string;
}

async function fetchPage(qs: string): Promise<{ status: number; body: PageBody }> {
  const res = await app.handle(
    new Request(`http://localhost/?libraryId=${LIBRARY.toHexString()}&${qs}`),
  );
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
    if (!mongoReachable) return;
    const bySkip = await walkBySkip('captured_desc', 4);
    const byCursor = await walkByCursor('captured_desc', 4);
    expect(byCursor.names).toEqual(bySkip);
    expect(bySkip.length).toBe(TOTAL_SEEDED);
  });

  it('captured_asc: cursor walk matches the skip walk exactly', async () => {
    if (!mongoReachable) return;
    const bySkip = await walkBySkip('captured_asc', 4);
    const byCursor = await walkByCursor('captured_asc', 4);
    expect(byCursor.names).toEqual(bySkip);
    expect(bySkip.length).toBe(TOTAL_SEEDED);
  });

  it('reaches every untimed row — null, missing field, and missing exif', async () => {
    if (!mongoReachable) return;
    // The regression this guards: `{captured_at: {$lt: "…"}}` is
    // type-bracketed to strings, so a seek that doesn't explicitly span the
    // String→Null boundary loses this whole group.
    const { names } = await walkByCursor('captured_desc', 4);
    const untimed = names.filter((n) => {
      const i = Number(n.slice('cursor-'.length, -'.dng'.length));
      return i >= 10;
    });
    expect(untimed.length).toBe(6);
    expect(new Set(names).size).toBe(TOTAL_SEEDED);
  });

  it('never repeats a row across the tie-broken timestamp', async () => {
    if (!mongoReachable) return;
    // Three rows share 2024-01-03; limit 2 forces a page boundary inside
    // that tie group in at least one direction.
    for (const sort of ['captured_desc', 'captured_asc']) {
      const { names } = await walkByCursor(sort, 2);
      expect(new Set(names).size).toBe(names.length);
      expect(names.length).toBe(TOTAL_SEEDED);
    }
  });

  it('stops paging with a null cursor on a short final page', async () => {
    if (!mongoReachable) return;
    const { body } = await fetchPage('sort=captured_desc&limit=100');
    expect(body.results.length).toBe(TOTAL_SEEDED);
    expect(body.nextCursor).toBeNull();
  });

  it('keeps `total` unshrunk as the cursor advances', async () => {
    if (!mongoReachable) return;
    const first = await fetchPage('sort=captured_desc&limit=4');
    expect(first.body.total).toBe(TOTAL_SEEDED);
    const second = await fetchPage(
      `sort=captured_desc&limit=4&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
    );
    expect(second.body.total).toBe(TOTAL_SEEDED);
  });

  it('honours structured filters alongside the seek', async () => {
    if (!mongoReachable) return;
    // A `from` bound already brackets `captured_at` to strings; the seek
    // must `$and` onto it rather than replace it.
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
    if (!mongoReachable) return;
    for (const sort of ['name', 'rating']) {
      const { body } = await fetchPage(`sort=${sort}&limit=4`);
      expect(body.results.length).toBe(4);
      expect(body.nextCursor).toBeNull();
    }
  });

  it('400s rather than silently restarting when a cursor is sent anyway', async () => {
    if (!mongoReachable) return;
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
    if (!mongoReachable) return;
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

  it('400s on a forged cursor instead of coercing it into the query', async () => {
    if (!mongoReachable) return;
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
