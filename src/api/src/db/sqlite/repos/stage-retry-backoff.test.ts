/**
 * Retry, backoff and dead-letter, ported from `run-stage.retry-backoff.test.ts`
 * and the failure half of `run-stage.poll-loop.test.ts` (#2728, #2729, #2730,
 * #897).
 *
 * These are the behaviours the ticket asks to prove unchanged, and they are
 * worth restating because each one was absent once and each absence was an
 * incident. A failed attempt used to be eligible again on the very next poll
 * tick, so with production's `describe.maxAttempts: 2` a one-second provider
 * blip permanently dead-lettered an asset and "Retry dead" walked into the same
 * wall. A dead-lettered asset used to be visible in the Workers UI and entirely
 * absent from the logs, which reads as "the error isn't real" during triage.
 * And a handler killed by a native `abort()` used to leave an asset that
 * re-claimed on every respawn forever.
 *
 * The ladder itself stays in `workers/loop-policy.ts`, which is pure and needs
 * no port — `retryDelayMs` is injected here exactly as the runner injects it,
 * so these tests cover the persistence of the decision rather than re-testing
 * the arithmetic `loop-policy.retry-backoff.test.ts` already covers.
 */

import { describe, expect, test } from 'bun:test';
import { claimStageBatch, type StageClaimRequest } from './stage-claim.ts';
import { stageFailureStatements, stageResultStatements } from './stage-writeback.ts';
import { damagedTag, seedClaimableAssets, stageRow } from './stage-runtime.test-helpers.ts';
import {
  createTestDatabase,
  testSqliteDb,
  type TestDatabase,
} from '../test-sqlite.test-helpers.ts';
import { retryDelayMs } from '../../../workers/loop-policy.ts';
import { tagDamagedStatement } from './stage-writeback.ts';

const STAGE = 'describe';
const TARGET_VERSION = 7;
/** A fixed draw, so the ±20% jitter does not make the assertions flaky. */
const noJitter = (attemptNo: number): number => retryDelayMs(attemptNo, () => 0.5);

function request(overrides: Partial<StageClaimRequest> = {}): StageClaimRequest {
  return {
    stage: STAGE,
    targetVersion: TARGET_VERSION,
    dependsOn: [],
    limit: 10,
    maxAttempts: 3,
    ...overrides,
  };
}

/**
 * One tick: claim, then record the outcome the fake handler produced. This is
 * the shape the runner takes after the cutover — claim, dispatch, write back —
 * with the handler and the document hydration stubbed out.
 */
async function tick(
  handle: TestDatabase,
  options: {
    now: Date;
    maxAttempts?: number;
    tagsDamagedOnDeadLetter?: boolean;
    /** Returns a result, or throws, exactly as a real handler would. */
    handler: () => unknown;
  },
): Promise<{ claimed: number; dead: boolean | null }> {
  const db = testSqliteDb(handle.db);
  const maxAttempts = options.maxAttempts ?? 3;
  const outcome = await claimStageBatch(request({ now: options.now, maxAttempts }), db);
  const results = [];
  for (const row of outcome.claimed) {
    // The lease the claim just stamped: every writeback below is fenced on it.
    const target = {
      assetId: row.asset_id,
      stage: STAGE,
      targetVersion: TARGET_VERSION,
      lease: row.next_attempt_at,
    };
    try {
      const value = options.handler();
      await db.transaction(
        stageResultStatements(
          {
            target,
            attemptNo: row.attempts,
            maxAttempts,
            dependsOn: [],
            tagsDamagedOnDeadLetter: options.tagsDamagedOnDeadLetter,
            at: options.now,
          },
          value as Parameters<typeof stageResultStatements>[1],
        ),
      );
      results.push(false);
    } catch (err) {
      const failure = stageFailureStatements({
        target,
        attemptNo: row.attempts,
        maxAttempts,
        err,
        retryDelayMs: noJitter,
        failedAt: options.now,
      });
      const damaged =
        failure.dead && options.tagsDamagedOnDeadLetter === true
          ? [tagDamagedStatement(row.asset_id, STAGE, failure.message, options.now)]
          : [];
      await db.transaction([...failure.statements, ...damaged]);
      results.push(failure.dead);
    }
  }
  return { claimed: outcome.claimed.length, dead: results[0] ?? null };
}

const throws = (message: string) => (): never => {
  throw new Error(message);
};

describe('a failed attempt is parked behind its retry gate', () => {
  test('the next tick claims nothing, and the tick after the ladder elapses claims it again', async () => {
    using handle = await createTestDatabase();
    const [assetId] = seedClaimableAssets(handle.db, STAGE, 1) as [string];
    const first = new Date('2026-06-01T12:00:00.000Z');

    const t1 = await tick(handle, { now: first, handler: throws('provider down') });
    const afterFailure = stageRow(handle.db, assetId, STAGE);
    const t2 = await tick(handle, {
      now: new Date(first.getTime() + 1_000),
      handler: throws('provider down'),
    });
    // The first rung is 30 s; step past it.
    const t3 = await tick(handle, {
      now: new Date(first.getTime() + 60_000),
      handler: throws('provider down'),
    });

    expect(t1.claimed).toBe(1);
    expect(afterFailure).toMatchObject({ attempts: 1, dead: 0, last_error: 'provider down' });
    expect(afterFailure?.next_attempt_at).toBe(
      new Date(first.getTime() + noJitter(1)).toISOString(),
    );
    // Without the gate, this second tick — a second later — would have burned
    // an attempt against the same broken provider.
    expect(t2.claimed).toBe(0);
    expect(t3.claimed).toBe(1);
    expect(stageRow(handle.db, assetId, STAGE)?.attempts).toBe(2);
  });

  test('records when the failure happened, not just what it was', async () => {
    using handle = await createTestDatabase();
    const [assetId] = seedClaimableAssets(handle.db, STAGE, 1) as [string];
    const at = new Date('2026-06-01T12:00:00.000Z');

    await tick(handle, { now: at, handler: throws('boom') });

    // Without `failed_at` a stale error string cannot be told apart from a live
    // failure, and neither can be correlated against provider logs or deploys.
    expect(stageRow(handle.db, assetId, STAGE)?.failed_at).toBe(at.toISOString());
  });

  test('a later success clears the whole trail', async () => {
    using handle = await createTestDatabase();
    const [assetId] = seedClaimableAssets(handle.db, STAGE, 1) as [string];
    const first = new Date('2026-06-01T12:00:00.000Z');

    await tick(handle, { now: first, handler: throws('transient') });
    await tick(handle, {
      now: new Date(first.getTime() + 60_000),
      handler: () => ({ wrote: true }),
    });

    expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({
      version: TARGET_VERSION,
      attempts: 0,
      dead: 0,
      last_error: null,
      failed_at: null,
      next_attempt_at: null,
    });
  });

  test('the attempt that dead-letters sets no retry gate', async () => {
    using handle = await createTestDatabase();
    const [assetId] = seedClaimableAssets(handle.db, STAGE, 1) as [string];

    const result = await tick(handle, {
      now: new Date('2026-06-01T12:00:00.000Z'),
      maxAttempts: 1,
      handler: throws('fatal'),
    });

    expect(result.dead).toBe(true);
    // A `next_attempt_at` on a dead row would be meaningless — nothing will
    // ever re-claim it until an operator lifts the flag.
    expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({
      dead: 1,
      next_attempt_at: null,
    });
  });
});

describe('a terminal error skips the attempt budget', () => {
  const verdict = (retryable: boolean | undefined): (() => never) => {
    return (): never => {
      const err = new Error('provider said no') as Error & { retryable?: boolean };
      if (retryable !== undefined) err.retryable = retryable;
      throw err;
    };
  };

  test('`retryable: false` dead-letters on the first attempt', async () => {
    using handle = await createTestDatabase();
    const [assetId] = seedClaimableAssets(handle.db, STAGE, 1) as [string];

    await tick(handle, {
      now: new Date('2026-06-01T12:00:00.000Z'),
      maxAttempts: 5,
      handler: verdict(false),
    });

    // A 4xx means the request itself is wrong: walking the rest of the ladder
    // cannot produce a different answer, it only delays the dead-letter.
    expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({ dead: 1, attempts: 1 });
  });

  test('`retryable: true` keeps its budget', async () => {
    using handle = await createTestDatabase();
    const [assetId] = seedClaimableAssets(handle.db, STAGE, 1) as [string];

    await tick(handle, {
      now: new Date('2026-06-01T12:00:00.000Z'),
      maxAttempts: 5,
      handler: verdict(true),
    });

    expect(stageRow(handle.db, assetId, STAGE)?.dead).toBe(0);
  });

  test('an error carrying no verdict keeps its budget', async () => {
    using handle = await createTestDatabase();
    const [assetId] = seedClaimableAssets(handle.db, STAGE, 1) as [string];

    await tick(handle, {
      now: new Date('2026-06-01T12:00:00.000Z'),
      maxAttempts: 5,
      handler: verdict(undefined),
    });

    // Only an explicit `false` counts. Silence says nothing about
    // retryability, so the full budget stands.
    expect(stageRow(handle.db, assetId, STAGE)?.dead).toBe(0);
  });
});

describe('exhausting the budget', () => {
  test('three failures across the ladder dead-letter the asset', async () => {
    using handle = await createTestDatabase();
    const [assetId] = seedClaimableAssets(handle.db, STAGE, 1) as [string];
    const start = new Date('2026-06-01T12:00:00.000Z').getTime();
    // Past each rung of RETRY_BACKOFF_MS in turn: 30 s, then 120 s.
    const offsets = [0, 60_000, 400_000];

    for (const offset of offsets) {
      await tick(handle, { now: new Date(start + offset), handler: throws('always fail') });
    }

    expect(stageRow(handle.db, assetId, STAGE)).toMatchObject({
      attempts: 3,
      dead: 1,
      last_error: 'always fail',
    });
  });

  test('a file-reading stage tags the asset damaged when it exhausts retries', async () => {
    using handle = await createTestDatabase();
    const [assetId] = seedClaimableAssets(handle.db, STAGE, 1) as [string];
    const start = new Date('2026-06-01T12:00:00.000Z').getTime();

    const first = await tick(handle, {
      now: new Date(start),
      maxAttempts: 2,
      tagsDamagedOnDeadLetter: true,
      handler: throws('Unknown file format'),
    });
    const tagAfterFirst = damagedTag(handle.db, assetId);
    const second = await tick(handle, {
      now: new Date(start + 60_000),
      maxAttempts: 2,
      tagsDamagedOnDeadLetter: true,
      handler: throws('Unknown file format'),
    });

    expect(first.dead).toBe(false);
    expect(tagAfterFirst.damaged_since).toBeNull();
    expect(second.dead).toBe(true);
    // The tag parks the file out of EVERY stage's claim, so the rest of the
    // pipeline stops grinding to its own dead-letter on the same bytes.
    expect(damagedTag(handle.db, assetId)).toMatchObject({
      damaged_stage: STAGE,
      damaged_reason: 'Unknown file format',
    });
  });

  test('a stage without the opt-in dead-letters without tagging', async () => {
    using handle = await createTestDatabase();
    const [assetId] = seedClaimableAssets(handle.db, STAGE, 1) as [string];

    await tick(handle, {
      now: new Date('2026-06-01T12:00:00.000Z'),
      maxAttempts: 1,
      handler: throws('LLM timed out'),
    });

    // A describe timeout or a geocode 5xx says nothing about the bytes.
    expect(stageRow(handle.db, assetId, STAGE)?.dead).toBe(1);
    expect(damagedTag(handle.db, assetId).damaged_since).toBeNull();
  });

  test('a dead-lettered asset is never claimed again', async () => {
    using handle = await createTestDatabase();
    seedClaimableAssets(handle.db, STAGE, 1);
    const start = new Date('2026-06-01T12:00:00.000Z').getTime();

    await tick(handle, { now: new Date(start), maxAttempts: 1, handler: throws('fatal') });
    const after = await tick(handle, {
      now: new Date(start + 86_400_000),
      maxAttempts: 1,
      handler: throws('fatal'),
    });

    expect(after.claimed).toBe(0);
  });
});
