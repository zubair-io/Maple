/**
 * The claim's gates, ported case for case from the Mongo `buildClaimQuery`
 * suite (`workers/run-stage.test.ts`, `run-stage.claim-filter.test.ts`,
 * `run-stage.missing-tag.test.ts`).
 *
 * Those tests assert the *shape* of a Mongo filter object, because that was
 * the only thing there was to assert without a database. These assert which
 * assets actually come back, which is the question the filter was a proxy for
 * — a per-test SQLite database costs single-digit milliseconds, so the proxy
 * is no longer worth keeping.
 */

import { describe, expect, test } from 'bun:test';
import { claimStageBatch } from './stage-claim.ts';
import { insertStageState, testSqliteDb } from './assets.test-helpers.ts';
import { seedClaimableAsset, seedClaimableAssets, stageRow } from './stage-runtime.test-helpers.ts';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';

const STAGE = 'thumb';

/** The request every test starts from: target version 2, no dependencies. */
function request(overrides: Partial<Parameters<typeof claimStageBatch>[0]> = {}) {
  return {
    stage: STAGE,
    targetVersion: 2,
    dependsOn: [],
    limit: 50,
    maxAttempts: 3,
    ...overrides,
  };
}

const ids = (outcome: { claimed: Array<{ asset_id: string }> }): string[] =>
  outcome.claimed.map((row) => row.asset_id).sort();

describe('claimStageBatch — which assets are claimable', () => {
  test('claims rows below the target version and skips rows at or above it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const behind = seedClaimableAsset(handle.db, { stages: { [STAGE]: { version: 1 } } });
    const done = seedClaimableAsset(handle.db, { stages: { [STAGE]: { version: 2 } } });
    const ahead = seedClaimableAsset(handle.db, { stages: { [STAGE]: { version: 9 } } });

    const outcome = await claimStageBatch(request(), db);

    expect(ids(outcome)).toEqual([behind]);
    expect(ids(outcome)).not.toContain(done);
    expect(ids(outcome)).not.toContain(ahead);
  });

  test('skips dead-lettered rows', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAsset(handle.db, { stages: { [STAGE]: { dead: true } } });
    const live = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });

    expect(ids(await claimStageBatch(request(), db))).toEqual([live]);
  });

  test('a row with no stage_state row at all is not claimable', async () => {
    // The consequence of dense seeding, and the reason it exists. On Mongo a
    // missing subdocument IS claimable; here the row has to be there, so an
    // asset created without one is invisible to its stage until
    // `registerStage` backfills it.
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAsset(handle.db);

    expect((await claimStageBatch(request(), db)).claimed).toEqual([]);
  });

  test('parks an asset with no live location, for every stage', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAsset(handle.db, { missing: true, stages: { [STAGE]: {} } });
    const live = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });

    expect(ids(await claimStageBatch(request(), db))).toEqual([live]);
  });

  test('parks a soft-deleted asset', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAsset(handle.db, {
      deletedAt: '2026-01-01T00:00:00.000Z',
      stages: { [STAGE]: {} },
    });
    const live = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });

    expect(ids(await claimStageBatch(request(), db))).toEqual([live]);
  });

  test('parks an asset tagged damaged', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const damaged = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });
    handle.db.run(`UPDATE assets SET damaged_since = ? WHERE id = ?`, [
      '2026-01-01T00:00:00.000Z',
      damaged,
    ]);
    const live = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });

    expect(ids(await claimStageBatch(request(), db))).toEqual([live]);
  });
});

describe('claimStageBatch — the retry gate', () => {
  test('a future next_attempt_at parks the row; an elapsed one does not', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const now = new Date('2026-06-01T12:00:00.000Z');
    const parked = seedClaimableAsset(handle.db, {
      stages: { [STAGE]: { nextAttemptAt: '2026-06-01T12:30:00.000Z' } },
    });
    const elapsed = seedClaimableAsset(handle.db, {
      stages: { [STAGE]: { nextAttemptAt: '2026-06-01T11:30:00.000Z' } },
    });
    const never = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });

    const outcome = await claimStageBatch(request({ now }), db);

    // `IS NULL OR <= now` is the SQLite spelling of the Mongo gate's
    // `$not: { $gt: now }`, and it matters for the same reason: a row that
    // has never failed must stay claimable without a migration.
    expect(ids(outcome).sort()).toEqual([elapsed, never].sort());
    expect(ids(outcome)).not.toContain(parked);
  });
});

describe('claimStageBatch — dependencies', () => {
  test('a bare dependency requires the upstream stage to have reached version 1', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const ready = seedClaimableAsset(handle.db, {
      stages: { [STAGE]: {}, preview: { version: 1 } },
    });
    seedClaimableAsset(handle.db, { stages: { [STAGE]: {}, preview: { version: 0 } } });

    const outcome = await claimStageBatch(
      request({ dependsOn: [{ name: 'preview', minVersion: 1 }] }),
      db,
    );

    expect(ids(outcome)).toEqual([ready]);
  });

  test('honours a minVersion above 1', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAsset(handle.db, { stages: { [STAGE]: {}, preview: { version: 1 } } });
    const ready = seedClaimableAsset(handle.db, {
      stages: { [STAGE]: {}, preview: { version: 2 } },
    });

    const outcome = await claimStageBatch(
      request({ dependsOn: [{ name: 'preview', minVersion: 2 }] }),
      db,
    );

    expect(ids(outcome)).toEqual([ready]);
  });

  test('requires every dependency, not just one', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAsset(handle.db, {
      stages: { [STAGE]: {}, exif: { version: 1 }, preview: { version: 0 } },
    });
    const ready = seedClaimableAsset(handle.db, {
      stages: { [STAGE]: {}, exif: { version: 1 }, preview: { version: 1 } },
    });

    const outcome = await claimStageBatch(
      request({
        dependsOn: [
          { name: 'exif', minVersion: 1 },
          { name: 'preview', minVersion: 1 },
        ],
      }),
      db,
    );

    expect(ids(outcome)).toEqual([ready]);
  });
});

describe('claimStageBatch — in-flight, residual and limit', () => {
  test('excludes assets this process is already running', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const [a, b] = seedClaimableAssets(handle.db, STAGE, 2) as [string, string];

    const outcome = await claimStageBatch(request({ inFlight: new Set([a]) }), db);

    expect(ids(outcome)).toEqual([b]);
  });

  test('AND-s a stage residual onto the gates rather than replacing them', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAsset(handle.db, { mediaKind: 'image', stages: { [STAGE]: {} } });
    const video = seedClaimableAsset(handle.db, { mediaKind: 'video', stages: { [STAGE]: {} } });
    // A dead row that also matches the residual: it must still be excluded,
    // which is what "AND-ed on" rather than "merged" buys.
    seedClaimableAsset(handle.db, {
      mediaKind: 'video',
      stages: { [STAGE]: { dead: true } },
    });

    const outcome = await claimStageBatch(
      request({
        residual: {
          sql: `EXISTS (SELECT 1 FROM assets WHERE id = stage_state.asset_id AND media_kind IN (?, ?))`,
          params: ['video', 'audio'],
        },
      }),
      db,
    );

    expect(ids(outcome)).toEqual([video]);
  });

  test('never returns more than the limit', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAssets(handle.db, STAGE, 21);

    // `deriveBatchSize(4)` is 20; the 21st waits for the next tick, exactly as
    // the Mongo runner's `.limit(batchSize)` leaves it.
    expect((await claimStageBatch(request({ limit: 20 }), db)).claimed).toHaveLength(20);
  });
});

describe('claimStageBatch — what the claim writes', () => {
  test('spends the attempt before the handler can run, and stamps a lease', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });
    const now = new Date('2026-06-01T12:00:00.000Z');

    const outcome = await claimStageBatch(request({ now, leaseMs: 60_000 }), db);

    // Persisting the attempt at claim time is what makes an uncatchable native
    // death count against the budget (#897) — nothing in the catch path can
    // record an attempt the process never returned from.
    const row = stageRow(handle.db, assetId, STAGE);
    expect(row?.attempts).toBe(1);
    expect(row?.next_attempt_at).toBe('2026-06-01T12:01:00.000Z');
    // The returned row reports the same state, so the caller knows the attempt
    // number it is about to make without reading back.
    expect(outcome.claimed[0]?.attempts).toBe(1);
  });

  test('a claimed row is not claimable again until its lease elapses', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAssets(handle.db, STAGE, 1);
    const first = new Date('2026-06-01T12:00:00.000Z');

    const claimed = await claimStageBatch(request({ now: first, leaseMs: 60_000 }), db);
    const duringLease = await claimStageBatch(
      request({ now: new Date('2026-06-01T12:00:30.000Z'), leaseMs: 60_000 }),
      db,
    );
    const afterLease = await claimStageBatch(
      request({ now: new Date('2026-06-01T12:02:00.000Z'), leaseMs: 60_000 }),
      db,
    );

    expect(claimed.claimed).toHaveLength(1);
    expect(duringLease.claimed).toHaveLength(0);
    // Reclaimable afterwards, which is how a process that died holding the
    // claim releases it without anything having to notice the death.
    expect(afterLease.claimed).toHaveLength(1);
  });
});

describe('claimStageBatch — crash-exhausted reconciliation', () => {
  test('parks a row whose budget was spent without it ever completing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const poisoned = seedClaimableAsset(handle.db, {
      stages: { [STAGE]: { version: 0, attempts: 3 } },
    });

    const outcome = await claimStageBatch(request({ maxAttempts: 3 }), db);

    // A normal throw dead-letters in the runner's catch, so a row below target,
    // not dead and already at maxAttempts can only have got there by the
    // process dying mid-handler (#897).
    expect(outcome.crashExhausted.map((row) => row.assetId)).toEqual([poisoned]);
    expect(outcome.claimed).toEqual([]);
    const row = stageRow(handle.db, poisoned, STAGE);
    expect(row?.dead).toBe(1);
    expect(row?.last_error).toContain('worker aborted mid-handler');
    // NOT re-dispatched: one poison asset must not re-claim on every respawn.
    expect(row?.attempts).toBe(3);
  });

  test('leaves rows below the ceiling alone and claims them normally', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db, { stages: { [STAGE]: { attempts: 2 } } });

    const outcome = await claimStageBatch(request({ maxAttempts: 3 }), db);

    expect(outcome.crashExhausted).toEqual([]);
    expect(ids(outcome)).toEqual([assetId]);
    expect(stageRow(handle.db, assetId, STAGE)?.attempts).toBe(3);
  });

  test('does not reconcile a row that is still inside its lease', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db, { stages: { [STAGE]: {} } });
    insertStageState(handle.db, assetId, 'other', {});
    handle.db.run(
      `UPDATE stage_state SET attempts = 3, next_attempt_at = ? WHERE asset_id = ? AND stage = ?`,
      ['2026-06-01T12:30:00.000Z', assetId, STAGE],
    );

    const outcome = await claimStageBatch(
      request({ maxAttempts: 3, now: new Date('2026-06-01T12:00:00.000Z') }),
      db,
    );

    // The handler may simply still be running. "Crashed" and "slow" are only
    // distinguishable once the lease has elapsed, so the sweep waits for it.
    expect(outcome.crashExhausted).toEqual([]);
    expect(stageRow(handle.db, assetId, STAGE)?.dead).toBe(0);
  });
});
