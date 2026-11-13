/**
 * Hands rows to Temporal. A route only ever inserts or resets a waiting row;
 * this is the other half, and it runs in the worker tier so a Temporal outage
 * delays the work instead of losing it. Jobs, operator one-shots and imports
 * each describe their rows as a {@link RowQueue}, and the host runs one lane
 * per queue.
 */

import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { dispatchSignal, type RowRun } from './row-workflow.ts';
import type { TemporalLane } from './temporal-lane.ts';

export interface RowQueue {
  taskQueue: string;
  workflow: (rowId: string) => Promise<RowRun['outcome']>;
  workflowId: (rowId: string) => string;
  /** The oldest waiting row the lane may start now; null while it must wait. */
  nextId: () => Promise<string | null>;
  /** Rows Temporal holds: running, or waiting with their workflow already started. */
  heldIds: () => Promise<string[]>;
  markDispatched: (rowId: string) => Promise<void>;
  cancelUnfinished: (rowId: string) => Promise<void>;
}

/** Safe to repeat: a second dispatch signals the workflow that already exists. */
async function dispatch(client: Client, queue: RowQueue, rowId: string): Promise<void> {
  await client.workflow.signalWithStart(queue.workflow, {
    workflowId: queue.workflowId(rowId),
    taskQueue: queue.taskQueue,
    args: [rowId],
    signal: dispatchSignal,
  });
  await queue.markDispatched(rowId);
}

/**
 * Every row the queue lets start, in creation order. A queue that runs one row
 * at a time answers null once it has handed one over; the guard stops a row
 * that could not be marked from being dispatched in a loop.
 */
async function relayReady(
  client: Client,
  queue: RowQueue,
  previous: string | null = null,
): Promise<void> {
  const rowId = await queue.nextId();
  if (rowId === null || rowId === previous) return;
  await dispatch(client, queue, rowId);
  await relayReady(client, queue, rowId);
}

type WorkflowState = 'running' | 'stopped' | 'missing' | 'closed';

const STOPPED: ReadonlySet<string> = new Set(['TERMINATED', 'CANCELLED']);

async function workflowState(
  client: Client,
  queue: RowQueue,
  rowId: string,
): Promise<WorkflowState> {
  try {
    const { status } = await client.workflow.getHandle(queue.workflowId(rowId)).describe();
    if (status.name === 'RUNNING') return 'running';
    return STOPPED.has(status.name) ? 'stopped' : 'closed';
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return 'missing';
    throw error;
  }
}

/**
 * A held row whose workflow is no longer running would wait forever, and hold
 * everything waiting behind it. Someone stopping the workflow in Temporal meant
 * to stop the work, so the row is cancelled. Anything else is a workflow that
 * was lost (a different or emptied server, an upgrade from the release whose
 * runner claimed rows itself) or closed without settling the row, and the row
 * is submitted again.
 */
async function reconcile(client: Client, queue: RowQueue, rowId: string): Promise<void> {
  const state = await workflowState(client, queue, rowId);
  if (state === 'stopped') await queue.cancelUnfinished(rowId);
  if (state === 'missing' || state === 'closed') await dispatch(client, queue, rowId);
}

async function reconcileHeld(client: Client, queue: RowQueue): Promise<void> {
  for (const rowId of await queue.heldIds()) await reconcile(client, queue, rowId);
}

/**
 * One row at a time by default: exports and stitches saturate the native pool
 * on their own, and pano admission counts on a preview never running beside a
 * stitch. A queue whose rows may overlap says how many run at once.
 */
export const rowLane = (queue: RowQueue, activities: object, concurrency = 1): TemporalLane => ({
  taskQueue: queue.taskQueue,
  activities,
  concurrency,
  relay: (client) => relayReady(client, queue),
  reconcile: (client) => reconcileHeld(client, queue),
});
