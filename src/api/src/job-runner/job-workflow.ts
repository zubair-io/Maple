/**
 * The workflow behind every job row. This file is bundled into Temporal's
 * workflow sandbox, so it may import nothing but `@temporalio/workflow` and types.
 */

import { proxyActivities } from '@temporalio/workflow';
import { ROW_ACTIVITY_OPTIONS, runRow, type RowRun } from '../temporal/row-workflow.ts';
import type { JobActivities } from './job-activity.ts';

export const JOB_TASK_QUEUE = 'maple-jobs';

export const jobWorkflowId = (jobId: string): string => `job-${jobId}`;

const { runJob } = proxyActivities<JobActivities>(ROW_ACTIVITY_OPTIONS);

export async function jobWorkflow(jobId: string): Promise<RowRun['outcome']> {
  return runRow(() => runJob(jobId), 'JobFailed');
}
