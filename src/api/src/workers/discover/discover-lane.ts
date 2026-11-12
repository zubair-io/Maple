/**
 * The discover sweep as a Temporal lane: one long-lived workflow per library
 * root. Nothing waits in a table to be relayed; the connection check makes sure
 * every registered root has its workflow, which is how a folder added while the
 * server runs starts sweeping, and how a workflow stopped in Temporal comes back.
 * Pausing is the `discover` switch on Settings → Workers, which every slice reads.
 */

import type { Client } from '@temporalio/client';
import { listLibraryRoots } from '../../db/repos/folders.repo.ts';
import type { TemporalLane } from '../../temporal/temporal-lane.ts';
import { createDiscoverActivities, type DiscoverSliceOptions } from './discover-activity.ts';
import { DISCOVER_TASK_QUEUE, discoverWorkflow, discoverWorkflowId } from './discover-workflow.ts';

/**
 * Fixed when the worker is created, so it is set well above any real library
 * count rather than read from the roots. A slot costs little: a slice spends
 * most of its time paced between directories. Past this many roots the slices
 * take turns, since each one ends within ten minutes and frees its slot.
 */
const DISCOVER_CONCURRENCY = 64;

/** Starting a workflow that is already running is a no-op, so this is safe every check. */
async function ensureEveryRootSweeps(client: Client): Promise<void> {
  for (const library of await listLibraryRoots()) {
    const rootKey = library.id.toHexString();
    await client.workflow.start(discoverWorkflow, {
      workflowId: discoverWorkflowId(rootKey),
      taskQueue: DISCOVER_TASK_QUEUE,
      args: [rootKey],
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
  }
}

export const discoverLane = (options: DiscoverSliceOptions = {}): TemporalLane => ({
  taskQueue: DISCOVER_TASK_QUEUE,
  activities: createDiscoverActivities(options),
  concurrency: DISCOVER_CONCURRENCY,
  reconcile: ensureEveryRootSweeps,
});
