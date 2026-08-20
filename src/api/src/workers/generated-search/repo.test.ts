/**
 * Integration tests for the `generated_searches` repo. Real Mongo, no mocks —
 * the collection IS the contract between the worker and its three consumers
 * (Settings → Workers, the Maple TV shelf, the Apple widget).
 *
 * Suite-scoped DB via `withTestDb` (#2900): assigning `MAPLE_MONGO_DB` at
 * module scope renames the database process-wide at import time, which is the
 * #2783 flake class.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { Db } from 'mongodb';
import { getDb } from '../../db/client.ts';
import { withTestDb } from '../../db/test-db.test-helpers.ts';
import {
  saveGeneratedSearches,
  listGeneratedSearches,
  pruneGeneratedSearches,
  type GeneratedSearchInput,
} from './repo.ts';

// Own database + explicit close (the repo-wide suite convention, #2783).
withTestDb(`maple_test_generated_search_repo_${process.pid}`);

let db: Db;

beforeAll(async () => {
  db = await getDb();
});

afterAll(async () => {
  // Capture-and-drop the handle taken in beforeAll: by teardown `getDb()`
  // answers with the default database again (see test-db.test-helpers).
  // Drop the handle captured in beforeAll. Deliberately NOT closeDb(): that
  // closes the shared client, and because withTestDb registers root-level
  // beforeAll hooks, by teardown the singleton points at another suite's
  // database — closing it here times out that suite's hooks.
  await db.dropDatabase();
});

/** Scoped per describe rather than at the root: a root-level hook is not
 * confined to this file, so shared-collection cleanup there disrupts other
 * suites in the same process. */
async function reset(): Promise<void> {
  await db.collection('generated_searches').deleteMany({});
}

const LIB = '507f1f77bcf86cd799439011';
const OTHER_LIB = '507f1f77bcf86cd799439012';

function input(over: Partial<GeneratedSearchInput> = {}): GeneratedSearchInput {
  return {
    library_id: LIB,
    generated_for: '2026-08-17',
    generated_at: '2026-08-17T06:00:00.000Z',
    model: 'ornith:35b',
    attempts: 1,
    theme: 'summer sprinklers',
    title: 'Running Through Sprinklers',
    subtitle: 'Back-garden afternoons',
    query: { placeQuery: 'children running through sprinklers', month: '8' },
    result_count: 34,
    cover_asset_id: 'abc123',
    ...over,
  };
}

describe('generated_searches repo', () => {
  beforeEach(reset);

  it('round-trips a saved collection', async () => {
    await saveGeneratedSearches([input()]);
    const [doc] = await listGeneratedSearches(LIB, '2026-08-17');

    expect(doc.title).toBe('Running Through Sprinklers');
    expect(doc.theme).toBe('summer sprinklers');
    expect(doc.query.placeQuery).toBe('children running through sprinklers');
    expect(doc.query.month).toBe('8');
    expect(doc.result_count).toBe(34);
    expect(doc.cover_asset_id).toBe('abc123');
  });

  it('scopes the listing to one library', async () => {
    // A leak here would surface another library's photos on an ambient
    // living-room screen, so it gets its own test rather than an assertion
    // tacked onto the round-trip.
    await saveGeneratedSearches([input(), input({ library_id: OTHER_LIB, theme: 'other' })]);

    const mine = await listGeneratedSearches(LIB, '2026-08-17');
    expect(mine).toHaveLength(1);
    expect(mine[0].theme).toBe('summer sprinklers');
  });

  it('scopes the listing to the requested day', async () => {
    await saveGeneratedSearches([input(), input({ generated_for: '2026-08-16', theme: 'older' })]);

    const today = await listGeneratedSearches(LIB, '2026-08-17');
    expect(today.map((d) => d.theme)).toEqual(['summer sprinklers']);
  });

  it('returns the most recent day when no date is given', async () => {
    await saveGeneratedSearches([
      input({ generated_for: '2026-08-15', theme: 'oldest' }),
      input({ generated_for: '2026-08-17', theme: 'newest' }),
      input({ generated_for: '2026-08-16', theme: 'middle' }),
    ]);

    const latest = await listGeneratedSearches(LIB);
    expect(latest.map((d) => d.theme)).toEqual(['newest']);
  });

  it('saves several collections from one run', async () => {
    await saveGeneratedSearches([input({ theme: 'a' }), input({ theme: 'b' })]);
    const docs = await listGeneratedSearches(LIB, '2026-08-17');
    expect(docs.map((d) => d.theme).sort()).toEqual(['a', 'b']);
  });
});

describe('generated_searches pruning', () => {
  beforeEach(reset);

  it('drops collections past the retention window and keeps the rest', async () => {
    await saveGeneratedSearches([
      input({ generated_at: '2026-06-01T06:00:00.000Z', theme: 'ancient' }),
      input({ generated_at: '2026-08-17T06:00:00.000Z', theme: 'fresh' }),
    ]);

    const removed = await pruneGeneratedSearches(30, new Date('2026-08-17T12:00:00.000Z'));
    expect(removed).toBe(1);

    const left = await db.collection('generated_searches').find({}).toArray();
    expect(left.map((d) => d.theme)).toEqual(['fresh']);
  });

  it('removes nothing when everything is inside the window', async () => {
    await saveGeneratedSearches([input()]);
    expect(await pruneGeneratedSearches(30, new Date('2026-08-17T12:00:00.000Z'))).toBe(0);
  });
});
