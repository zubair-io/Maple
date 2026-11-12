import { ApplicationFailure, Context } from '@temporalio/activity';
import type { MaintenanceTask } from './tasks.ts';
import type { MaintenanceRunOptions } from './workflow.ts';

/** Well inside the workflow's five-minute heartbeat timeout. */
const HEARTBEAT_MS = 30_000;

export interface MaintenanceActivities {
  runMaintenance: (taskId: string, options?: MaintenanceRunOptions) => Promise<void>;
}

/**
 * Runs one pass of the named task. Its signal fires when the worker shuts down
 * or the run is cancelled in Temporal, so a pass that can stop part-way does.
 */
export function createMaintenanceActivities(
  tasks: readonly MaintenanceTask[],
): MaintenanceActivities {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return {
    runMaintenance: async (taskId, options = {}) => {
      const task = byId.get(taskId);
      if (task === undefined)
        throw ApplicationFailure.nonRetryable(
          `There is no maintenance task called ${taskId}`,
          'UnknownMaintenanceTask',
        );
      const context = Context.current();
      const heartbeat = setInterval(() => context.heartbeat(), HEARTBEAT_MS);
      try {
        await task.run(context.cancellationSignal, options);
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
