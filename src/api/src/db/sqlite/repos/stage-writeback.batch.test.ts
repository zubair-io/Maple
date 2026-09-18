/**
 * What a tick's writeback costs when it works, and what it costs when one
 * result in it does not.
 *
 * The second half is the one worth having. Folding twenty assets into one
 * transaction is the whole point of the buffer, and it silently borrows a
 * failure mode from doing so: on Mongo a rejected `updateOne` cost exactly the
 * asset it was for, and an all-or-nothing commit costs all twenty — including
 * the nineteen whose handlers succeeded, which then look to the runner exactly
 * like assets that were never processed.
 */

import { describe, expect, test } from 'bun:test';
import { StageWritebackBatch } from './stage-writeback.batch.ts';
import { stageResultStatements, type StageAttempt } from './stage-writeback.ts';
import { testSqliteDb } from './assets.test-helpers.ts';
import { seedClaimableAsset, stageRow } from './stage-runtime.test-helpers.ts';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import type { SqlStatement } from '../protocol.ts';

const STAGE = 'describe';
const AT = new Date('2026-06-01T12:00:00.000Z');
const LEASE = '2026-06-01T12:15:00.000Z';

function attempt(assetId: string): StageAttempt {
  return {
    target: { assetId, stage: STAGE, targetVersion: 7, lease: LEASE },
    attemptNo: 1,
    maxAttempts: 3,
    dependsOn: [],
    at: AT,
  };
}

/** One claimable asset whose stage row already carries {@link LEASE}. */
function seedLeased(db: Parameters<typeof seedClaimableAsset>[0]): string {
  return seedClaimableAsset(db, { stages: { [STAGE]: { nextAttemptAt: LEASE } } });
}

describe('committing a tick', () => {
  test('puts a whole tick in one transaction', async () => {
    using handle = await createTestDatabase();
    const calls: number[] = [];
    const db = testSqliteDb(handle.db);
    const counting = {
      ...db,
      transaction: async (statements: Parameters<typeof db.transaction>[0]) => {
        calls.push(statements.length);
        return db.transaction(statements);
      },
    };
    const assets = Array.from({ length: 5 }, () => seedLeased(handle.db));
    const batch = new StageWritebackBatch(counting);

    for (const assetId of assets) {
      await batch.record(stageResultStatements(attempt(assetId), { wrote: true }), assetId);
    }
    const failed = await batch.flush();

    // Five results, one transaction, five statements. The Mongo runner issues
    // one `updateOne` per asset per event — five round trips and five
    // independent commits for the same work.
    expect(calls).toEqual([5]);
    expect(failed).toEqual([]);
    expect(assets.map((id) => stageRow(handle.db, id, STAGE)?.version)).toEqual([7, 7, 7, 7, 7]);
  });

  test('flushes early rather than letting one transaction grow without bound', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assets = Array.from({ length: 6 }, () => seedLeased(handle.db));
    const batch = new StageWritebackBatch(db, 2);

    for (const assetId of assets) {
      await batch.record(stageResultStatements(attempt(assetId), { wrote: true }), assetId);
    }
    await batch.flush();

    expect(batch.size).toBe(0);
    expect(assets.every((id) => stageRow(handle.db, id, STAGE)?.version === 7)).toBe(true);
  });

  test('never splits one result across two transactions', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const sizes: number[] = [];
    const counting = {
      ...db,
      transaction: async (statements: Parameters<typeof db.transaction>[0]) => {
        sizes.push(statements.length);
        return db.transaction(statements);
      },
    };
    const assetId = seedLeased(handle.db);
    // Three statements — a patch, an invalidation and the stage row — against a
    // threshold of two.
    const batch = new StageWritebackBatch(counting, 2);

    await batch.record(
      stageResultStatements(attempt(assetId), { patch: [], invalidates: ['meili'] }),
      assetId,
    );
    await batch.flush();

    // A patch and the re-arm it implies have to land together or not at all,
    // so the threshold decides where the NEXT result goes, never where one
    // result is cut.
    expect(sizes).toEqual([2]);
    expect(stageRow(handle.db, assetId, 'meili')?.version).toBe(0);
  });

  test('flushing an empty batch is free and does not write', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const batch = new StageWritebackBatch(db);

    expect(await batch.flush()).toEqual([]);
    expect(await batch.flush()).toEqual([]);
    expect(batch.size).toBe(0);
  });
});

describe('when one result in the tick cannot be committed', () => {
  /** A statement that no database will accept: the asset does not exist. */
  const badStatement: SqlStatement = {
    sql: `INSERT INTO asset_detail (asset_id, description) VALUES (?, ?)`,
    params: ['no-such-asset-id-000000', 'orphan'],
  };

  test('the other results still record what their handlers did', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const good = Array.from({ length: 4 }, () => seedLeased(handle.db));
    const poisoned = seedLeased(handle.db);
    const batch = new StageWritebackBatch(db);

    for (const assetId of good) {
      await batch.record(stageResultStatements(attempt(assetId), { wrote: true }), assetId);
    }
    await batch.record(
      stageResultStatements(attempt(poisoned), { patch: [badStatement] }),
      poisoned,
    );
    const failed = await batch.flush();

    // Without the per-result retry all five lose their bookkeeping: `attempts`
    // stays at the claim-time value, the lease expires, they are re-claimed and
    // re-run, and after `maxAttempts` laps they dead-letter as "worker aborted
    // mid-handler" having succeeded every single time.
    expect(good.map((id) => stageRow(handle.db, id, STAGE)?.version)).toEqual([7, 7, 7, 7]);
    expect(failed.map((entry) => entry.label)).toEqual([poisoned]);
    expect(stageRow(handle.db, poisoned, STAGE)?.version).toBe(0);
  });

  test('a failure is reported rather than thrown at whichever result triggered the flush', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const poisoned = seedLeased(handle.db);
    const batch = new StageWritebackBatch(db);

    await batch.record(
      stageResultStatements(attempt(poisoned), { patch: [badStatement] }),
      poisoned,
    );
    const failed = await batch.flush();

    // Throwing would surface the error to whichever asset's `record` happened
    // to fill the buffer, which is not the asset that failed — and would lose
    // every successful writeback queued behind it.
    expect(failed).toHaveLength(1);
    expect(failed[0]?.label).toBe(poisoned);
    expect(String((failed[0]?.error as Error | undefined)?.message)).toContain('FOREIGN KEY');
  });

  test('a dropped result is not re-queued into the next flush', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const poisoned = seedLeased(handle.db);
    const later = seedLeased(handle.db);
    const batch = new StageWritebackBatch(db);

    await batch.record(
      stageResultStatements(attempt(poisoned), { patch: [badStatement] }),
      poisoned,
    );
    await batch.flush();
    await batch.record(stageResultStatements(attempt(later), { wrote: true }), later);
    const second = await batch.flush();

    // A group kept forever would poison every later flush in the process. The
    // asset recovers the way Mongo's does: its lease expires and the stage
    // claims it again.
    expect(second).toEqual([]);
    expect(stageRow(handle.db, later, STAGE)?.version).toBe(7);
  });
});
