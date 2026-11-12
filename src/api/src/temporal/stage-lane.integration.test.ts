/**
 * Pipeline stages driven through a real Temporal server: the lane notices work
 * in `stage_state`, starts the stage's workflow, and its slices drain the
 * stage. One throwaway server is shared by the file; every test brings its own
 * database, its own stage (so workflow ids never collide) and its own host.
 */

import type { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { WorkflowNotFoundError } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { seedClaimableAsset, stageRow } from '../db/repos/stage-runtime.test-helpers.ts';
import { WorkerConfigRepo } from '../db/repos/worker-config.repo.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import type { JobHandler } from '../job-runner/handlers/index.ts';
import { jobLane } from '../job-runner/job-queue.ts';
import { createJob, getJob } from '../job-runner/jobs.repo.ts';
import { stageRegistry } from '../workers/registry.ts';
import {
  defineStage,
  runStage,
  type RunStageHandle,
  type RunStageOptions,
  type StageConfig,
  type StageResult,
} from '../workers/run-stage.ts';
import { stageLane } from '../workers/stage-lane.ts';
import { stageWorkflowId } from '../workers/stage-workflow.ts';
import { startLocalTemporalServer } from './local-temporal.test-helpers.ts';
import { saveTemporalSettings } from './temporal-config.ts';
import { TemporalHost } from './temporal-host.ts';

const FAST = { relayMs: 20, refreshMs: 100, retryMs: 100 };

const DEFAULTS = {
  concurrency: 2,
  maxAttempts: 3,
  paused: false,
  pausedOnFirstBoot: false,
  last_seen_target_version: 1,
};

let env: TestWorkflowEnvironment;
let stageCount = 0;
const runners = new Map<string, RunStageHandle>();

beforeAll(async () => {
  env = await startLocalTemporalServer();
}, 120_000);

afterEach(async () => {
  await Promise.all([...runners.values()].map((runner) => runner.stop()));
  runners.clear();
  stageRegistry._resetForTests();
});

afterAll(async () => {
  await env.teardown();
});

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { blocked: promise, release: () => resolve() };
}

const skip = async (): Promise<StageResult> => ({ skip: 'noop' });

/** A stage of its own, booted into this file's lane. */
async function bootStage(
  handler: () => Promise<StageResult>,
  extra: Partial<StageConfig> = {},
  options: RunStageOptions = {},
): Promise<RunStageHandle> {
  stageCount += 1;
  const stage = defineStage({
    name: `lane-test-${stageCount}`,
    targetVersion: 1,
    dependsOn: [],
    defaults: DEFAULTS,
    handler,
    ...extra,
  }) as StageConfig;
  const runner = await runStage(stage, options);
  runners.set(runner.name, runner);
  return runner;
}

const seed = (db: Database, stage: string, count: number): string[] =>
  Array.from({ length: count }, () => seedClaimableAsset(db, { stages: { [stage]: {} } }));

const versions = (db: Database, stage: string, assets: readonly string[]): number[] =>
  assets.map((id) => stageRow(db, id, stage)?.version ?? -1);

const allDone = (values: number[]): boolean => values.every((version) => version === 1);

async function hostFor(handleJob?: JobHandler['run']): Promise<TemporalHost> {
  await saveTemporalSettings({ address: env.address, namespace: 'default' });
  const jobs =
    handleJob === undefined
      ? []
      : [jobLane({ handlers: { batch_jpeg_export: { run: handleJob } } })];
  const host = new TemporalHost({ ...FAST, lanes: [stageLane(() => runners), ...jobs] });
  host.start();
  return host;
}

const workflowOf = (runner: RunStageHandle) =>
  env.client.workflow.getHandle(stageWorkflowId(runner.name));

async function workflowStarted(runner: RunStageHandle): Promise<boolean> {
  try {
    await workflowOf(runner).describe();
    return true;
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return false;
    throw error;
  }
}

describe('stages on Temporal', () => {
  test('seeded assets are processed and the stage workflow completes', async () => {
    using live = await createLiveTestDatabase();
    const runner = await bootStage(skip);
    const host = await hostFor();
    try {
      const assets = seed(live.db, runner.name, 25);

      await until(() => versions(live.db, runner.name, assets), allDone);

      const workflow = workflowOf(runner);
      await workflow.result();
      expect((await workflow.describe()).status.name).toBe('COMPLETED');
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a stage with nothing to do starts no workflow, and its idle hook keeps firing', async () => {
    using _live = await createLiveTestDatabase();
    let idleCalls = 0;
    const runner = await bootStage(skip, {
      onProgress: (_processed, idle) => {
        if (idle) idleCalls += 1;
      },
    });
    const host = await hostFor();
    try {
      await until(
        () => idleCalls,
        (calls) => calls >= 5,
      );

      expect(await workflowStarted(runner)).toBe(false);
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a pause written to worker_config stops new slices, and a resume continues', async () => {
    using live = await createLiveTestDatabase();
    const runner = await bootStage(skip);
    const config = new WorkerConfigRepo();
    await config.patch(runner.name, { paused: true });
    const host = await hostFor();
    try {
      await until(
        () => runner.paused,
        (paused) => paused,
      );
      const assets = seed(live.db, runner.name, 3);
      await Bun.sleep(500);

      expect(versions(live.db, runner.name, assets)).toEqual([0, 0, 0]);
      expect(await workflowStarted(runner)).toBe(false);

      await config.patch(runner.name, { paused: false });

      await until(() => versions(live.db, runner.name, assets), allDone);
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a handler that throws is retried by the stage’s own bookkeeping', async () => {
    using live = await createLiveTestDatabase();
    let calls = 0;
    const runner = await bootStage(async () => {
      calls += 1;
      if (calls === 1) throw new Error('provider blip');
      return { skip: 'recovered' };
    });
    const host = await hostFor();
    try {
      const [asset] = seed(live.db, runner.name, 1);
      const failed = await until(
        () => stageRow(live.db, asset!, runner.name),
        (row) => row?.last_error === 'provider blip',
      );
      expect(failed?.next_attempt_at).not.toBeNull();
      await workflowOf(runner).result();

      live.db.run(`UPDATE stage_state SET next_attempt_at = NULL WHERE stage = ?`, [runner.name]);

      const done = await until(
        () => stageRow(live.db, asset!, runner.name),
        (row) => row?.version === 1,
      );
      expect(done?.last_error).toBe('skip: recovered');
      expect(calls).toBe(2);
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a failing claim is retried by Temporal in the same run and recovers', async () => {
    using live = await createLiveTestDatabase();
    const runner = await bootStage(skip);
    live.db.run(`CREATE TRIGGER refuse_claim BEFORE UPDATE ON stage_state
                 BEGIN SELECT RAISE(ABORT, 'claim refused'); END`);
    const host = await hostFor();
    try {
      const assets = seed(live.db, runner.name, 2);
      await until(
        () => stageRegistry.statuses()[runner.name]?.lastError ?? null,
        (error) => error?.includes('claim refused') === true,
      );
      const failing = await workflowOf(runner).describe();

      live.db.run(`DROP TRIGGER refuse_claim`);

      await until(() => versions(live.db, runner.name, assets), allDone);
      await workflowOf(runner).result();
      const finished = await workflowOf(runner).describe();
      expect(finished.runId).toBe(failing.runId);
      expect(finished.status.name).toBe('COMPLETED');
      expect(stageRegistry.statuses()[runner.name]?.lastError).toBeNull();
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a terminated workflow is started again while work remains', async () => {
    using live = await createLiveTestDatabase();
    const first = gate();
    const started = gate();
    const runner = await bootStage(
      async () => {
        started.release();
        await first.blocked;
        return { skip: 'noop' };
      },
      { defaults: { ...DEFAULTS, concurrency: 1 } },
      { sliceMs: 1 },
    );
    const host = await hostFor();
    try {
      const assets = seed(live.db, runner.name, 8);
      await started.blocked;
      const terminated = await workflowOf(runner).describe();

      await workflowOf(runner).terminate('test');
      first.release();

      await until(() => versions(live.db, runner.name, assets), allDone);
      await workflowOf(runner).result();
      const restarted = await workflowOf(runner).describe();
      expect(restarted.runId).not.toBe(terminated.runId);
      expect(restarted.status.name).toBe('COMPLETED');
    } finally {
      first.release();
      await host.stop();
    }
  }, 60_000);

  test('stage work goes on while a job runs on its own lane', async () => {
    using live = await createLiveTestDatabase();
    const job = gate();
    const runner = await bootStage(skip);
    const host = await hostFor(async () => {
      await job.blocked;
      return { kind: 'done', result: {} };
    });
    try {
      const exporting = await createJob({
        kind: 'batch_jpeg_export',
        payload: { assetIds: [], outputDir: '/tmp', quality: 80 },
      });
      await until(
        () => getJob(exporting._id),
        (row) => row?.status === 'running',
      );
      const assets = seed(live.db, runner.name, 10);

      await until(() => versions(live.db, runner.name, assets), allDone);

      expect((await getJob(exporting._id))?.status).toBe('running');
      job.release();
      await until(
        () => getJob(exporting._id),
        (row) => row?.status === 'done',
      );
    } finally {
      job.release();
      await host.stop();
    }
  }, 60_000);

  test('stopping the stage first bounds the host’s drain when a handler ignores the abort', async () => {
    using live = await createLiveTestDatabase();
    const stuck = gate();
    const started = gate();
    const runner = await bootStage(
      async () => {
        started.release();
        await stuck.blocked;
        return { skip: 'late' };
      },
      {},
      { drainMs: 100 },
    );
    const host = await hostFor();
    try {
      seed(live.db, runner.name, 1);
      await started.blocked;
      const stopping = Date.now();

      await runner.stop();
      runners.delete(runner.name);
      await host.stop();

      expect(Date.now() - stopping).toBeLessThan(5_000);
    } finally {
      stuck.release();
      await Bun.sleep(50);
    }
  }, 60_000);
});
