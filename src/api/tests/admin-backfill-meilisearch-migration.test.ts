/**
 * Migration-adapter surface of the Meilisearch backfill (durable progress,
 * reset, dead-letter backlog count). Split from
 * `admin-backfill-meilisearch.test.ts` for the file-size budget — these tests
 * drive `backfillMeilisearchVectors` directly and never touch the HTTP route,
 * so the route/auth boilerplate stays behind.
 *
 * The adapter reaches `sqliteDb()` with no override, so each test installs a
 * private database for its block (#3787) and reads the stored resume point
 * back through `readBackfillState` rather than by querying the table.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
  type MeilisearchAssetDoc,
} from '../src/enrichment/meilisearch-client.ts';
import { createLiveTestDatabase, insertFolder } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { readBackfillState } from '../src/db/repos/meilisearch-backfill.repo.ts';
import { BROKEN_PLACE, seedIndexableAsset } from './helpers/meili-backfill-fixtures.ts';
import { backfillMeilisearchVectors } from '../src/workers/migration/backfill-meilisearch-vectors.ts';
import { resetMigrationState } from '../src/workers/migration-config.repo.ts';
import { BACKFILL_MEILISEARCH_VECTORS_ID } from '../src/workers/migration/ids.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

afterEach(() => {
  setMeilisearchClientForTests(null);
});

interface CapturedMeili {
  client: MeilisearchClient;
  upserts: MeilisearchAssetDoc[];
  tombstones: string[];
  ensureCalls: number;
  configured: boolean;
  failBatch: boolean;
}

function makeCapturingMeili(configured = true): CapturedMeili {
  const upserts: MeilisearchAssetDoc[] = [];
  const tombstones: string[] = [];
  const c: CapturedMeili = {
    upserts,
    tombstones,
    ensureCalls: 0,
    configured,
    failBatch: false,
    client: {
      isConfigured: () => c.configured,
      semanticConfigured: () => c.configured,
      health: async () => c.configured,
      ensureIndex: async () => {
        c.ensureCalls += 1;
      },
      upsert: async (doc) => {
        upserts.push(doc);
      },
      upsertOrThrow: async (doc) => {
        upserts.push(doc);
      },
      upsertBatchOrThrow: async (docs) => {
        if (c.failBatch) throw new Error('temporary batch failure');
        upserts.push(...docs);
      },
      tombstoneBatchOrThrow: async (ids) => {
        if (c.failBatch) throw new Error('temporary batch failure');
        tombstones.push(...ids);
      },
      tombstone: async (id) => {
        tombstones.push(id);
      },
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    },
  };
  return c;
}

describe('Meilisearch backfill migration adapter', () => {
  it('exposes durable progress and reset through the migration adapter', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/library' });
    for (const mapleId of ['migration-a', 'migration-b', 'migration-c']) {
      seedIndexableAsset(live.db, { mapleId, placeSearchBlob: 'heat pump' });
    }
    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);
    expect(backfillMeilisearchVectors.preferredBatchSize).toBe(50);

    expect(await backfillMeilisearchVectors.countRemaining()).toBe(3);
    expect(await backfillMeilisearchVectors.runBatch(2)).toEqual({
      processed: 2,
      errors: 0,
      complete: false,
    });
    expect(await backfillMeilisearchVectors.countRemaining()).toBe(1);

    // An exact-size final batch is marked complete without requiring a
    // trailing empty request from the migration worker.
    expect(await backfillMeilisearchVectors.runBatch(1)).toEqual({
      processed: 1,
      errors: 0,
      complete: true,
    });
    expect(await backfillMeilisearchVectors.countRemaining()).toBe(0);
    const state = await readBackfillState();
    expect(state?.completed_at).not.toBeNull();

    // A confirming poll after completion is idempotent. Only an explicit
    // reset may restart the library-wide sweep.
    const upsertCount = meili.upserts.length;
    expect(await backfillMeilisearchVectors.runBatch(1)).toEqual({
      processed: 0,
      errors: 0,
      complete: true,
    });
    expect(meili.upserts).toHaveLength(upsertCount);
    expect(await readBackfillState()).toEqual(state);

    await resetMigrationState(BACKFILL_MEILISEARCH_VECTORS_ID);
    expect(await backfillMeilisearchVectors.countRemaining()).toBe(3);
  });

  it('surfaces the live dead-letter backlog through the migration adapter', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/library' });
    seedIndexableAsset(live.db, { mapleId: 'status-broken', placeSearchBlob: BROKEN_PLACE });
    setMeilisearchClientForTests(makeCapturingMeili().client);

    // A migration without a dead-letter queue omits the field entirely; this
    // one always implements it.
    expect(backfillMeilisearchVectors.countFailedPermanently).toBeDefined();
    expect(await backfillMeilisearchVectors.countFailedPermanently!()).toBe(0);

    // The row's place blob never becomes composable, so both the initial
    // compose failure and the same-run redrive re-attempt fail — the row stays
    // dead-lettered and the live count reflects it.
    await backfillMeilisearchVectors.runBatch(10);
    expect(await backfillMeilisearchVectors.countFailedPermanently!()).toBe(1);
  });
});
