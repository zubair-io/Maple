/**
 * What each handler result records, ported from the Mongo runner's writeback
 * suites (`run-stage.poll-loop.test.ts`, `run-stage.invalidates.test.ts`,
 * `run-stage.rearm.test.ts`).
 *
 * The Mongo versions drive a whole `runOnce` against an in-memory collection
 * fake whose `$set` support is hand-rolled; these drive the statements against
 * a real database, so the `ON CONFLICT` branches and the `NOT NULL` columns
 * are exercised rather than approximated.
 */

import { describe, expect, test } from 'bun:test';
import {
  claimRollbackStatement,
  invalidationStatements,
  stageFailureStatements,
  stageResultStatements,
  stageSuccessStatements,
  tagLocationMissingStatement,
  type StageAttempt,
} from './stage-writeback.ts';
import { renewStageLease } from './stage-claim.ts';
import { damagedTag, seedClaimableAsset, stageRow } from './stage-runtime.test-helpers.ts';
import { createTestDatabase, testSqliteDb } from '../test-sqlite.test-helpers.ts';

const STAGE = 'describe';
const AT = new Date('2026-06-01T12:00:00.000Z');
/** The lease a claim would have stamped. Seeded rows carry the same value. */
const LEASE = '2026-06-01T12:15:00.000Z';

function attempt(assetId: string, overrides: Partial<StageAttempt> = {}): StageAttempt {
  return {
    target: { assetId, stage: STAGE, targetVersion: 7, lease: LEASE },
    attemptNo: 1,
    maxAttempts: 3,
    dependsOn: ['preview'],
    at: AT,
    ...overrides,
  };
}

/**
 * A claimable asset whose stage rows are already leased, so a writeback fenced
 * on {@link LEASE} matches. Every stage named gets the lease unless the case
 * sets its own `nextAttemptAt`.
 */
function seedLeased(
  db: Parameters<typeof seedClaimableAsset>[0],
  options: Parameters<typeof seedClaimableAsset>[1] = {},
): string {
  const stages = Object.fromEntries(
    Object.entries(options.stages ?? {}).map(([stage, state]) => [
      stage,
      { nextAttemptAt: LEASE, ...state },
    ]),
  );
  return seedClaimableAsset(db, { ...options, stages });
}

describe('a clean run', () => {
  test('`wrote` puts the stage at target and clears the whole failure trail', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    // A row that failed before and has now been re-claimed: the failure trail
    // is still on it, but `next_attempt_at` is this attempt's lease.
    const assetId = seedLeased(handle.db, {
      stages: {
        [STAGE]: {
          version: 3,
          attempts: 2,
          lastError: 'provider timed out',
          failedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    });

    await db.transaction(stageResultStatements(attempt(assetId), { wrote: true }));

    // The trail is cleared, not just overwritten: a stale error string is
    // indistinguishable from a live failure (#2730), and a leftover backoff
    // gate would hold this asset's NEXT version bump hostage (#2729).
    expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({
      version: 7,
      attempts: 0,
      last_error: null,
      dead: 0,
      failed_at: null,
      next_attempt_at: null,
      processed_at: AT.toISOString(),
    });
  });

  test('`skip` records the reason and still resets attempts, so it cannot dead-letter', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedLeased(handle.db, { stages: { [STAGE]: { attempts: 2 } } });

    await db.transaction(
      stageResultStatements(attempt(assetId), { skip: 'no-resolvable-location' }),
    );

    expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({
      version: 7,
      attempts: 0,
      last_error: 'skip: no-resolvable-location',
    });
  });

  test('`patch` lands the handler’s own writes in the same transaction', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedLeased(handle.db, { stages: { [STAGE]: {} } });

    await db.transaction(
      stageResultStatements(attempt(assetId), {
        patch: [
          {
            sql: `INSERT INTO asset_detail (asset_id, description) VALUES (?, ?)
                  ON CONFLICT (asset_id) DO UPDATE SET description = excluded.description`,
            params: [assetId, 'a cat on a boat'],
          },
        ],
      }),
    );

    const detail = handle.db
      .query(`SELECT description FROM asset_detail WHERE asset_id = ?`)
      .get(assetId) as { description: string } | null;
    expect(detail?.description).toBe('a cat on a boat');
    expect(stageRow(handle.db, assetId, STAGE)?.version).toBe(7);
  });

  test('a handler that tries to write its own bookkeeping is rejected', () => {
    expect(() =>
      stageSuccessStatements(
        { assetId: 'a', stage: STAGE, targetVersion: 7, lease: LEASE },
        { extra: [{ sql: 'UPDATE stage_state SET version = 99', params: [] }] },
      ),
    ).toThrow(/stage_state/);
  });
});

describe('invalidates', () => {
  test('resets the named downstream stage in the same write as the patch', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedLeased(handle.db, {
      stages: { [STAGE]: {}, meili: { version: 6, attempts: 1, dead: true } },
    });

    await db.transaction(
      stageResultStatements(attempt(assetId), {
        patch: [
          {
            sql: `INSERT INTO asset_detail (asset_id, description) VALUES (?, ?)
                  ON CONFLICT (asset_id) DO UPDATE SET description = excluded.description`,
            params: [assetId, 'a cat'],
          },
        ],
        invalidates: ['meili'],
      }),
    );

    // describe → meili is the canonical caller: the caption lands after the
    // search index was already built, so without this the recovered text never
    // becomes searchable (#2172).
    expect(stageRow(handle.db, assetId, 'meili')).toMatchObject({
      version: 0,
      attempts: 0,
      dead: 0,
      last_error: null,
      processed_at: null,
    });
    expect(stageRow(handle.db, assetId, STAGE)?.version).toBe(7);
  });

  test('creates the downstream row when it is missing rather than silently no-opping', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedLeased(handle.db, { stages: { [STAGE]: {} } });

    await db.transaction(
      stageResultStatements(attempt(assetId), { patch: [], invalidates: ['meili'] }),
    );

    // Rows are seeded at asset creation, so "the row exists" is the normal
    // case — and it is exactly the assumption that produced #2177, where a
    // stage silently never re-armed because its bookkeeping was absent.
    expect(stageRow(handle.db, assetId, 'meili')?.version).toBe(0);
  });

  test('never re-arms the writing stage itself', () => {
    expect(invalidationStatements(['meili', STAGE], STAGE, 'a')).toHaveLength(1);
  });

  test('rejects a name that was meant to be a field path', () => {
    // `invalidates: ['meili.version']` means the author thought they were
    // writing a Mongo `$set` path. Honouring it would create a stage_state row
    // for a stage no runner will ever claim.
    expect(() => invalidationStatements(['meili.version'], STAGE, 'a')).toThrow(
      /invalid stage name/,
    );
  });
});

describe('rearm', () => {
  test('resets the upstream stage and leaves this one below target, attempt kept', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedLeased(handle.db, {
      stages: { [STAGE]: { version: 0, attempts: 1 }, preview: { version: 4 } },
    });

    await db.transaction(
      stageResultStatements(attempt(assetId), {
        rearm: { stage: 'preview', reason: 'preview-missing' },
      }),
    );

    expect(stageRow(handle.db, assetId, 'preview')).toMatchObject({ version: 0, dead: 0 });
    expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({
      version: 0,
      attempts: 1,
      dead: 0,
      last_error: 'awaiting preview: preview-missing',
    });
  });

  test('stops re-arming once out of attempts', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedLeased(handle.db, {
      stages: { [STAGE]: { attempts: 2 }, preview: { version: 4 } },
    });

    await db.transaction(
      stageResultStatements(attempt(assetId, { attemptNo: 2, maxAttempts: 2 }), {
        rearm: { stage: 'preview', reason: 'preview-missing' },
      }),
    );

    // This stage can no longer claim the asset, so another regeneration round
    // is pure churn — a pair that never converges dead-letters here rather
    // than ping-ponging forever.
    expect(stageRow(handle.db, assetId, 'preview')?.version).toBe(4);
    expect(stageRow(handle.db, assetId, STAGE)?.dead).toBe(1);
  });

  test('rejects a rearm naming a stage this one does not depend on', () => {
    expect(() =>
      stageResultStatements(attempt('a', { dependsOn: [] }), {
        rearm: { stage: 'preview', reason: 'gone' },
      }),
    ).toThrow(/does not depend/);
  });
});

describe('damaged', () => {
  test('parks the stage after one attempt and tags the asset', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedLeased(handle.db, { stages: { [STAGE]: {} } });

    await db.transaction(
      stageResultStatements(attempt(assetId, { tagsDamagedOnDeadLetter: true }), {
        damaged: 'file is empty (0 bytes)',
      }),
    );

    // `attempts: 1` records that it was processed once and classified, not
    // retried to exhaustion; `version` stays put so clearing the tag
    // reprocesses the asset from here.
    expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({
      attempts: 1,
      dead: 1,
      version: 0,
      last_error: 'file is empty (0 bytes)',
    });
    expect(damagedTag(handle.db, assetId)).toMatchObject({
      damaged_stage: STAGE,
      damaged_reason: 'file is empty (0 bytes)',
      damaged_since: AT.toISOString(),
    });
  });

  test('a tagged asset is left alone by a second stage reaching the same conclusion', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedLeased(handle.db, { stages: { [STAGE]: {}, thumb: {} } });

    await db.transaction(
      stageResultStatements(attempt(assetId, { tagsDamagedOnDeadLetter: true }), {
        damaged: 'first detection',
      }),
    );
    await db.transaction(
      stageResultStatements(
        attempt(assetId, {
          tagsDamagedOnDeadLetter: true,
          target: { assetId, stage: 'thumb', targetVersion: 1, lease: LEASE },
        }),
        { damaged: 'second detection' },
      ),
    );

    // First detection wins — the operator is triaging from that timestamp.
    expect(damagedTag(handle.db, assetId)).toMatchObject({
      damaged_stage: STAGE,
      damaged_reason: 'first detection',
    });
  });

  test('rejects a damaged result from a stage without the opt-in', () => {
    expect(() => stageResultStatements(attempt('a'), { damaged: 'nope' })).toThrow(
      /not a damage-tagging stage/,
    );
  });
});

describe('the ENOENT park', () => {
  test('hands the claim back without spending an attempt, and tags the location', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedLeased(handle.db, { stages: { [STAGE]: { attempts: 1 } } });

    await db.transaction([
      claimRollbackStatement({ assetId, stage: STAGE, targetVersion: 7, lease: LEASE }),
      tagLocationMissingStatement(assetId, 0, `stage-enoent:${STAGE}`, AT),
    ]);

    // A missing original was never genuinely attempted: the asset is parked
    // for the reaper by the location tag, not by the stage's bookkeeping.
    expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({
      attempts: 0,
      version: 0,
      dead: 0,
      next_attempt_at: null,
    });
    const location = handle.db
      .query(`SELECT missing_since, missing_reason FROM asset_locations WHERE asset_id = ?`)
      .get(assetId) as { missing_since: string; missing_reason: string };
    expect(location.missing_since).toBe(AT.toISOString());
    expect(location.missing_reason).toBe(`stage-enoent:${STAGE}`);
    // Tagging the only live location drops the asset out of every claim.
    expect(
      handle.db.query(`SELECT live_location_count AS n FROM assets WHERE id = ?`).get(assetId),
    ).toMatchObject({ n: 0 });
  });

  test('a second detection does not move the timestamp the reaper counts from', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedLeased(handle.db, { stages: { [STAGE]: {} } });

    await db.write(...toArgs(tagLocationMissingStatement(assetId, 0, 'first', AT)));
    await db.write(
      ...toArgs(
        tagLocationMissingStatement(assetId, 0, 'second', new Date('2026-07-01T00:00:00.000Z')),
      ),
    );

    const location = handle.db
      .query(`SELECT missing_since, missing_reason FROM asset_locations WHERE asset_id = ?`)
      .get(assetId) as { missing_since: string; missing_reason: string };
    expect(location.missing_since).toBe(AT.toISOString());
    expect(location.missing_reason).toBe('first');
  });
});

describe('the lease fence', () => {
  test('a writeback from an attempt whose lease was taken over changes nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    // The row as a SECOND claimer left it: same asset, a different lease.
    const secondLease = '2026-06-01T12:40:00.000Z';
    const assetId = seedClaimableAsset(handle.db, {
      stages: { [STAGE]: { version: 3, attempts: 1, nextAttemptAt: secondLease } },
    });

    // The first claimer finishes late and writes back against ITS lease.
    await db.transaction(stageResultStatements(attempt(assetId), { wrote: true }));

    // Unfenced, this would have set version 7 and cleared `next_attempt_at`,
    // releasing a claim someone else is holding — so a third worker could take
    // an asset two handlers were already running.
    expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({
      version: 3,
      attempts: 1,
      next_attempt_at: secondLease,
    });
  });

  test('every terminal path is fenced, not just success', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const stale = { assetId: '', stage: STAGE, targetVersion: 7, lease: LEASE };
    const secondLease = '2026-06-01T12:40:00.000Z';
    const seed = (): string =>
      seedClaimableAsset(handle.db, {
        stages: { [STAGE]: { attempts: 1, nextAttemptAt: secondLease }, preview: { version: 4 } },
      });
    const failed = seed();
    const rearmed = seed();
    const damaged = seed();
    const rolledBack = seed();

    await db.transaction(
      stageFailureStatements({
        target: { ...stale, assetId: failed },
        attemptNo: 1,
        maxAttempts: 3,
        err: new Error('late'),
        retryDelayMs: () => 30_000,
        failedAt: AT,
      }).statements,
    );
    await db.transaction(
      stageResultStatements(attempt(rearmed), { rearm: { stage: 'preview', reason: 'gone' } }),
    );
    await db.transaction(
      stageResultStatements(attempt(damaged, { tagsDamagedOnDeadLetter: true }), {
        damaged: 'unreadable',
      }),
    );
    await db.transaction([claimRollbackStatement({ ...stale, assetId: rolledBack })]);

    // Not one of the four may touch the row: each of them writes
    // `next_attempt_at`, so each of them would release the live claim.
    for (const assetId of [failed, rearmed, damaged, rolledBack]) {
      expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({
        attempts: 1,
        dead: 0,
        next_attempt_at: secondLease,
      });
    }
  });

  test('a renewed lease is the one the writeback must carry', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedLeased(handle.db, { stages: { [STAGE]: { attempts: 1 } } });

    const renewed = await renewStageLease(
      { assetId, stage: STAGE, lease: LEASE },
      { now: new Date('2026-06-01T12:14:00.000Z'), leaseMs: 900_000 },
      db,
    );
    // Writing back with the ORIGINAL lease now fences out, because renewing
    // moved it — the runner has to carry the value forward.
    await db.transaction(stageResultStatements(attempt(assetId), { wrote: true }));
    const afterStale = stageRow(handle.db, assetId, STAGE);
    await db.transaction(
      stageResultStatements(
        attempt(assetId, {
          target: { assetId, stage: STAGE, targetVersion: 7, lease: renewed ?? '' },
        }),
        { wrote: true },
      ),
    );

    expect(renewed).toBe('2026-06-01T12:29:00.000Z');
    expect(afterStale?.version).toBe(0);
    expect(stageRow(handle.db, assetId, STAGE)?.version).toBe(7);
  });
});

/** `db.write` takes (sql, params); a statement carries them together. */
function toArgs(statement: { sql: string; params?: unknown }): [string, never] {
  return [statement.sql, statement.params as never];
}
