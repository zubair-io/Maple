/**
 * Tests the dead-letter redrive pass in `meilisearch-backfill-redrive.ts`.
 * `meilisearch-backfill.ts` records a row to `meilisearch_backfill_failures`
 * when it can't be composed or written, then advances its cursor past it —
 * these tests cover the other half: re-attempting those rows so a transient
 * failure doesn't silently drop an asset from the search index forever.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  setMeilisearchClientForTests,
  type MeilisearchAssetDoc,
  type MeilisearchClient,
} from '../src/enrichment/meilisearch-client.ts';
import { createLiveTestDatabase } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import {
  BROKEN_PLACE,
  failuresByMapleId,
  repairPlace,
  seedFailure,
  seedIndexableAsset,
} from './helpers/meili-backfill-fixtures.ts';
import {
  countMeilisearchBackfillFailures,
  redriveMeilisearchBackfillFailures,
} from '../src/enrichment/meilisearch-backfill-redrive.ts';
import { runMeilisearchBackfill } from '../src/enrichment/meilisearch-backfill.ts';
import { newObjectIdHex } from '../src/db/sqlite/object-id.ts';

afterEach(() => {
  setMeilisearchClientForTests(null);
});

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
    using live = await createLiveTestDatabase();
    // The stored place blob is a number, not a string — composeSearchBlob's
    // `raw.toLowerCase()` throws a TypeError, the same shape of failure the
    // main pass would hit from a genuinely transient bad-data condition.
    const assetId = seedIndexableAsset(live.db, {
      mapleId: 'broken',
      placeSearchBlob: BROKEN_PLACE,
    });
    seedFailure(live.db, { assetId, mapleId: 'broken' });
    const meili = client();
    setMeilisearchClientForTests(meili.fake);

    const first = await redriveMeilisearchBackfillFailures(meili.fake, 10);
    expect(first).toEqual({ retried: 1, recovered: 0, stillFailing: 1 });
    expect(failuresByMapleId(live.db).get('broken')).toEqual({ attempts: 2 });
    expect(meili.upserts).toHaveLength(0);

    // Fix the malformed field, as a later write to the row would.
    repairPlace(live.db, assetId);

    const second = await redriveMeilisearchBackfillFailures(meili.fake, 10);
    expect(second).toEqual({ retried: 1, recovered: 1, stillFailing: 0 });
    expect(meili.upserts.map((doc) => doc.id)).toEqual(['broken']);
    expect(failuresByMapleId(live.db).has('broken')).toBe(false);
  });

  it('drops a dead letter whose asset was hard-deleted since the failure was recorded', async () => {
    using live = await createLiveTestDatabase();
    // The table cascades on the asset, so a hard delete takes the dead letter
    // with it. What the redrive has to handle is the row it reads back with no
    // asset behind it — here, an asset that never got a `maple_id`.
    const assetId = seedIndexableAsset(live.db, { mapleId: null });
    seedFailure(live.db, { assetId, mapleId: 'gone' });
    const meili = client();
    setMeilisearchClientForTests(meili.fake);

    const outcome = await redriveMeilisearchBackfillFailures(meili.fake, 10);
    expect(outcome).toEqual({ retried: 1, recovered: 1, stillFailing: 0 });
    expect(failuresByMapleId(live.db).has('gone')).toBe(false);
  });

  it('tombstones and clears a dead letter whose asset has since been soft-deleted', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedIndexableAsset(live.db, {
      mapleId: 'tombstoned',
      deletedAt: new Date().toISOString(),
    });
    seedFailure(live.db, { assetId, mapleId: 'tombstoned' });
    const meili = client();
    setMeilisearchClientForTests(meili.fake);

    const outcome = await redriveMeilisearchBackfillFailures(meili.fake, 10);
    expect(outcome).toEqual({ retried: 1, recovered: 1, stillFailing: 0 });
    expect(meili.tombstones).toEqual(['tombstoned']);
    expect(failuresByMapleId(live.db).has('tombstoned')).toBe(false);
  });

  it('is a bounded, safe no-op when Meilisearch is unreachable', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedIndexableAsset(live.db, { mapleId: 'unreachable' });
    seedFailure(live.db, { assetId, mapleId: 'unreachable' });
    const meili = client();
    meili.fake.upsertBatchOrThrow = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    setMeilisearchClientForTests(meili.fake);

    const outcome = await redriveMeilisearchBackfillFailures(meili.fake, 10);
    expect(outcome).toEqual({ retried: 0, recovered: 0, stillFailing: 0 });
    // The failure is untouched (still attempts: 1) — a transient outage
    // during the redrive pass itself must not corrupt the dead letter it
    // couldn't even attempt.
    expect(failuresByMapleId(live.db).get('unreachable')).toEqual({ attempts: 1 });
  });

  it('runs at the end of a completed backfill run and clears the live failure count', async () => {
    using live = await createLiveTestDatabase();
    // 'broken' fails to compose on the main pass; fixing it before the run's
    // final, redrive-triggering batch proves the redrive pass — not the main
    // pass — is what recovers it. The ids fix the cursor order so 'broken' is
    // the batch the run starts with.
    const brokenId = seedIndexableAsset(live.db, {
      id: '1'.repeat(24),
      mapleId: 'broken',
      placeSearchBlob: BROKEN_PLACE,
    });
    seedIndexableAsset(live.db, { id: '2'.repeat(24), mapleId: 'valid' });
    const meili = client();
    setMeilisearchClientForTests(meili.fake);

    const firstBatch = await runMeilisearchBackfill(1, false);
    expect(firstBatch.complete).toBe(false);
    expect(await countMeilisearchBackfillFailures()).toBe(1);
    expect(meili.upserts).toHaveLength(0);

    repairPlace(live.db, brokenId);

    const secondBatch = await runMeilisearchBackfill(1, false);
    expect(secondBatch.complete).toBe(true);
    expect(meili.upserts.map((doc) => doc.id).sort()).toEqual(['broken', 'valid']);
    expect(await countMeilisearchBackfillFailures()).toBe(0);
  });

  it('drains a backlog larger than batchSize across passes, leaving only the permanent failures', async () => {
    using live = await createLiveTestDatabase();
    const batchSize = 3;
    const recoverableIds = ['r1', 'r2', 'r3', 'r4'];
    const permanentIds = ['p1', 'p2', 'p3'];
    // Interleaved insertion (and `updated_at`) order so no single
    // batchSize-sized page can be entirely permanent failures while a
    // recoverable row still waits behind it — the same interleaving a real
    // cursor pass would produce, since it dead-letters rows in cursor order
    // regardless of which ones happen to be permanently broken.
    const order = ['r1', 'p1', 'r2', 'p2', 'r3', 'p3', 'r4'];

    for (const [index, mapleId] of order.entries()) {
      const isPermanent = permanentIds.includes(mapleId);
      // A numeric place blob reproduces the same TypeError every attempt (see
      // the first test above) — a stand-in for a row that's permanently
      // unfixable, as opposed to one dead-lettered by a transient failure.
      const assetId = seedIndexableAsset(live.db, {
        id: newObjectIdHex(),
        mapleId,
        placeSearchBlob: isPermanent ? BROKEN_PLACE : undefined,
      });
      seedFailure(live.db, {
        assetId,
        mapleId,
        updatedAt: new Date(index).toISOString(),
      });
    }

    const meili = client();
    setMeilisearchClientForTests(meili.fake);

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

    const remaining = failuresByMapleId(live.db);
    expect([...remaining.keys()].sort()).toEqual([...permanentIds].sort());
    // Each permanent row started at attempts: 1 (the initial dead-letter) and
    // must have been re-attempted at least once by the drain loop — and the
    // loop terminated (this assertion runs at all) instead of spinning on
    // them forever.
    for (const entry of remaining.values()) expect(entry.attempts).toBeGreaterThan(1);
  });
});
