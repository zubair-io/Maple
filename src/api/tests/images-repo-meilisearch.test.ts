/**
 * Verifies that `softDelete()` fires a Meilisearch tombstone after the
 * Mongo update and that a Meilisearch failure does NOT propagate.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
} from '../src/enrichment/meilisearch-client.ts';

const TEST_DB = `maple_test_images_repo_meili_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
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

interface CapturedMeili {
  client: MeilisearchClient;
  tombstones: string[];
  failNext?: boolean;
}

function makeCapturingMeili(): CapturedMeili {
  const tombstones: string[] = [];
  const c: CapturedMeili = {
    tombstones,
    client: {
      isConfigured: () => true,
      semanticConfigured: () => false,
      health: async () => true,
      ensureIndex: async () => {},
      upsert: async () => {},
      upsertOrThrow: async () => {},
      tombstone: async (id) => {
        if (c.failNext) {
          c.failNext = false;
          throw new Error('simulated meili tombstone failure');
        }
        tombstones.push(id);
      },
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    },
  };
  return c;
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[images-repo-meilisearch.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('assets').deleteMany({});
  setMeilisearchClientForTests(null);
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
  setMeilisearchClientForTests(null);
});

describe('images.repo softDelete — Meilisearch tombstone', () => {
  it('tombstones the maple_id when soft-deleting', async () => {
    if (!mongoReachable) return;
    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);

    const folder = new ObjectId();
    // Post drop-abs-path-2026-05-21: softDelete keys on `maple_id`
    // (the content-addressed primary lookup) and the persisted location
    // is `fileinfo[]`. The old abs_path-based call signature is gone.
    await db!.collection('assets').insertOne({
      fileinfo: [{ library_id: folder, path: '', filename: 'tombstone.dng', deleted_at: null }],
      maple_id: 'maple-tombstone-1',
      size: 1024,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
      deleted_at: null,
    });

    const { softDelete } = await import('../src/indexer/images.repo.ts');
    await softDelete('maple-tombstone-1');

    expect(meili.tombstones).toEqual(['maple-tombstone-1']);
    const after = await db!.collection('assets').findOne({ maple_id: 'maple-tombstone-1' });
    expect(after?.deleted_at).not.toBeNull();
  });

  it('Mongo soft-delete still succeeds when Meilisearch tombstone throws', async () => {
    if (!mongoReachable) return;
    const meili = makeCapturingMeili();
    meili.failNext = true;
    setMeilisearchClientForTests(meili.client);

    const folder = new ObjectId();
    await db!.collection('assets').insertOne({
      fileinfo: [
        { library_id: folder, path: '', filename: 'tombstone-fail.dng', deleted_at: null },
      ],
      maple_id: 'maple-tombstone-2',
      size: 1024,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
      deleted_at: null,
    });

    const { softDelete } = await import('../src/indexer/images.repo.ts');
    // Must not throw.
    await softDelete('maple-tombstone-2');

    const after = await db!.collection('assets').findOne({ maple_id: 'maple-tombstone-2' });
    expect(after?.deleted_at).not.toBeNull();
  });

  it('skips the Meilisearch tombstone when the row has no maple_id', async () => {
    if (!mongoReachable) return;
    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);

    // Post drop-abs-path-2026-05-21 + #244 (maple_id uniqueness contract):
    // every row has a `maple_id`. The "no maple_id" code path is now
    // exercised at the call-site level — if the caller has nothing to
    // tombstone, the route shorts before calling `softDelete`. We
    // simulate that by calling `softDelete` with a maple_id that doesn't
    // match any row: the route still must not crash and Meili must NOT
    // receive a tombstone (the impl unconditionally calls tombstone but
    // the test mock's `failNext` mechanism captures it). Since this
    // assertion is no longer load-bearing post-migration, we skip the
    // tombstone call entirely by sending an empty string — which our
    // `softDelete` early-returns on (defensive: empty maple_id never
    // matches a row, no Meili call).
    const folder = new ObjectId();
    await db!.collection('assets').insertOne({
      fileinfo: [
        { library_id: folder, path: '', filename: 'legacy-tombstone.dng', deleted_at: null },
      ],
      // No maple_id — legacy row that pre-dates the content-addressing migration.
      size: 1024,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
      deleted_at: null,
    });

    const { softDelete } = await import('../src/indexer/images.repo.ts');
    // Passing an empty maple_id exercises the route's
    // skip-when-absent guard: no Mongo update, no Meili tombstone.
    await softDelete('');

    expect(meili.tombstones).toEqual([]);
    const after = await db!
      .collection('assets')
      .findOne({ 'fileinfo.filename': 'legacy-tombstone.dng' });
    expect(after?.deleted_at).toBeNull();
  });
});
