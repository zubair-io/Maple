/**
 * Integration tests for `/api/generated-searches`, against real Mongo.
 *
 * This is the contract the Apple widget, the Maple TV shelf, and the settings
 * page all consume, so it is exercised through the Elysia routes rather than
 * by calling the repo directly.
 *
 * The exclusion test is the important one: nothing in the stored document
 * mentions the hidden person, and the doc is deliberately written with
 * `excludeHiddenPeople: 'false'` to simulate data from an earlier worker
 * version. The exclusion has to come from re-deriving the query at request
 * time.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { getDb } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';
import { generatedSearchesRoutes } from './generated-searches.ts';
import { generatedSearchConfigRoutes } from '../workers/generated-search/routes.ts';
import { _resetRunNowForTests, _awaitRunNowForTests } from '../workers/generated-search/run-now.ts';

// Own database + explicit close (the repo-wide suite convention, #2783).
withTestDb(`maple_test_generated_searches_route_${process.pid}`);

let db: Db;
const app = new Elysia().use(generatedSearchesRoutes).use(generatedSearchConfigRoutes);
const LIB = new ObjectId('507f1f77bcf86cd799439011');
const LIB_HEX = LIB.toHexString();

beforeAll(async () => {
  db = await getDb();
});
afterAll(async () => {
  // Drop the handle captured in beforeAll. Deliberately NOT closeDb(): that
  // closes the shared client, and because withTestDb registers root-level
  // beforeAll hooks, by teardown the singleton points at another suite's
  // database — closing it here times out that suite's hooks.
  await db.dropDatabase();
});

/** Scoped per describe — a root-level hook is not confined to this file. */
async function reset(): Promise<void> {
  await Promise.all([
    db.collection('generated_searches').deleteMany({}),
    db.collection('assets').deleteMany({}),
    db.collection('people').deleteMany({}),
  ]);
}

async function get(path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}

async function seedCollection(over: Record<string, unknown> = {}): Promise<string> {
  const id = new ObjectId();
  await db.collection('generated_searches').insertOne({
    _id: id,
    library_id: LIB_HEX,
    generated_for: '2026-08-17',
    generated_at: '2026-08-17T06:00:00.000Z',
    model: 'test-model',
    attempts: 1,
    theme: 'summer sprinklers',
    title: 'Running Through Sprinklers',
    subtitle: 'Back-garden afternoons',
    query: { month: '8' },
    result_count: 2,
    cover_asset_id: 'a',
    ...over,
  } as never);
  return id.toHexString();
}

async function seedAsset(id: string, personId?: ObjectId) {
  await db.collection('assets').insertOne({
    maple_id: id,
    fileinfo: [
      {
        library_id: LIB,
        path: `/p/${id}.jpg`,
        filename: `${id}.jpg`,
        deleted_at: null,
        missing_since: null,
      },
    ],
    deleted_at: null,
    size: 1,
    mtime: 1,
    exif: { captured_at: '2018-08-15T12:00:00.000Z', captured_year: 2018, captured_month: 8 },
    description: `caption for ${id}`,
    ...(personId ? { faces: [{ person_id: personId.toHexString() }] } : {}),
  } as never);
}

describe('GET /api/generated-searches', () => {
  beforeEach(reset);

  it('returns the day’s collections as cards', async () => {
    await seedCollection();
    const { status, body } = await get(`/api/generated-searches?libraryId=${LIB_HEX}`);

    expect(status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].title).toBe('Running Through Sprinklers');
    // The stored query rides along so a client can deep-link into /search.
    expect(body.results[0].query).toEqual({ month: '8' });
  });

  it('returns an empty list for a library with no collections', async () => {
    const { status, body } = await get(
      '/api/generated-searches?libraryId=507f1f77bcf86cd799439099',
    );
    expect(status).toBe(200);
    expect(body.results).toEqual([]);
  });
});

describe('GET /api/generated-searches/:id/assets', () => {
  beforeEach(reset);

  it('runs the stored query and returns matching assets', async () => {
    const id = await seedCollection();
    await seedAsset('a');
    await seedAsset('b');

    const { status, body } = await get(`/api/generated-searches/${id}/assets`);
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.results).toHaveLength(2);
  });

  it('pages with limit + offset, and reports the full total on every page', async () => {
    const id = await seedCollection();
    // Distinct capture instants so `captured_desc` gives a stable order to
    // page through — otherwise a tie makes "page 2 continues page 1"
    // unverifiable rather than merely unordered.
    for (let i = 0; i < 5; i++) {
      await db.collection('assets').insertOne({
        maple_id: `p${i}`,
        fileinfo: [
          {
            library_id: LIB,
            path: `/p/p${i}.jpg`,
            filename: `p${i}.jpg`,
            deleted_at: null,
            missing_since: null,
          },
        ],
        deleted_at: null,
        size: 1,
        mtime: 1,
        exif: {
          captured_at: `2018-08-1${i}T12:00:00.000Z`,
          captured_year: 2018,
          captured_month: 8,
        },
      } as never);
    }

    const first = await get(`/api/generated-searches/${id}/assets?limit=2&offset=0`);
    const second = await get(`/api/generated-searches/${id}/assets?limit=2&offset=2`);
    const last = await get(`/api/generated-searches/${id}/assets?limit=2&offset=4`);

    // `total` is the whole collection on every page — that is what lets a
    // client know it has more to fetch.
    expect(first.body.total).toBe(5);
    expect(second.body.total).toBe(5);
    expect(last.body.total).toBe(5);

    expect(first.body.results).toHaveLength(2);
    expect(second.body.results).toHaveLength(2);
    expect(last.body.results).toHaveLength(1);

    // The pages partition the collection: no repeats, nothing skipped. Keyed
    // on `_id` rather than `id` — the latter is derived from the library root
    // path, which this suite doesn't seed.
    const ids = [...first.body.results, ...second.body.results, ...last.body.results].map(
      (r: { _id: string }) => r._id,
    );
    expect(new Set(ids).size).toBe(5);
  });

  it('reads past the first page rather than capping the collection', async () => {
    const id = await seedCollection();
    await seedAsset('a');
    await seedAsset('b');

    // An offset beyond the end is an empty page, not an error — a client that
    // races ahead of `total` gets a clean stop.
    const { status, body } = await get(`/api/generated-searches/${id}/assets?offset=99`);
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.results).toEqual([]);
  });

  it('404s for an unknown collection', async () => {
    const { status } = await get(`/api/generated-searches/${new ObjectId().toHexString()}/assets`);
    expect(status).toBe(404);
  });

  it('400s on a malformed id rather than throwing', async () => {
    const { status } = await get('/api/generated-searches/not-an-id/assets');
    expect(status).toBe(400);
  });

  it('excludes hidden people even when the stored doc tries to opt out', async () => {
    const hidden = new ObjectId();
    await db
      .collection('people')
      .insertOne({ _id: hidden, name: 'Hidden', merged_into: null, hidden: true } as never);

    // Simulates a doc written by an earlier worker version.
    const id = await seedCollection({ query: { month: '8', excludeHiddenPeople: 'false' } });
    await seedAsset('visible');
    await seedAsset('has-hidden-face', hidden);

    const { body } = await get(`/api/generated-searches/${id}/assets`);
    expect(body.total).toBe(1);
  });
});

describe('POST /api/workers/generated-search/run', () => {
  it('starts a pass and refuses a concurrent second one', async () => {
    // Stubbed runner: a real pass hits DB + Ollama with timing that varies
    // under the full suite. The route contract under test is only the
    // immediate started/refused response and the in-flight guard.
    let release: () => void = () => {};
    _resetRunNowForTests(
      () =>
        new Promise((r) => {
          release = () => r({ libraries: 0, saved: 0, pruned: 0, skipped: false });
        }),
    );

    const first = await app.handle(
      new Request('http://localhost/api/workers/generated-search/run', { method: 'POST' }),
    );
    expect((await first.json()).started).toBe(true);

    const second = await app.handle(
      new Request('http://localhost/api/workers/generated-search/run', { method: 'POST' }),
    );
    expect(await second.json()).toEqual({ started: false, reason: 'already-running' });

    release();
    await _awaitRunNowForTests();
    _resetRunNowForTests();
  });
});
