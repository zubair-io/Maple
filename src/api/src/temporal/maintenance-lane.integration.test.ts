/**
 * Maintenance schedules driven end to end through a real Temporal server. Each
 * test hands the lane a small task list of its own, with ids no other test
 * uses, whose schedule settings live in the test's database; one throwaway
 * server is shared by the file.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ScheduleNotFoundError } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { patchAppSettings, readAppSettings } from '../db/repos/app-settings.repo.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import {
  maintenanceLane,
  maintenanceRunNowId,
  maintenanceScheduleId,
} from '../workers/maintenance/lane.ts';
import {
  pendingMaintenanceRuns,
  requestMaintenanceRun,
} from '../workers/maintenance/run-now.repo.ts';
import type { DesiredSchedule, MaintenanceTask } from '../workers/maintenance/tasks.ts';
import {
  MAINTENANCE_TASK_QUEUE,
  type MaintenanceRunOptions,
} from '../workers/maintenance/workflow.ts';
import { startLocalTemporalServer, until } from './local-temporal.test-helpers.ts';
import { saveTemporalSettings } from './temporal-config.ts';
import { TemporalHost } from './temporal-host.ts';
import { maintenanceWorkflow } from './workflows.ts';

const FAST = { relayMs: 20, refreshMs: 100, retryMs: 100 };
const HOUR_MS = 3_600_000;

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

/** The relay starts a requested run within a tick or two; until then its id is unknown. */
async function startedRun(taskId: string) {
  const workflow = env.client.workflow.getHandle(maintenanceRunNowId(taskId));
  await until(
    () =>
      workflow.describe().then(
        () => true,
        () => false,
      ),
    (started) => started,
  );
  return workflow;
}

const SETTINGS_DOC = 'maintenance-lane-test';

/** A task's schedule as the test database says it should be. */
const storedSchedule = (id: string, fallback: DesiredSchedule) => async () => {
  const doc = await readAppSettings<Record<string, DesiredSchedule>>(SETTINGS_DOC);
  return doc?.[id] ?? fallback;
};

const saveSchedule = (id: string, desired: DesiredSchedule) =>
  patchAppSettings(SETTINGS_DOC, { [id]: desired });

interface Recorded {
  runs: MaintenanceRunOptions[];
  inFlight: number;
  overlapped: boolean;
}

function recordingTask(
  id: string,
  fallback: DesiredSchedule,
  pass: (options: MaintenanceRunOptions) => Promise<void> = async () => {},
): MaintenanceTask & { recorded: Recorded } {
  const recorded: Recorded = { runs: [], inFlight: 0, overlapped: false };
  return {
    id,
    recorded,
    desired: storedSchedule(id, fallback),
    run: async (_signal, options) => {
      recorded.inFlight += 1;
      recorded.overlapped ||= recorded.inFlight > 1;
      recorded.runs.push(options);
      try {
        await pass(options);
      } finally {
        recorded.inFlight -= 1;
      }
    },
  };
}

async function hostFor(tasks: MaintenanceTask[]): Promise<TemporalHost> {
  await saveTemporalSettings({ address: env.address, namespace: 'default' });
  const host = new TemporalHost({ ...FAST, lanes: [maintenanceLane(tasks)] });
  host.start();
  return host;
}

const describeSchedule = (taskId: string) =>
  env.client.schedule.getHandle(maintenanceScheduleId(taskId)).describe();

const describeOrMissing = (scheduleId: string) =>
  env.client.schedule
    .getHandle(scheduleId)
    .describe()
    .then(
      (description) => description,
      (error: unknown) => {
        if (error instanceof ScheduleNotFoundError) return null;
        throw error;
      },
    );

/** The workflow ids a schedule has started, oldest first. */
const scheduledRuns = async (taskId: string): Promise<string[]> =>
  (await describeSchedule(taskId)).info.recentActions.map(
    (action) => action.action.workflow.workflowId,
  );

describe('maintenance schedules', () => {
  test('reconcile creates a schedule whose first pass runs at once and completes', async () => {
    using _live = await createLiveTestDatabase();
    const task = recordingTask('created', { everyMs: HOUR_MS, paused: false });
    const host = await hostFor([task]);
    try {
      const [workflowId] = await until(
        () => scheduledRuns(task.id).catch(() => []),
        (ids) => ids.length > 0,
      );
      const workflow = env.client.workflow.getHandle(workflowId!);
      await workflow.result();

      expect((await workflow.describe()).status.name).toBe('COMPLETED');
      expect(task.recorded.runs).toEqual([{}]);
      const schedule = await describeSchedule(task.id);
      expect(schedule.spec.intervals?.map(({ every }) => every)).toEqual([HOUR_MS]);
      expect(schedule.state.paused).toBe(false);
      expect(schedule.policies.overlap).toBe('SKIP');
      expect(schedule.policies.catchupWindow).toBe(HOUR_MS);
      expect(schedule.action.taskQueue).toBe(MAINTENANCE_TASK_QUEUE);

      await Bun.sleep(FAST.refreshMs * 4);
      expect((await describeSchedule(task.id)).info.lastUpdatedAt).toBeUndefined();
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a new interval or a pause saved in the database reaches the schedule', async () => {
    using _live = await createLiveTestDatabase();
    const task = recordingTask('retuned', { everyMs: HOUR_MS, paused: true });
    const host = await hostFor([task]);
    try {
      await until(
        () => describeOrMissing(maintenanceScheduleId(task.id)),
        (schedule) => schedule?.state.paused === true,
      );

      await saveSchedule(task.id, { everyMs: 2 * HOUR_MS, paused: true });
      const retuned = await until(
        () => describeSchedule(task.id),
        (schedule) => schedule.spec.intervals?.[0]?.every === 2 * HOUR_MS,
      );
      expect(retuned.policies.catchupWindow).toBe(2 * HOUR_MS);

      await saveSchedule(task.id, { everyMs: 2 * HOUR_MS, paused: false });
      await until(
        () => describeSchedule(task.id),
        (schedule) => !schedule.state.paused,
      );
      await until(
        async () => task.recorded.runs.length,
        (runs) => runs === 1,
      );
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a schedule deleted in Temporal is created again', async () => {
    using _live = await createLiveTestDatabase();
    const task = recordingTask('recreated', { everyMs: HOUR_MS, paused: true });
    const host = await hostFor([task]);
    try {
      const scheduleId = maintenanceScheduleId(task.id);
      await until(
        () => describeOrMissing(scheduleId),
        (schedule) => schedule !== null,
      );

      await env.client.schedule.getHandle(scheduleId).delete();

      const again = await until(
        () => describeOrMissing(scheduleId),
        (schedule) => schedule !== null,
      );
      expect(again?.state.paused).toBe(true);
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a maintenance schedule for a task that no longer exists is deleted', async () => {
    using _live = await createLiveTestDatabase();
    const retired = maintenanceScheduleId('retired');
    await env.client.schedule.create({
      scheduleId: retired,
      spec: { intervals: [{ every: HOUR_MS }] },
      action: {
        type: 'startWorkflow',
        workflowType: maintenanceWorkflow,
        taskQueue: MAINTENANCE_TASK_QUEUE,
        args: ['retired'],
      },
      state: { paused: true },
    });
    const host = await hostFor([recordingTask('kept', { everyMs: HOUR_MS, paused: true })]);
    try {
      await until(
        () => describeOrMissing(retired),
        (schedule) => schedule === null,
      );
      expect(await describeOrMissing(maintenanceScheduleId('kept'))).not.toBeNull();
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a run that comes due while the previous pass is still going is skipped', async () => {
    using _live = await createLiveTestDatabase();
    const task = recordingTask('slow', { everyMs: 1_000, paused: false }, () => Bun.sleep(3_500));
    const host = await hostFor([task]);
    try {
      const schedule = await until(
        () => describeSchedule(task.id).catch(() => null),
        (described) => (described?.info.numActionsSkippedOverlap ?? 0) >= 2,
      );

      expect(task.recorded.overlapped).toBe(false);
      expect(schedule?.info.runningActions.length).toBeLessThanOrEqual(1);
      expect(schedule?.policies.catchupWindow).toBe(60_000);
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a failed pass fails its run, and the schedule still runs the next one', async () => {
    using _live = await createLiveTestDatabase();
    const task = recordingTask('failing', { everyMs: 1_000, paused: false }, async () => {
      throw new Error('the pass broke');
    });
    const host = await hostFor([task]);
    try {
      const [first] = await until(
        () => scheduledRuns(task.id).catch(() => []),
        (ids) => ids.length >= 2,
      );
      const workflow = env.client.workflow.getHandle(first!);
      const failure = await failureOf(workflow);

      expect(failure).toBeInstanceOf(Error);
      expect((await workflow.describe()).status.name).toBe('FAILED');
      await until(
        async () => task.recorded.runs.length,
        (runs) => runs >= 2,
      );
    } finally {
      await host.stop();
    }
  }, 60_000);
});

describe('run-now requests', () => {
  test('a request runs the task with its options while the schedule is paused, then clears', async () => {
    using _live = await createLiveTestDatabase();
    const task = recordingTask('requested', { everyMs: HOUR_MS, paused: true });
    const host = await hostFor([task]);
    try {
      await until(
        () => describeOrMissing(maintenanceScheduleId(task.id)),
        (schedule) => schedule?.state.paused === true,
      );

      await requestMaintenanceRun(task.id, { force: true });

      await (await startedRun(task.id)).result();
      expect(task.recorded.runs).toEqual([{ force: true }]);
      await until(pendingMaintenanceRuns, (pending) => pending.length === 0);
      expect((await describeSchedule(task.id)).state.paused).toBe(true);
    } finally {
      await host.stop();
    }
  }, 60_000);

  test('a request for a task the lane does not know fails for good', async () => {
    using _live = await createLiveTestDatabase();
    const host = await hostFor([recordingTask('known', { everyMs: HOUR_MS, paused: true })]);
    try {
      await requestMaintenanceRun('unknown');

      const failure = (await failureOf(await startedRun('unknown'))) as Error;
      const activityFailure = failure.cause as Error;

      expect(String(activityFailure.cause)).toContain('no maintenance task called unknown');
      await until(pendingMaintenanceRuns, (pending) => pending.length === 0);
    } finally {
      await host.stop();
    }
  }, 60_000);
});
