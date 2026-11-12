/**
 * What a booted stage hands the stage lane: a slice that polls the way the
 * old loop did for about ten seconds, a read-only peek, and the idle call that
 * stands in for a claim that found nothing. Slices here are cut to 50 ms
 * unless a test is about their length. Scheduling them is Temporal's job and is covered by
 * `temporal/stage-lane.integration.test.ts`; this file needs no server.
 */

import type { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { WorkerConfigRepo } from '../db/repos/worker-config.repo.ts';
import { seedClaimableAsset, stageRow } from '../db/repos/stage-runtime.test-helpers.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { gate, until } from '../temporal/local-temporal.test-helpers.ts';
import { stageRegistry } from './registry.ts';
import {
  defineStage,
  runStage,
  StageStoppedError,
  type RunStageHandle,
  type RunStageOptions,
  type StageConfig,
  type StageResult,
} from './run-stage.ts';

const STAGE = 'hash';
const booted: RunStageHandle[] = [];

afterEach(async () => {
  await Promise.all(booted.splice(0).map((stage) => stage.stop()));
  stageRegistry._resetForTests();
});

function testStage(
  handler: () => Promise<StageResult>,
  extra: Partial<StageConfig> = {},
): StageConfig {
  return defineStage({
    name: STAGE,
    targetVersion: 1,
    dependsOn: [],
    defaults: {
      concurrency: 1,
      maxAttempts: 3,
      paused: false,
      pausedOnFirstBoot: false,
      last_seen_target_version: 1,
    },
    handler,
    ...extra,
  }) as StageConfig;
}

async function boot(stage: StageConfig, options: RunStageOptions = {}): Promise<RunStageHandle> {
  const handle = await runStage(stage, { sliceMs: 50, ...options });
  booted.push(handle);
  return handle;
}

const seed = (db: Database, count: number): string[] =>
  Array.from({ length: count }, () => seedClaimableAsset(db, { stages: { [STAGE]: {} } }));

const skip = async (): Promise<StageResult> => ({ skip: 'noop' });

describe('runSlice', () => {
  it('claims again at once after a full batch and waits after a short one', async () => {
    using live = await createLiveTestDatabase();
    const assets = seed(live.db, 12);
    const batches: Array<[number, boolean]> = [];
    const stage = await boot(
      testStage(skip, {
        onProgress: (processed, idle) => {
          batches.push([processed, idle]);
        },
      }),
    );

    expect(await stage.runSlice()).toEqual({ claimed: 12, drained: false });

    expect(batches).toEqual([
      [5, false],
      [5, false],
      [2, false],
    ]);
    expect(assets.map((id) => stageRow(live.db, id, STAGE)?.version)).toEqual(assets.map(() => 1));
    expect(stageRegistry.statuses()[STAGE]?.throughput).toBe(12);
  });

  it('reports drained only for a slice that found nothing, idling as it waits', async () => {
    using _live = await createLiveTestDatabase();
    const batches: Array<[number, boolean]> = [];
    const stage = await boot(
      testStage(skip, {
        onProgress: (processed, idle) => {
          batches.push([processed, idle]);
        },
      }),
    );

    expect(await stage.runSlice()).toEqual({ claimed: 0, drained: true });
    expect(batches).toEqual([[0, true]]);
  });

  it('picks up work that arrives mid-slice within about a second', async () => {
    using live = await createLiveTestDatabase();
    const stage = await boot(testStage(skip), { sliceMs: 3_000 });

    const slice = stage.runSlice();
    await Bun.sleep(100);
    const [asset] = seed(live.db, 1);
    const arrived = Date.now();
    await until(
      () => stageRow(live.db, asset!, STAGE)?.version,
      (version) => version === 1,
    );

    expect(Date.now() - arrived).toBeLessThan(1_500);
    expect(stage.busy).toBe(true);
    expect(await slice).toEqual({ claimed: 1, drained: false });
  });

  it('ends within about two seconds of a pause written by the API process', async () => {
    using live = await createLiveTestDatabase();
    const assets = seed(live.db, 200);
    const stage = await boot(
      testStage(async () => {
        await Bun.sleep(10);
        return { skip: 'slow' };
      }),
      { sliceMs: 10_000 },
    );

    const slice = stage.runSlice();
    await until(
      () => assets.filter((id) => stageRow(live.db, id, STAGE)?.version === 1).length,
      (done) => done > 0,
    );
    const pausedAt = Date.now();
    await new WorkerConfigRepo().patch(STAGE, { paused: true });

    expect((await slice).drained).toBe(true);
    expect(Date.now() - pausedAt).toBeLessThan(2_500);
    expect(stage.paused).toBe(true);
    const handled = assets.filter((id) => stageRow(live.db, id, STAGE)?.version === 1).length;
    expect(handled).toBeLessThan(assets.length);
  }, 15_000);

  it('gives way after its time is up, but only between batches', async () => {
    using live = await createLiveTestDatabase();
    seed(live.db, 8);
    const stage = await boot(
      testStage(async () => {
        await Bun.sleep(20);
        return { skip: 'slow' };
      }),
      { sliceMs: 10 },
    );

    expect(await stage.runSlice()).toEqual({ claimed: 5, drained: false });
    expect(await stage.runSlice()).toEqual({ claimed: 3, drained: false });
    expect(await stage.runSlice()).toEqual({ claimed: 0, drained: true });
  });

  it('runs once for two callers, so a redelivered attempt cannot double the concurrency', async () => {
    using live = await createLiveTestDatabase();
    seed(live.db, 2);
    const handler = gate();
    let calls = 0;
    const stage = await boot(
      testStage(async () => {
        calls += 1;
        await handler.blocked;
        return { skip: 'gated' };
      }),
    );

    const first = stage.runSlice();
    await Bun.sleep(20);
    const second = stage.runSlice();
    expect(stage.busy).toBe(true);
    handler.release();

    expect(await first).toEqual({ claimed: 2, drained: false });
    expect(await second).toEqual({ claimed: 2, drained: false });
    expect(calls).toBe(2);
    expect(stage.busy).toBe(false);
  });

  it('records a failing claim, rethrows it, and clears it once a slice succeeds', async () => {
    using live = await createLiveTestDatabase();
    const [asset] = seed(live.db, 1);
    const stage = await boot(testStage(skip));
    live.db.run(`CREATE TRIGGER refuse_claim BEFORE UPDATE ON stage_state
                 BEGIN SELECT RAISE(ABORT, 'claim refused'); END`);

    const failed = await stage.runSlice().catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(Error);
    expect(String(failed)).toContain('claim refused');
    expect(stageRegistry.statuses()[STAGE]?.lastError).toContain('claim refused');
    expect(stage.busy).toBe(false);

    live.db.run(`DROP TRIGGER refuse_claim`);
    expect(await stage.runSlice()).toEqual({ claimed: 1, drained: false });
    expect(stageRegistry.statuses()[STAGE]?.lastError).toBeNull();
    expect(stageRow(live.db, asset!, STAGE)?.version).toBe(1);
  });

  it('claims nothing while paused', async () => {
    using live = await createLiveTestDatabase();
    const [asset] = seed(live.db, 1);
    const stage = await boot(testStage(skip));
    await stageRegistry.pause(STAGE);

    expect(stage.paused).toBe(true);
    expect(await stage.runSlice()).toEqual({ claimed: 0, drained: true });
    expect(stageRow(live.db, asset!, STAGE)?.version).toBe(0);
  });
});

describe('hasWork', () => {
  it('peeks without claiming', async () => {
    using live = await createLiveTestDatabase();
    const stage = await boot(testStage(skip));
    expect(await stage.hasWork()).toBe(false);

    const [asset] = seed(live.db, 1);
    expect(await stage.hasWork()).toBe(true);
    expect(stageRow(live.db, asset!, STAGE)).toMatchObject({ attempts: 0, claim_token: null });

    await stage.runSlice();
    expect(await stage.hasWork()).toBe(false);
  });

  it('records a failed peek on the stage and clears it on the next good one', async () => {
    using live = await createLiveTestDatabase();
    seed(live.db, 1);
    const broken = { now: true };
    const config = Object.defineProperty(testStage(skip), 'claimResidual', {
      get: () => (broken.now ? { sql: 'no_such_column = 1', params: [] } : undefined),
    });
    const stage = await boot(config);

    expect(await stage.hasWork()).toBe(false);
    expect(stageRegistry.statuses()[STAGE]?.lastError).toContain('no_such_column');

    broken.now = false;
    expect(await stage.hasWork()).toBe(true);
    expect(stageRegistry.statuses()[STAGE]?.lastError).toBeNull();
  });

  it('leaves a failing slice’s error standing when a peek succeeds', async () => {
    using live = await createLiveTestDatabase();
    seed(live.db, 1);
    const stage = await boot(testStage(skip));
    live.db.run(`CREATE TRIGGER refuse_claim BEFORE UPDATE ON stage_state
                 BEGIN SELECT RAISE(ABORT, 'claim refused'); END`);
    await stage.runSlice().catch(() => {});

    expect(await stage.hasWork()).toBe(true);
    expect(stageRegistry.statuses()[STAGE]?.lastError).toContain('claim refused');
  });
});

describe('idle', () => {
  it('tells the idle hook the stage is drained, unless it is paused', async () => {
    using _live = await createLiveTestDatabase();
    const calls: Array<[number, boolean]> = [];
    const stage = await boot(
      testStage(skip, {
        onProgress: (processed, idle) => {
          calls.push([processed, idle]);
        },
      }),
    );

    await stage.idle();
    expect(calls).toEqual([[0, true]]);

    await stageRegistry.pause(STAGE);
    await stage.idle();
    expect(calls).toEqual([[0, true]]);
  });

  it('picks up a resume written by the API process', async () => {
    using _live = await createLiveTestDatabase();
    await new WorkerConfigRepo().upsert(STAGE, {
      concurrency: 1,
      maxAttempts: 3,
      paused: true,
      last_seen_target_version: 1,
    });
    const stage = await boot(testStage(skip));
    expect(stage.paused).toBe(true);

    await new WorkerConfigRepo().patch(STAGE, { paused: false });

    await until(
      async () => {
        await stage.idle();
        return stage.paused;
      },
      (paused) => !paused,
      5_000,
    );
  });

  it('does nothing while a slice is running', async () => {
    using live = await createLiveTestDatabase();
    seed(live.db, 1);
    const handler = gate();
    const calls: number[] = [];
    const stage = await boot(
      testStage(
        async () => {
          await handler.blocked;
          return { skip: 'gated' };
        },
        { onProgress: (processed) => void calls.push(processed) },
      ),
    );

    const slice = stage.runSlice();
    await Bun.sleep(20);
    await stage.idle();
    expect(calls).toEqual([]);

    handler.release();
    await slice;
    expect(calls).toEqual([1]);
  });
});

describe('stop', () => {
  it('lets a running batch finish its writeback before the stage stops', async () => {
    using live = await createLiveTestDatabase();
    const [asset] = seed(live.db, 1);
    const started = gate();
    const stage = await boot(
      testStage(async () => {
        started.release();
        await Bun.sleep(50);
        return { skip: 'finished' };
      }),
    );

    const slice = stage.runSlice();
    await started.blocked;
    await stage.stop();

    expect(await slice).toEqual({ claimed: 1, drained: false });
    expect(stageRow(live.db, asset!, STAGE)?.version).toBe(1);
    const after = await stage.runSlice().catch((error: unknown) => error);
    expect(after).toBeInstanceOf(StageStoppedError);
  });

  it('settles a slice whose handler ignores the abort once the drain bound passes', async () => {
    using live = await createLiveTestDatabase();
    seed(live.db, 1);
    const handler = gate();
    const started = gate();
    const stage = await boot(
      testStage(async () => {
        started.release();
        await handler.blocked;
        return { skip: 'late' };
      }),
      { drainMs: 50 },
    );

    const slice = stage.runSlice().catch((error: unknown) => error);
    await started.blocked;
    const stopping = Date.now();
    await stage.stop();

    expect(Date.now() - stopping).toBeLessThan(1_000);
    expect(await slice).toBeInstanceOf(StageStoppedError);
    expect(stageRegistry.statuses()[STAGE]).toBeUndefined();
    handler.release();
    await Bun.sleep(50);
  });
});
