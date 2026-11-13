import { ApplicationFailure, Context } from '@temporalio/activity';
import { maintenanceRunNowId } from './ids.ts';
import type { MaintenanceTask } from './tasks.ts';
import type { MaintenanceRunOptions } from './workflow.ts';

/** Well inside the workflow's five-minute heartbeat timeout. */
const HEARTBEAT_MS = 30_000;

export interface MaintenanceActivities {
  runMaintenance: (taskId: string, options?: MaintenanceRunOptions) => Promise<void>;
}

const settled = (pass: Promise<void>): Promise<void> =>
  pass.then(
    () => undefined,
    () => undefined,
  );

const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/**
 * Runs one pass of the named task, never beside another pass of the same task
 * in this process. Temporal can start a run while an earlier one is still
 * going here — after that run was terminated, or after the worker lost the
 * server for longer than the heartbeat timeout — and most passes cannot be
 * stopped part-way. A scheduled run that finds its task busy does nothing,
 * since the next one is never far off; a run-now waits its turn, so an
 * operator's request is never dropped.
 *
 * The signal fires when the worker shuts down or the run is cancelled in
 * Temporal, so a pass stops at its next safe point.
 */
export function createMaintenanceActivities(
  tasks: readonly MaintenanceTask[],
): MaintenanceActivities {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const running = new Map<string, Promise<void>>();

  async function runAlone(
    task: MaintenanceTask,
    waitTurn: boolean,
    signal: AbortSignal,
    options: MaintenanceRunOptions,
  ): Promise<void> {
    for (let busy = running.get(task.id); busy; busy = running.get(task.id)) {
      if (!waitTurn) return;
      await Promise.race([settled(busy), aborted(signal)]);
      if (signal.aborted) return;
    }
    const pass = task.run(signal, options);
    running.set(task.id, pass);
    try {
      await pass;
    } finally {
      running.delete(task.id);
    }
  }

  return {
    runMaintenance: async (taskId, options = {}) => {
      const task = byId.get(taskId);
      if (task === undefined)
        throw ApplicationFailure.nonRetryable(
          `There is no maintenance task called ${taskId}`,
          'UnknownMaintenanceTask',
        );
      const context = Context.current();
      const runNow = context.info.workflowExecution?.workflowId === maintenanceRunNowId(taskId);
      const heartbeat = setInterval(() => context.heartbeat(), HEARTBEAT_MS);
      try {
        await runAlone(task, runNow, context.cancellationSignal, options);
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
