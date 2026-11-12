/**
 * Hands rows to Temporal. A route only ever inserts or resets a waiting row;
 * this is the other half, and it runs in the worker tier so a Temporal outage
 * delays the work instead of losing it. Jobs and imports each describe their
 * table as a {@link RowQueue}, and the host runs one lane per queue.
 */

import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { dispatchSignal, type RowRun } from './row-workflow.ts';

export interface RowQueue {
  taskQueue: string;
  workflow: (rowId: string) => Promise<RowRun['outcome']>;
  workflowId: (rowId: string) => string;
  /** The oldest waiting row, once nothing else in the table is held. */
  nextId: () => Promise<string | null>;
  /** Rows Temporal holds: running, or waiting with their workflow already started. */
  heldIds: () => Promise<string[]>;
  markDispatched: (rowId: string) => Promise<void>;
  cancelUnfinished: (rowId: string) => Promise<void>;
}

/** One task queue served by the host: where its rows come from and what runs them. */
export interface TemporalLane {
  queue: RowQueue;
  activities: object;
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

/** The next row in creation order, once the one before it has finished. */
export async function relayNext(client: Client, queue: RowQueue): Promise<void> {
  const rowId = await queue.nextId();
  if (rowId !== null) await dispatch(client, queue, rowId);
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

export async function reconcileHeld(client: Client, queue: RowQueue): Promise<void> {
  for (const rowId of await queue.heldIds()) await reconcile(client, queue, rowId);
}
