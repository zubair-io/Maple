import { runAttempt } from '../temporal/activity-attempt.ts';
import type { RowRun } from '../temporal/row-workflow.ts';
import { executeJob, type ExecuteJobOptions } from './execute-job.ts';

export interface JobActivities {
  runJob: (jobId: string) => Promise<RowRun>;
}

export function createJobActivities(options: ExecuteJobOptions = {}): JobActivities {
  return { runJob: (jobId) => runAttempt((attempt) => executeJob(jobId, attempt, options)) };
}
