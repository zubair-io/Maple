/**
 * One workflow per library root, sweeping it one slice after another for as
 * long as the root stays registered. This file is bundled into Temporal's
 * workflow sandbox, so it may import nothing but `@temporalio/workflow` and types.
 */

import { continueAsNew, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { DiscoverActivities } from './discover-activity.ts';

export const DISCOVER_TASK_QUEUE = 'maple-discover';

export const discoverWorkflowId = (rootKey: string): string => `discover-${rootKey}`;

/** Keeps each run's history short even when the server never suggests a new run. */
const SLICES_PER_RUN = 100;

const { sweepRoot } = proxyActivities<DiscoverActivities>({
  startToCloseTimeout: '1 hour',
  heartbeatTimeout: '5 minutes',
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds' },
});

async function sweepSlices(rootKey: string, left: number): Promise<'gone' | 'renew'> {
  const slice = await sweepRoot(rootKey);
  if (!slice.registered) return 'gone';
  if (left <= 1 || workflowInfo().continueAsNewSuggested) return 'renew';
  return sweepSlices(rootKey, left - 1);
}

export async function discoverWorkflow(rootKey: string): Promise<'gone'> {
  const ended = await sweepSlices(rootKey, SLICES_PER_RUN);
  if (ended === 'renew') await continueAsNew<typeof discoverWorkflow>(rootKey);
  return 'gone';
}
