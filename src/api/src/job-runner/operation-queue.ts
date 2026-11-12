/**
 * The operations lane: operator one-shots (mirror reconcile, people
 * clustering, folder scans) are job rows, but they never queue behind a user's
 * export or stitch. They share the job workflow and activity, on a task queue
 * of their own.
 */

import { ObjectId } from '../db/object-id.ts';
import { heldOperationIds, nextOperationId } from '../db/repos/operations.repo.ts';
import { rowLane, type RowQueue } from '../temporal/row-queue.ts';
import type { TemporalLane } from '../temporal/temporal-lane.ts';
import type { ExecuteJobOptions } from './execute-job.ts';
import { createJobActivities } from './job-activity.ts';
import { jobWorkflow, jobWorkflowId } from './job-workflow.ts';
import { cancelUnfinishedJob, markJobDispatched } from './jobs.repo.ts';

const OPERATION_TASK_QUEUE = 'maple-operations';

/**
 * The database allows one active reconcile, one clustering and one scan per
 * folder; this only bounds how many run at once. Four leaves a reconcile and a
 * clustering room beside two folder scans; a further scan waits in Temporal
 * for a slot.
 */
const OPERATION_CONCURRENCY = 4;

const OPERATION_QUEUE: RowQueue = {
  taskQueue: OPERATION_TASK_QUEUE,
  workflow: jobWorkflow,
  workflowId: jobWorkflowId,
  nextId: () => nextOperationId(),
  heldIds: () => heldOperationIds(),
  markDispatched: (jobId) => markJobDispatched(jobId),
  cancelUnfinished: (jobId) => cancelUnfinishedJob(new ObjectId(jobId)),
};

export const operationLane = (options: ExecuteJobOptions = {}): TemporalLane =>
  rowLane(OPERATION_QUEUE, createJobActivities(options), OPERATION_CONCURRENCY);
