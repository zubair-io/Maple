/**
 * Hands job rows to Temporal. A route only ever inserts a `queued` row, in one
 * statement with its admission fence; this is the other half, and it runs in
 * the worker tier so a Temporal outage delays a job instead of losing it.
 */

import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { ObjectId } from '../db/object-id.ts';
import { cancelUnfinishedJob, heldJobIds, markJobDispatched, nextJobId } from './jobs.repo.ts';
import { dispatchJobSignal, JOB_TASK_QUEUE, jobWorkflowId } from './job-workflow.ts';
import { jobWorkflow } from '../temporal/workflows.ts';

/** Safe to repeat: a second dispatch signals the workflow that already exists. */
async function dispatchJob(client: Client, jobId: string): Promise<void> {
  await client.workflow.signalWithStart(jobWorkflow, {
    workflowId: jobWorkflowId(jobId),
    taskQueue: JOB_TASK_QUEUE,
    args: [jobId],
    signal: dispatchJobSignal,
  });
  await markJobDispatched(jobId);
}

/** The next job in creation order, once the one before it has finished. */
export async function relayNextJob(client: Client): Promise<void> {
  const jobId = await nextJobId();
  if (jobId !== null) await dispatchJob(client, jobId);
}

type WorkflowState = 'running' | 'stopped' | 'missing' | 'closed';

const STOPPED: ReadonlySet<string> = new Set(['TERMINATED', 'CANCELLED']);

async function workflowState(client: Client, jobId: string): Promise<WorkflowState> {
  try {
    const { status } = await client.workflow.getHandle(jobWorkflowId(jobId)).describe();
    if (status.name === 'RUNNING') return 'running';
    return STOPPED.has(status.name) ? 'stopped' : 'closed';
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return 'missing';
    throw error;
  }
}

/**
 * A held job whose workflow is no longer running would wait forever, and hold
 * everything queued behind it. Someone stopping the workflow in Temporal meant
 * to stop the job, so the row is cancelled. Anything else is a workflow that
 * was lost (a different or emptied server, an upgrade from the release whose
 * runner claimed rows itself) or closed without settling the row, and the job
 * is submitted again.
 */
async function reconcileJob(client: Client, jobId: string): Promise<void> {
  const state = await workflowState(client, jobId);
  if (state === 'stopped') await cancelUnfinishedJob(new ObjectId(jobId));
  if (state === 'missing' || state === 'closed') await dispatchJob(client, jobId);
}

export async function reconcileHeldJobs(client: Client): Promise<void> {
  for (const jobId of await heldJobIds()) await reconcileJob(client, jobId);
}
