/**
 * Job rows driven end to end through a real Temporal server: the relay starts
 * the workflow, the workflow's activity runs the handler, and the row records
 * the outcome. One throwaway server is shared by the file; every test brings
 * its own database and its own host.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { ObjectId } from '../db/object-id.ts';
import { createLiveTestDatabase, run } from '../db/sqlite/test-sqlite.test-helpers.ts';
import type { JobStatus } from '../db/schema.ts';
import type { JobHandler } from '../job-runner/handlers/index.ts';
import { JOB_TASK_QUEUE, jobWorkflow, jobWorkflowId } from '../job-runner/job-workflow.ts';
import { jobLane } from '../job-runner/job-queue.ts';
import { createJob, getJob, markJobDispatched, resumeBatchJob } from '../job-runner/jobs.repo.ts';
import { startLocalTemporalServer, until } from './local-temporal.test-helpers.ts';
import { readTemporalStatus, saveTemporalSettings } from './temporal-config.ts';
import { dispatchSignal } from './row-workflow.ts';
import { TemporalHost } from './temporal-host.ts';
import { defaultTemporalLanes } from './worker-tier-host.ts';

const EXPORT_PAYLOAD = { assetIds: [], outputDir: '/tmp', quality: 80 };
const FAST = { relayMs: 20, refreshMs: 100, retryMs: 100 };

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await startLocalTemporalServer();
}, 120_000);

afterAll(async () => {
  await env.teardown();
});

/** Awaited here, not inside `expect().rejects`, which under Bun sits out the full long-poll. */
const failureOf = (workflow: { result: () => Promise<unknown> }): Promise<unknown> =>
  workflow.result().then(
    () => null,
    (error: unknown) => error,
  );

const jobStatus = (id: ObjectId, status: JobStatus) =>
  until(
    () => getJob(id),
    (job) => job?.status === status,
  );

async function hostFor(handle: JobHandler['run']): Promise<TemporalHost> {
  await saveTemporalSettings({ address: env.address, namespace: 'default' });
  const host = new TemporalHost({
    ...FAST,
    lanes: [jobLane({ handlers: { batch_jpeg_export: { run: handle } } })],
  });
  host.start();
  return host;
}

const queueExportJob = () => createJob({ kind: 'batch_jpeg_export', payload: EXPORT_PAYLOAD });

describe('jobs on Temporal', () => {
  test('a queued row becomes a workflow, runs, and ends done', async () => {
    using _live = await createLiveTestDatabase();
    const host = await hostFor(async (payload, ctx) => {
      await ctx.reportProgress(1, 1);
      return { kind: 'done', result: { echoed: payload } };
    });
    try {
      const job = await queueExportJob();

      const done = await jobStatus(job._id, 'done');

      expect(done?.result).toEqual({ echoed: EXPORT_PAYLOAD });
      expect(done?.progress).toEqual({ current: 1, total: 1 });
      const workflow = env.client.workflow.getHandle(jobWorkflowId(job._id.toHexString()));
      await workflow.result();
      expect((await workflow.describe()).status.name).toBe('COMPLETED');
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('jobs queued behind a running one run one at a time, in the order they were created', async () => {
    using _live = await createLiveTestDatabase();
    const order: string[] = [];
    let inFlight = 0;
    let overlapped = false;
    const host = await hostFor(async (_payload, ctx) => {
      inFlight += 1;
      overlapped ||= inFlight > 1;
      order.push(ctx.jobId.toHexString());
      await new Promise((resolve) => setTimeout(resolve, 60));
      inFlight -= 1;
      return { kind: 'done', result: {} };
    });
    try {
      const first = await queueExportJob();
      await jobStatus(first._id, 'running');
      const waiting = [];
      for (let n = 0; n < 6; n += 1) {
        waiting.push(await queueExportJob());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await jobStatus(waiting.at(-1)!._id, 'done');

      expect(overlapped).toBe(false);
      expect(order).toEqual([first, ...waiting].map((job) => job._id.toHexString()));
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a workflow terminated in Temporal cancels its job and lets the next one run', async () => {
    using _live = await createLiveTestDatabase();
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = await hostFor(async (_payload, ctx) => {
      await blocked;
      await ctx.reportProgress(1, 1);
      return { kind: 'done', result: {} };
    });
    try {
      const stopped = await queueExportJob();
      await jobStatus(stopped._id, 'running');
      const next = await queueExportJob();

      await env.client.workflow.getHandle(jobWorkflowId(stopped._id.toHexString())).terminate();

      await jobStatus(stopped._id, 'cancelled');
      release();
      await jobStatus(next._id, 'done');
      expect((await getJob(stopped._id))?.status).toBe('cancelled');
    } finally {
      release();
      await host.stop();
    }
  }, 60_000);

  test('a workflow that disappears is submitted again without running the handler twice', async () => {
    using _live = await createLiveTestDatabase();
    let runs = 0;
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = await hostFor(async () => {
      runs += 1;
      await blocked;
      return { kind: 'done', result: { runs } };
    });
    try {
      const job = await queueExportJob();
      await jobStatus(job._id, 'running');
      const workflowId = jobWorkflowId(job._id.toHexString());
      const lost = await env.client.workflow.getHandle(workflowId).describe();

      await env.client.workflowService.deleteWorkflowExecution({
        namespace: 'default',
        workflowExecution: { workflowId, runId: lost.runId },
      });

      const resubmitted = await until(
        () =>
          env.client.workflow
            .getHandle(workflowId)
            .describe()
            .catch(() => null),
        (described) => described !== null && described.runId !== lost.runId,
      );
      expect(resubmitted?.status.name).toBe('RUNNING');
      release();
      expect((await jobStatus(job._id, 'done'))?.result).toEqual({ runs: 1 });
      expect(await env.client.workflow.getHandle(workflowId).result()).toBe('done');
    } finally {
      release();
      await host.stop();
    }
  }, 60_000);

  test('a failed job fails its workflow with the same message', async () => {
    using _live = await createLiveTestDatabase();
    const host = await hostFor(async () => {
      throw new Error('disk full');
    });
    try {
      const job = await queueExportJob();
      await jobStatus(job._id, 'failed');

      const workflow = env.client.workflow.getHandle(jobWorkflowId(job._id.toHexString()));
      expect(await failureOf(workflow)).toMatchObject({ cause: { message: 'disk full' } });
      expect((await workflow.describe()).status.name).toBe('FAILED');
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a job cancelled in Temporal before any worker picked it up never runs', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();
    const jobId = job._id.toHexString();
    const workflow = await env.client.workflow.signalWithStart(jobWorkflow, {
      workflowId: jobWorkflowId(jobId),
      taskQueue: JOB_TASK_QUEUE,
      args: [jobId],
      signal: dispatchSignal,
    });
    await markJobDispatched(jobId);
    await workflow.cancel();
    let ran = false;

    const host = await hostFor(async () => {
      ran = true;
      return { kind: 'done', result: {} };
    });
    try {
      await jobStatus(job._id, 'cancelled');
      expect(ran).toBe(false);
      expect((await workflow.describe()).status.name).toBe('CANCELLED');
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a resumed job runs again under the same workflow id', async () => {
    using _live = await createLiveTestDatabase();
    let runs = 0;
    const host = await hostFor(async () => {
      runs += 1;
      if (runs === 1) throw new Error('disk full');
      return { kind: 'done', result: { runs } };
    });
    try {
      const job = await queueExportJob();
      expect((await jobStatus(job._id, 'failed'))?.error).toBe('disk full');

      expect(await resumeBatchJob(job._id)).toBe(true);

      expect((await jobStatus(job._id, 'done'))?.result).toEqual({ runs: 2 });
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a job left running by an earlier server version is adopted at connect', async () => {
    using live = await createLiveTestDatabase();
    const job = await queueExportJob();
    run(
      live.db,
      `UPDATE jobs SET status = 'running', locked_by = 'job-runner-123-abc',
          ledger = json('{"applied":2}')
        WHERE id = ?`,
      job._id.toHexString(),
    );
    const host = await hostFor(async (_payload, ctx) => ({
      kind: 'done',
      result: { resumedFrom: ctx.checkpoint },
    }));
    try {
      expect((await jobStatus(job._id, 'done'))?.result).toEqual({
        resumedFrom: { applied: 2 },
      });
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a dispatch for a job from some other database fails its workflow instead of vanishing', async () => {
    using _live = await createLiveTestDatabase();
    const host = await hostFor(async () => ({ kind: 'done', result: {} }));
    try {
      const strangerId = new ObjectId().toHexString();
      const workflow = await env.client.workflow.signalWithStart(jobWorkflow, {
        workflowId: jobWorkflowId(strangerId),
        taskQueue: JOB_TASK_QUEUE,
        args: [strangerId],
        signal: dispatchSignal,
      });

      expect(await failureOf(workflow)).toMatchObject({
        cause: { cause: { message: expect.stringContaining('its own Temporal namespace') } },
      });
      expect((await workflow.describe()).status.name).toBe('FAILED');
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('cancelling the workflow in Temporal stops the handler and cancels the job', async () => {
    using _live = await createLiveTestDatabase();
    const host = await hostFor(async (_payload, ctx) => {
      for (let step = 0; step < 400; step += 1) {
        await ctx.reportProgress(step, 400);
        if (await ctx.shouldCancel()) return { kind: 'cancelled', result: { stoppedAt: step } };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { kind: 'done', result: {} };
    });
    try {
      const job = await queueExportJob();
      await jobStatus(job._id, 'running');

      await env.client.workflow.getHandle(jobWorkflowId(job._id.toHexString())).cancel();

      const cancelled = await jobStatus(job._id, 'cancelled');
      expect(cancelled?.result).toHaveProperty('stoppedAt');
    } finally {
      await host.stop();
    }
  }, 60_000);
});

describe('connection state', () => {
  test('reports unreachable with the reason, then connected once the address is fixed', async () => {
    using _live = await createLiveTestDatabase();
    await saveTemporalSettings({ address: '127.0.0.1:9', namespace: 'default' });
    const host = new TemporalHost({ ...FAST, lanes: defaultTemporalLanes() });
    host.start();
    try {
      const down = await until(readTemporalStatus, (s) => s.connection.state === 'unreachable');
      expect(down.connection.error).toBeTruthy();

      await saveTemporalSettings({ address: env.address, namespace: 'default' });

      const up = await until(readTemporalStatus, (s) => s.connection.state === 'connected');
      expect(up.address).toBe(env.address);
      expect(up.connection.error).toBeNull();
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('stays unreachable for as long as a server that went away is away', async () => {
    using _live = await createLiveTestDatabase();
    const doomed = await startLocalTemporalServer();
    await saveTemporalSettings({ address: doomed.address, namespace: 'default' });
    const host = new TemporalHost({ ...FAST, lanes: defaultTemporalLanes() });
    host.start();
    try {
      await until(readTemporalStatus, (s) => s.connection.state === 'connected');

      await doomed.teardown();

      await until(readTemporalStatus, (s) => s.connection.state === 'unreachable');
      const later: string[] = [];
      for (let sample = 0; sample < 30; sample += 1) {
        later.push((await readTemporalStatus()).connection.state);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(new Set(later)).toEqual(new Set(['unreachable']));
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('says it is waiting while a running job holds back a change of server', async () => {
    using _live = await createLiveTestDatabase();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = await hostFor(async () => {
      await held;
      return { kind: 'done', result: {} };
    });
    try {
      const job = await queueExportJob();
      await jobStatus(job._id, 'running');

      await saveTemporalSettings({ address: '127.0.0.1:9', namespace: 'default' });

      const waiting = await until(readTemporalStatus, (s) => s.connection.state === 'unreachable');
      expect(waiting.connection.error).toMatch(/waiting for running work/i);

      release();

      await jobStatus(job._id, 'done');
      await until(readTemporalStatus, (s) => !/waiting/i.test(s.connection.error ?? 'waiting'));
    } finally {
      release();
      await host.stop();
    }
  }, 60_000);

  test('a lane that cannot reconcile is reported while the other lanes keep running', async () => {
    using _live = await createLiveTestDatabase();
    await saveTemporalSettings({ address: env.address, namespace: 'default' });
    const working = jobLane({
      handlers: { batch_jpeg_export: { run: async () => ({ kind: 'done', result: {} }) } },
    });
    const broken = {
      taskQueue: 'broken-lane',
      activities: {},
      concurrency: 1,
      reconcile: async () => {
        throw new Error('ledger unreadable');
      },
    };
    const host = new TemporalHost({ ...FAST, lanes: [broken, working] });
    host.start();
    try {
      const job = await queueExportJob();

      await jobStatus(job._id, 'done');

      const status = await until(readTemporalStatus, (s) => s.connection.state === 'unreachable');
      expect(status.connection.error).toBe('ledger unreadable');
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a namespace the server does not have is reported, not silently retried', async () => {
    using _live = await createLiveTestDatabase();
    await saveTemporalSettings({ address: env.address, namespace: 'no-such-namespace' });
    const host = new TemporalHost({ ...FAST, lanes: defaultTemporalLanes() });
    host.start();
    try {
      const status = await until(readTemporalStatus, (s) => s.connection.state === 'unreachable');
      expect(status.connection.error).toMatch(/namespace/i);
    } finally {
      await host.stop();
    }
  }, 60_000);
});
