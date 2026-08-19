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
import { closeDb, getDb } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';
import { generatedSearchesRoutes } from './generated-searches.ts';

// Own database + explicit close (the repo-wide suite convention, #2783).
withTestDb(`maple_test_generated_searches_route_${process.pid}`);

let db: Db;
const app = new Elysia().use(generatedSearchesRoutes);
const LIB = new ObjectId('507f1f77bcf86cd799439011');
const LIB_HEX = LIB.toHexString();

beforeAll(async () => {
  db = await getDb();
});
afterAll(async () => {
  await db.dropDatabase();
  await closeDb();
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
      { library_id: LIB, path: `/p/${id}.jpg`, filename: `${id}.jpg`, deleted_at: null, missing_since: null },
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
