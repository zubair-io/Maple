import { ObjectId } from '../db/object-id.ts';
import type { RowQueue, TemporalLane } from '../temporal/row-queue.ts';
import { jobWorkflow } from '../temporal/workflows.ts';
import type { ExecuteJobOptions } from './execute-job.ts';
import { createJobActivities } from './job-activity.ts';
import { JOB_TASK_QUEUE, jobWorkflowId } from './job-workflow.ts';
import { cancelUnfinishedJob, heldJobIds, markJobDispatched, nextJobId } from './jobs.repo.ts';

const JOB_QUEUE: RowQueue = {
  taskQueue: JOB_TASK_QUEUE,
  workflow: jobWorkflow,
  workflowId: jobWorkflowId,
  nextId: () => nextJobId(),
  heldIds: () => heldJobIds(),
  markDispatched: (jobId) => markJobDispatched(jobId),
  cancelUnfinished: (jobId) => cancelUnfinishedJob(new ObjectId(jobId)),
};

export const jobLane = (options: ExecuteJobOptions = {}): TemporalLane => ({
  queue: JOB_QUEUE,
  activities: createJobActivities(options),
});
