/**
 * #2956 — the search response never said which dates were in effect, so no
 * client could show them. `august` quietly filtered to August 2025 and
 * `2024` quietly restricted to that year, with the Filters panel showing
 * nothing and both date inputs empty. That is the state a user described as
 * "I did not have a date selected" in #2928 — they were right, and the UI
 * agreed with them while the query said otherwise.
 *
 * The response now carries the window actually applied, plus the text it was
 * inferred from when it came out of the query rather than from an explicit
 * param. Clients render the first and attribute it with the second.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { listRoute } from './list.ts';
import { closeDb, getDb, isDbConnected } from '../../db/client.ts';
import { withTestDb } from '../../db/test-db.test-helpers.ts';

withTestDb(`maple_test_search_dateprov_${process.pid}`);

let db: Db | null = null;
let mongoReachable = false;

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
  // Queries with residual text take the Mongo `$text` path, which needs the
  // index the real deployment builds at startup.
  await db
    .collection('assets')
    .createIndex({ search_blob: 'text' })
    .catch(() => {});
  await db.collection('assets').insertOne({
    maple_id: 'maple-1',
    fileinfo: [{ path: '', filename: 'a.dng', library_id: new ObjectId(), deleted_at: null }],
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: 'now',
    deleted_at: null,
    hidden: false,
    exif: { captured_at: '2024-05-05T12:00:00.000Z' },
  } as never);
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  await closeDb();
});

async function search(qs: string): Promise<Record<string, unknown>> {
  const app = new Elysia().use(listRoute);
  const res = await app.handle(new Request(`http://localhost/?${qs}`));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('GET /api/search — applied date window is reported', () => {
  it('reports a window inferred from the query text, and the text it came from', async () => {
    if (!mongoReachable) return;
    const body = await search('placeQuery=2024');
    expect(body.dateFilter).toEqual({
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-12-31T23:59:59.999Z',
      inferredFrom: '2024',
    });
  });

  it('attributes only the consumed text, not the whole query', async () => {
    if (!mongoReachable) return;
    const body = await search('placeQuery=2024%20skiing');
    expect((body.dateFilter as { inferredFrom?: string })?.inferredFrom).toBe('2024');
  });

  it('reports an explicit window with no inferred attribution', async () => {
    if (!mongoReachable) return;
    const body = await search('from=2024-01-01&to=2024-06-30');
    expect(body.dateFilter).toEqual({
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-06-30T23:59:59.999Z',
    });
  });

  it('omits the field entirely when no date constraint is active', async () => {
    if (!mongoReachable) return;
    const body = await search('placeQuery=skiing');
    expect(body.dateFilter).toBeUndefined();
  });

  /**
   * `extractDatesFromQuery` intersects the parse with explicit params,
   * tightest-bound-wins. When the explicit bounds win BOTH ends, the window
   * on screen is the user's own — attributing it to their search text tells
   * them something untrue about their own query (#2960).
   */
  it('does not attribute a window an explicit param owns outright', async () => {
    if (!mongoReachable) return;
    const body = await search('placeQuery=2024&from=2024-03-01&to=2024-04-30');
    expect(body.dateFilter).toEqual({
      from: '2024-03-01T00:00:00.000Z',
      to: '2024-04-30T23:59:59.999Z',
    });
  });

  it('still attributes when the query text set one of the bounds', async () => {
    if (!mongoReachable) return;
    // The explicit `from` tightens the lower bound; the upper is still the
    // parse's own, so the text did contribute and is named.
    const body = await search('placeQuery=2024&from=2024-03-01');
    expect(body.dateFilter).toEqual({
      from: '2024-03-01T00:00:00.000Z',
      to: '2024-12-31T23:59:59.999Z',
      inferredFrom: '2024',
    });
  });

  // Which WORDS the parser treats as dates is #2952's concern and is covered
  // by its own tests. This file only asserts that whatever window ends up
  // applied is reported, and attributed when it came from the query text.
});
