/**
 * The workflow that drains one pipeline stage: it runs the stage a slice at a
 * time until a slice finds nothing left, then completes. This file is bundled
 * into Temporal's workflow sandbox, so it may import nothing but
 * `@temporalio/workflow` and types.
 */

import { continueAsNew, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { StageActivities } from './stage-lane.ts';

export const STAGE_TASK_QUEUE = 'maple-stages';

export const stageWorkflowId = (stage: string): string => `stage-${stage}`;

/** What one slice did: how many rows its claims touched, and whether the last claim came back empty. */
export interface StageSlice {
  claimed: number;
  drained: boolean;
}

/** Keeps a stage with a backlog of millions from growing one history without bound. */
const SLICES_PER_RUN = 500;

/**
 * A slice runs for about ten seconds, and a single batch may run far longer, so
 * the heartbeat, not the start-to-close timeout, is what notices a lost worker.
 * Retries back off from one second to thirty and never give up: a claim that
 * fails is a database or stage problem the operator sees on Settings → Workers.
 */
const { runStageSlice } = proxyActivities<StageActivities>({
  startToCloseTimeout: '7 days',
  heartbeatTimeout: '5 minutes',
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds' },
});

const runEnded = (slices: number): boolean =>
  slices >= SLICES_PER_RUN || workflowInfo().continueAsNewSuggested;

/** Resolves `true` once the stage drained, `false` when this run should hand over to a new one. */
async function sliceUntilDrained(stage: string, slices: number): Promise<boolean> {
  const { drained } = await runStageSlice(stage);
  if (drained) return true;
  return runEnded(slices + 1) ? false : sliceUntilDrained(stage, slices + 1);
}

export async function stageWorkflow(stage: string): Promise<void> {
  const drained = await sliceUntilDrained(stage, 0);
  if (!drained) await continueAsNew<typeof stageWorkflow>(stage);
}
