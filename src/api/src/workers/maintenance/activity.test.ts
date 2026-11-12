/**
 * One pass of a task at a time in this process: scheduled runs that find their
 * task busy do nothing, run-now requests wait their turn.
 */

import { describe, expect, test } from 'bun:test';
import { MockActivityEnvironment } from '@temporalio/testing';
import { createMaintenanceActivities } from './activity.ts';
import { maintenanceRunNowId, maintenanceScheduleId } from './ids.ts';
import type { MaintenanceTask } from './tasks.ts';
import type { MaintenanceRunOptions } from './workflow.ts';

function gatedTask(id: string) {
  const runs: MaintenanceRunOptions[] = [];
  const gates: Array<PromiseWithResolvers<void>> = [];
  let inFlight = 0;
  let overlapped = false;
  const task: MaintenanceTask = {
    id,
    desired: async () => ({ everyMs: 60_000, paused: false }),
    run: async (_signal, options) => {
      inFlight += 1;
      overlapped ||= inFlight > 1;
      runs.push(options);
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      try {
        await gate.promise;
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { task, runs, gates, overlapped: () => overlapped };
}

const runIn = (workflowId: string, taskId: string, options?: MaintenanceRunOptions) => {
  const env = new MockActivityEnvironment({
    workflowExecution: { workflowId, runId: crypto.randomUUID() },
  });
  return {
    env,
    done: (activities: ReturnType<typeof createMaintenanceActivities>) =>
      env.run(activities.runMaintenance, taskId, options),
  };
};

const tick = () => Bun.sleep(5);

describe('one pass of a task at a time', () => {
  test('a scheduled run that finds its task running returns without running it', async () => {
    const { task, runs, gates, overlapped } = gatedTask('busy');
    const activities = createMaintenanceActivities([task]);
    const first = runIn(maintenanceScheduleId('busy'), 'busy').done(activities);
    await tick();

    await runIn(maintenanceScheduleId('busy'), 'busy').done(activities);

    expect(runs).toHaveLength(1);
    gates[0]!.resolve();
    await first;
    expect(overlapped()).toBe(false);
  });

  test('a run-now that finds its task running waits, then runs with its options', async () => {
    const { task, runs, gates, overlapped } = gatedTask('queued');
    const activities = createMaintenanceActivities([task]);
    const scheduled = runIn(maintenanceScheduleId('queued'), 'queued').done(activities);
    await tick();

    const requested = runIn(maintenanceRunNowId('queued'), 'queued', { force: true }).done(
      activities,
    );
    await tick();
    expect(runs).toEqual([{}]);

    gates[0]!.resolve();
    await scheduled;
    await tick();
    expect(runs).toEqual([{}, { force: true }]);
    gates[1]!.resolve();
    await requested;
    expect(overlapped()).toBe(false);
  });

  test('a waiting run-now gives up when its run is cancelled', async () => {
    const { task, runs, gates } = gatedTask('cancelled');
    const activities = createMaintenanceActivities([task]);
    const scheduled = runIn(maintenanceScheduleId('cancelled'), 'cancelled').done(activities);
    await tick();
    const waiting = runIn(maintenanceRunNowId('cancelled'), 'cancelled');
    const requested = waiting.done(activities).catch((error: unknown) => error);
    await tick();

    waiting.env.cancel();
    await requested;

    expect(runs).toHaveLength(1);
    gates[0]!.resolve();
    await scheduled;
  });

  test('another task is not held up by a busy one', async () => {
    const busy = gatedTask('slow');
    const free = gatedTask('quick');
    const activities = createMaintenanceActivities([busy.task, free.task]);
    const slow = runIn(maintenanceScheduleId('slow'), 'slow').done(activities);
    await tick();

    const quick = runIn(maintenanceScheduleId('quick'), 'quick').done(activities);
    await tick();
    expect(free.runs).toHaveLength(1);

    free.gates[0]!.resolve();
    busy.gates[0]!.resolve();
    await Promise.all([slow, quick]);
  });

  test('a failed pass frees its task for the next run', async () => {
    const failing: MaintenanceTask = {
      id: 'failing',
      desired: async () => ({ everyMs: 60_000, paused: false }),
      run: async () => {
        throw new Error('broke');
      },
    };
    const activities = createMaintenanceActivities([failing]);
    const run = () =>
      runIn(maintenanceScheduleId('failing'), 'failing')
        .done(activities)
        .catch((error: unknown) => error);

    expect(await run()).toBeInstanceOf(Error);
    expect(await run()).toBeInstanceOf(Error);
  });
});
