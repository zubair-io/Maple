/**
 * Face `person_id` → display-name resolution in the detail DTO (#2518).
 * Split from `assets.repo.test.ts` to keep that file under the LOC budget.
 * Requires a running MongoDB; skips gracefully if unreachable.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { findDetailById } from './assets.repo.ts';
import { closeDb } from './client.ts';
import { pendingEnrichment } from './schema.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_person_names_test_${process.pid}`;
const ORIGINAL_MONGO_DB = process.env.MAPLE_MONGO_DB;
const ORIGINAL_MONGO_URI = process.env.MAPLE_MONGO_URI;

let client: MongoClient | null = null;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

beforeEach(async () => {
  client = await tryConnect();
  if (!client) return;
  await closeDb();
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
  if (ORIGINAL_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = ORIGINAL_MONGO_DB;
  if (ORIGINAL_MONGO_URI === undefined) delete process.env.MAPLE_MONGO_URI;
  else process.env.MAPLE_MONGO_URI = ORIGINAL_MONGO_URI;
  await closeDb();
});

async function seedAsset(d: Db, faces: unknown[]): Promise<ObjectId> {
  const id = new ObjectId();
  await d.collection('assets').insertOne({
    _id: id,
    fileinfo: [{ path: '', filename: 'a.dng', library_id: new ObjectId(), deleted_at: null }],
    size: 1024,
    mtime: 1_700_000_000_000,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-01-01T00:00:00Z',
    has_xmp: false,
    deleted_at: null,
    enrichment: pendingEnrichment(),
    faces,
  } as never);
  return id;
}

describe('findDetailById — face person names', () => {
  it('resolves assigned faces to names, leaves unassigned/unknown null', async () => {
    if (!db) return;
    const alice = new ObjectId();
    await db.collection('people').insertOne({ _id: alice, name: 'Alice' } as never);
    const unknown = new ObjectId(); // referenced by a face, absent from people
    const id = await seedAsset(db, [
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: alice.toHexString(), confidence: 0.9 },
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.8 },
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: unknown.toHexString(), confidence: 0.7 },
    ]);
    const dto = await findDetailById(id, db);
    expect(dto!.faces.map((f) => f.name)).toEqual(['Alice', null, null]);
    // The raw person_id is preserved alongside the resolved name.
    expect(dto!.faces[0].person_id).toBe(alice.toHexString());
  });

  it('matches names case-insensitively vs the stored id case', async () => {
    if (!db) return;
    const bob = new ObjectId();
    await db.collection('people').insertOne({ _id: bob, name: 'Bob' } as never);
    const id = await seedAsset(db, [
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        person_id: bob.toHexString().toUpperCase(),
        confidence: 0.9,
      },
    ]);
    const dto = await findDetailById(id, db);
    expect(dto!.faces[0].name).toBe('Bob');
  });

  it('a malformed person_id does not drop names for the other faces', async () => {
    if (!db) return;
    const carol = new ObjectId();
    await db.collection('people').insertOne({ _id: carol, name: 'Carol' } as never);
    const id = await seedAsset(db, [
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: 'not-a-valid-objectid', confidence: 0.9 },
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: carol.toHexString(), confidence: 0.8 },
    ]);
    const dto = await findDetailById(id, db);
    expect(dto!.faces.map((f) => f.name)).toEqual([null, 'Carol']);
  });
});
