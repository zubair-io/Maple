/**
 * How the vector backfill behaves when writes go wrong: one poisonous document
 * is isolated rather than blocking its siblings, a transport outage exhausts a
 * bounded retry budget without losing the cursor, and two callers cannot run at
 * once.
 *
 * The status route's own surface — coverage reporting, the owner gate and the
 * response cache — moved to `admin-meilisearch-status.test.ts` when this file
 * went to SQLite, so a suite named for the backfill drives the backfill.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  setMeilisearchClientForTests,
  type MeilisearchAssetDoc,
  type MeilisearchClient,
} from '../src/enrichment/meilisearch-client.ts';
import { MeilisearchTaskError } from '../src/enrichment/meilisearch-transport.ts';
import { createLiveTestDatabase } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { readBackfillState } from '../src/db/sqlite/repos/meilisearch-backfill.repo.ts';
import { failuresByMapleId, seedIndexableAsset } from './helpers/meili-backfill-fixtures.ts';
import {
  clearMeilisearchBackfillRetryState,
  runMeilisearchBackfill,
} from '../src/enrichment/meilisearch-backfill.ts';
import {
  MeilisearchBackfillBusyError,
  withMeilisearchBackfillLease,
} from '../src/enrichment/meilisearch-backfill-lease.ts';

afterEach(() => {
  setMeilisearchClientForTests(null);
});

function client(options: { reject?: string; transient?: boolean } = {}) {
  const upserts: MeilisearchAssetDoc[] = [];
  const fake: MeilisearchClient = {
    isConfigured: () => true,
    semanticConfigured: () => true,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    upsertBatchOrThrow: async (docs) => {
      if (options.transient) throw new Error('temporary batch failure');
      if (options.reject && docs.some((doc) => doc.id === options.reject)) {
        throw new MeilisearchTaskError('invalid document', 'invalid_document_fields');
      }
      upserts.push(...docs);
    },
    tombstone: async () => {},
    tombstoneBatchOrThrow: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
  return { fake, upserts };
}

describe('semantic backfill resilience', () => {
  it('isolates and dead-letters one invalid document while committing siblings', async () => {
    using live = await createLiveTestDatabase();
    seedIndexableAsset(live.db, { id: '1'.repeat(24), mapleId: 'valid' });
    seedIndexableAsset(live.db, { id: '2'.repeat(24), mapleId: 'invalid' });
    const meili = client({ reject: 'invalid' });
    setMeilisearchClientForTests(meili.fake);

    expect(await runMeilisearchBackfill(10, false)).toMatchObject({
      complete: true,
      retryable: false,
      upserted: 1,
      errors: 1,
    });
    expect(meili.upserts.map((doc) => doc.id)).toEqual(['valid']);
    // Reaching `complete` in this same call also runs the end-of-run redrive
    // pass against the dead letter it just recorded. The mock client rejects
    // 'invalid' unconditionally, so the immediate re-attempt fails the same
    // way and `attempts` reflects both tries (see meilisearch-backfill-redrive.ts
    // for the pass that recovers a row once its underlying cause is fixed).
    expect(failuresByMapleId(live.db).get('invalid')).toEqual({ attempts: 2 });
  });

  it('blocks after five transient failures and can rearm without losing its cursor', async () => {
    using live = await createLiveTestDatabase();
    seedIndexableAsset(live.db, { mapleId: 'blocked' });
    setMeilisearchClientForTests(client({ transient: true }).fake);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await runMeilisearchBackfill(10, false);
      expect(result.blocked).toBe(attempt === 5);
      expect(result.nextCursor).toBeNull();
    }
    expect(await readBackfillState()).toMatchObject({ scanned: 0, retry_attempts: 5 });

    await clearMeilisearchBackfillRetryState();
    expect(await readBackfillState()).toMatchObject({
      scanned: 0,
      retry_attempts: 0,
      blocked_at: null,
    });
  });

  it('serializes admin, migration, and reset callers with a lease', async () => {
    using live = await createLiveTestDatabase();
    let release!: () => void;
    let acquired!: () => void;
    const blocker = new Promise<void>((resolve) => (release = resolve));
    const signal = new Promise<void>((resolve) => (acquired = resolve));
    const first = withMeilisearchBackfillLease(async () => {
      acquired();
      await blocker;
    });
    await signal;
    await expect(withMeilisearchBackfillLease(async () => {})).rejects.toBeInstanceOf(
      MeilisearchBackfillBusyError,
    );
    release();
    await first;
  });
});
