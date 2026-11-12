/**
 * The workflow behind every maintenance run, scheduled or requested. This file
 * is bundled into Temporal's workflow sandbox, so it may import nothing but
 * `@temporalio/workflow` and types.
 */

import { proxyActivities } from '@temporalio/workflow';
import type { MaintenanceActivities } from './activity.ts';

export const MAINTENANCE_TASK_QUEUE = 'maple-maintenance';

/** What a requested run can ask of its pass beyond the scheduled one. */
export interface MaintenanceRunOptions {
  /** Run even when the task's own checks say nothing is due. */
  force?: boolean;
}

/**
 * One attempt: a failed pass shows as a failed run, and the next scheduled run
 * is its retry. The heartbeat is what carries a cancel to a long pass.
 */
const { runMaintenance } = proxyActivities<MaintenanceActivities>({
  startToCloseTimeout: '24 hours',
  heartbeatTimeout: '5 minutes',
  retry: { maximumAttempts: 1 },
});

export async function maintenanceWorkflow(
  taskId: string,
  options: MaintenanceRunOptions = {},
): Promise<void> {
  await runMaintenance(taskId, options);
}
