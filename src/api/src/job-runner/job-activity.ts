import { ApplicationFailure, Context } from '@temporalio/activity';
import {
  executeJob,
  UnknownJobError,
  type AttemptStop,
  type ExecuteJobOptions,
  type JobRun,
} from './execute-job.ts';

export type { JobRun } from './execute-job.ts';

export interface JobActivities {
  runJob: (jobId: string) => Promise<JobRun>;
}

/**
 * Only three things stop a handler: a cancel, and an operator pausing or
 * resetting the activity. A worker shutting down does not, and neither does
 * Temporal giving up on the attempt after losing contact with it. A healthy
 * handler finishes its job either way; if it is in fact gone, the attempt
 * Temporal sends next takes the row over and the fence stops this one.
 */
export function attemptStop(details: Context['cancellationDetails']): AttemptStop | null {
  if (details === undefined) return null;
  if (details.cancelRequested) return 'cancel';
  return details.paused || details.reset ? 'superseded' : null;
}

export function createJobActivities(options: ExecuteJobOptions = {}): JobActivities {
  return {
    runJob: async (jobId) => {
      const context = Context.current();
      const { workflowExecution, activityId, attempt } = context.info;
      try {
        return await executeJob(
          jobId,
          {
            identity: `temporal:${workflowExecution?.runId}:${activityId}:${attempt}`,
            heartbeat: (progress) => context.heartbeat(progress),
            stopReason: () => attemptStop(context.cancellationDetails),
          },
          options,
        );
      } catch (error) {
        if (error instanceof UnknownJobError) throw ApplicationFailure.nonRetryable(error.message);
        throw error;
      }
    },
  };
}
