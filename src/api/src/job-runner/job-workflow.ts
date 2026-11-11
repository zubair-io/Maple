/**
 * The workflow behind every job row. This file is bundled into Temporal's
 * workflow sandbox, so it may import nothing but `@temporalio/workflow` and types.
 */

import {
  ActivityCancellationType,
  ApplicationFailure,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { JobActivities, JobRun } from './job-activity.ts';

export const JOB_TASK_QUEUE = 'maple-jobs';

export const jobWorkflowId = (jobId: string): string => `job-${jobId}`;

/** Sent with every dispatch, including the one that starts the workflow. */
export const dispatchJobSignal = defineSignal('dispatch');

const { runJob } = proxyActivities<JobActivities>({
  startToCloseTimeout: '7 days',
  heartbeatTimeout: '5 minutes',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '1 minute' },
});

/**
 * A job resumed in the instant its previous run is finishing would otherwise be
 * signalled into a workflow that is about to close and never run. Running again
 * for a dispatch that arrived mid-run closes that gap; for a job that has
 * finished, the extra pass only reports how.
 */
async function runUntilSettled(jobId: string, dispatch: { pending: boolean }): Promise<JobRun> {
  dispatch.pending = false;
  const run = await runJob(jobId);
  return dispatch.pending ? runUntilSettled(jobId, dispatch) : run;
}

/** Ends the way the job did, so Temporal's own list tells failed jobs from finished ones. */
export async function jobWorkflow(jobId: string): Promise<JobRun['outcome']> {
  const dispatch = { pending: false };
  setHandler(dispatchJobSignal, () => {
    dispatch.pending = true;
  });
  const run = await runUntilSettled(jobId, dispatch);
  if (run.outcome === 'failed') throw ApplicationFailure.nonRetryable(run.error, 'JobFailed');
  return run.outcome;
}
