/**
 * Tests the dead-letter redrive pass in `meilisearch-backfill-redrive.ts`.
 * `meilisearch-backfill.ts` records a row to `meilisearch_backfill_failures`
 * when it can't be composed or written, then advances its cursor past it —
 * these tests cover the other half: re-attempting those rows so a transient
 * failure doesn't silently drop an asset from the search index forever.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  setMeilisearchClientForTests,
  type MeilisearchAssetDoc,
  type MeilisearchClient,
} from '../src/enrichment/meilisearch-client.ts';

const TEST_DB = `maple_test_meili_redrive_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
let mongo: MongoClient | null = null;
let db: Db | null = null;
const folder = new ObjectId();

beforeAll(async () => {
  mongo = new MongoClient(URI, { serverSelectionTimeoutMS: 1500 });
  try {
    await mongo.connect();
    db = mongo.db(TEST_DB);
    await db.dropDatabase();
  } catch {
    await mongo.close().catch(() => {});
    mongo = null;
    return;
  }
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!db) return;
  for (const collection of [
    'assets',
    'people',
    'meilisearch_backfill_state',
    'meilisearch_backfill_failures',
    'meilisearch_backfill_leases',
  ]) {
    await db.collection(collection).deleteMany({});
  }
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

function liveFile(filename: string) {
  return { library_id: folder, path: '', filename, deleted_at: null, missing_since: null };
}

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    maple_id: id,
    folder_id: folder,
    filename: `${id}.jpg`,
    fileinfo: [liveFile(`${id}.jpg`)],
    deleted_at: null,
    ...overrides,
  };
}

function failureDoc(assetId: ObjectId, mapleId: string, attempts = 1) {
  return {
    _id: assetId,
    maple_id: mapleId,
    error: 'boom',
    attempts,
    updated_at: new Date(0).toISOString(),
  };
}

function client() {
  const upserts: MeilisearchAssetDoc[] = [];
  const tombstones: string[] = [];
  const fake: MeilisearchClient = {
    isConfigured: () => true,
    semanticConfigured: () => true,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    upsertBatchOrThrow: async (docs) => {
      upserts.push(...docs);
    },
    tombstone: async (id) => {
      tombstones.push(id);
    },
    tombstoneBatchOrThrow: async (ids) => {
      tombstones.push(...ids);
    },
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
  return { fake, upserts, tombstones };
}

describe('meilisearch backfill dead-letter redrive', () => {
  it('retries a dead-lettered row and clears it once it composes successfully', async () => {
    if (!db) return;
    const assetId = new ObjectId();
    // `description` is a number, not a string — composeSearchBlob's
    // `raw.toLowerCase()` throws a TypeError, the same shape of failure the
    // main pass would hit from a genuinely transient bad-data condition.
    await db
      .collection('assets')
      .insertOne({ _id: assetId, ...row('broken', { description: 42 }) });
    await db.collection('meilisearch_backfill_failures').insertOne(failureDoc(assetId, 'broken'));
    const meili = client();
    setMeilisearchClientForTests(meili.fake);
    const { redriveMeilisearchBackfillFailures } =
      await import('../src/enrichment/meilisearch-backfill-redrive.ts');

    const first = await redriveMeilisearchBackfillFailures(meili.fake, 10);
    expect(first).toEqual({ retried: 1, recovered: 0, stillFailing: 1 });
    expect(
      await db.collection('meilisearch_backfill_failures').findOne({ maple_id: 'broken' }),
    ).toMatchObject({ attempts: 2 });
    expect(meili.upserts).toHaveLength(0);

    // Fix the malformed field, as a later write to the row would.
    await db
      .collection('assets')
      .updateOne({ _id: assetId }, { $set: { description: 'a real caption' } });

    const second = await redriveMeilisearchBackfillFailures(meili.fake, 10);
    expect(second).toEqual({ retried: 1, recovered: 1, stillFailing: 0 });
    expect(meili.upserts.map((doc) => doc.id)).toEqual(['broken']);
    expect(
      await db.collection('meilisearch_backfill_failures').findOne({ maple_id: 'broken' }),
    ).toBeNull();
  });

  it('drops a dead letter whose asset was hard-deleted since the failure was recorded', async () => {
    if (!db) return;
    const goneId = new ObjectId();
    await db.collection('meilisearch_backfill_failures').insertOne(failureDoc(goneId, 'gone'));
    const meili = client();
    setMeilisearchClientForTests(meili.fake);
    const { redriveMeilisearchBackfillFailures } =
      await import('../src/enrichment/meilisearch-backfill-redrive.ts');

    const outcome = await redriveMeilisearchBackfillFailures(meili.fake, 10);
    expect(outcome).toEqual({ retried: 1, recovered: 1, stillFailing: 0 });
    expect(
      await db.collection('meilisearch_backfill_failures').findOne({ maple_id: 'gone' }),
    ).toBeNull();
  });

  it('tombstones and clears a dead letter whose asset has since been soft-deleted', async () => {
    if (!db) return;
    const assetId = new ObjectId();
    await db.collection('assets').insertOne({
      _id: assetId,
      ...row('tombstoned', { deleted_at: new Date().toISOString() }),
    });
    await db
      .collection('meilisearch_backfill_failures')
      .insertOne(failureDoc(assetId, 'tombstoned'));
    const meili = client();
    setMeilisearchClientForTests(meili.fake);
    const { redriveMeilisearchBackfillFailures } =
      await import('../src/enrichment/meilisearch-backfill-redrive.ts');

    const outcome = await redriveMeilisearchBackfillFailures(meili.fake, 10);
    expect(outcome).toEqual({ retried: 1, recovered: 1, stillFailing: 0 });
    expect(meili.tombstones).toEqual(['tombstoned']);
    expect(
      await db.collection('meilisearch_backfill_failures').findOne({ maple_id: 'tombstoned' }),
    ).toBeNull();
  });

  it('is a bounded, safe no-op when Meilisearch is unreachable', async () => {
    if (!db) return;
    const assetId = new ObjectId();
    await db.collection('assets').insertOne({ _id: assetId, ...row('unreachable') });
    await db
      .collection('meilisearch_backfill_failures')
      .insertOne(failureDoc(assetId, 'unreachable'));
    const meili = client();
    meili.fake.upsertBatchOrThrow = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    setMeilisearchClientForTests(meili.fake);
    const { redriveMeilisearchBackfillFailures } =
      await import('../src/enrichment/meilisearch-backfill-redrive.ts');

    const outcome = await redriveMeilisearchBackfillFailures(meili.fake, 10);
    expect(outcome).toEqual({ retried: 0, recovered: 0, stillFailing: 0 });
    // The failure is untouched (still attempts: 1) — a transient outage
    // during the redrive pass itself must not corrupt the dead letter it
    // couldn't even attempt.
    expect(
      await db.collection('meilisearch_backfill_failures').findOne({ maple_id: 'unreachable' }),
    ).toMatchObject({ attempts: 1 });
  });

  it('runs at the end of a completed backfill run and clears the live failure count', async () => {
    if (!db) return;
    // 'broken' fails to compose on the main pass; fixing it before the run's
    // final, redrive-triggering batch proves the redrive pass — not the main
    // pass — is what recovers it.
    const brokenId = new ObjectId();
    await db
      .collection('assets')
      .insertMany([{ _id: brokenId, ...row('broken', { description: 42 }) }, row('valid')]);
    const meili = client();
    setMeilisearchClientForTests(meili.fake);
    const { runMeilisearchBackfill } = await import('../src/enrichment/meilisearch-backfill.ts');
    const { countMeilisearchBackfillFailures } =
      await import('../src/enrichment/meilisearch-backfill-redrive.ts');

    const firstBatch = await runMeilisearchBackfill(1, false);
    expect(firstBatch.complete).toBe(false);
    expect(await countMeilisearchBackfillFailures()).toBe(1);
    expect(meili.upserts).toHaveLength(0);

    await db.collection('assets').updateOne({ _id: brokenId }, { $set: { description: 'fixed' } });

    const secondBatch = await runMeilisearchBackfill(1, false);
    expect(secondBatch.complete).toBe(true);
    expect(meili.upserts.map((doc) => doc.id).sort()).toEqual(['broken', 'valid']);
    expect(await countMeilisearchBackfillFailures()).toBe(0);
  });

  it('drains a backlog larger than batchSize across passes, leaving only the permanent failures', async () => {
    if (!db) return;
    const batchSize = 3;
    const recoverableIds = ['r1', 'r2', 'r3', 'r4'];
    const permanentIds = ['p1', 'p2', 'p3'];
    // Interleaved insertion (and `updated_at`) order so no single
    // batchSize-sized page can be entirely permanent failures while a
    // recoverable row still waits behind it — the same interleaving a real
    // cursor pass would produce, since it dead-letters rows in cursor order
    // regardless of which ones happen to be permanently broken.
    const order = ['r1', 'p1', 'r2', 'p2', 'r3', 'p3', 'r4'];

    for (const [index, id] of order.entries()) {
      const assetId = new ObjectId();
      const isPermanent = permanentIds.includes(id);
      // `description: 42` reproduces the same TypeError every attempt (see
      // the first test above) — a stand-in for a row that's permanently
      // unfixable, as opposed to one dead-lettered by a transient failure.
      await db
        .collection('assets')
        .insertOne({ _id: assetId, ...row(id, isPermanent ? { description: 42 } : {}) });
      await db.collection('meilisearch_backfill_failures').insertOne({
        ...failureDoc(assetId, id),
        updated_at: new Date(index).toISOString(),
      });
    }

    const meili = client();
    setMeilisearchClientForTests(meili.fake);
    const { redriveMeilisearchBackfillFailures, countMeilisearchBackfillFailures } =
      await import('../src/enrichment/meilisearch-backfill-redrive.ts');

    const outcome = await redriveMeilisearchBackfillFailures(meili.fake, batchSize);

    // All 4 recoverable rows drain in this one run, even though the backlog
    // (7) is more than double the batch size (3) — proof the loop keeps
    // paging past the first `batchSize` rows instead of stopping there.
    expect(outcome.recovered).toBe(recoverableIds.length);
    expect(outcome.stillFailing).toBe(permanentIds.length);
    // More rows were retried than exist, since every permanent row gets
    // re-picked-up on a later page after failing once — the loop keeps
    // going as long as some page still makes progress.
    expect(outcome.retried).toBeGreaterThan(recoverableIds.length + permanentIds.length);
    expect(await countMeilisearchBackfillFailures()).toBe(permanentIds.length);
    expect(meili.upserts.map((doc) => doc.id).sort()).toEqual([...recoverableIds].sort());

    const remaining = await db
      .collection('meilisearch_backfill_failures')
      .find({})
      .sort({ maple_id: 1 })
      .toArray();
    expect(remaining.map((doc) => doc.maple_id)).toEqual([...permanentIds].sort());
    // Each permanent row started at attempts: 1 (the initial dead-letter) and
    // must have been re-attempted at least once by the drain loop — and the
    // loop terminated (this assertion runs at all) instead of spinning on
    // them forever.
    for (const doc of remaining) expect(doc.attempts).toBeGreaterThan(1);
  });
});
