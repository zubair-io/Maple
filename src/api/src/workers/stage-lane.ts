/**
 * Pipeline stages on Temporal. The database stays the record of what each
 * asset still needs (`stage_state`) and of whether a stage may run
 * (`worker_config`); Temporal only decides when a stage runs. Every relay tick
 * the lane asks each booted stage whether a claim would find anything, and
 * starts that stage's workflow if so. The workflow then runs the stage ten
 * seconds at a time, polling inside each slice the way the old loop did, until
 * a whole slice finds nothing, so a trickle of work keeps one workflow open
 * rather than opening a new one per file.
 *
 * While Temporal is unreachable nothing relays, so stages do not advance; the
 * rows wait in `stage_state` and Settings → Workers shows the connection.
 */

import { Context } from '@temporalio/activity';
import type { Client } from '@temporalio/client';
import type { TemporalLane } from '../temporal/temporal-lane.ts';
import { bootedStages } from './orchestrator.ts';
import type { RunStageHandle } from './run-stage.ts';
import { ALL_STAGE_NAMES } from './stages/stage-names.ts';
import {
  STAGE_TASK_QUEUE,
  type StageActivities,
  stageWorkflow,
  stageWorkflowId,
} from './stage-workflow.ts';

export type BootedStages = () => ReadonlyMap<string, RunStageHandle>;

/** Well inside the one-minute heartbeat timeout, so one slow batch is never mistaken for a lost worker. */
const HEARTBEAT_MS = 15_000;

/**
 * A slice ignores Temporal's cancellation on purpose: a claimed batch always
 * finishes its writeback. Only the stage's own `stop()` aborts its handlers.
 */
function createStageActivities(booted: BootedStages = bootedStages): StageActivities {
  return {
    runStageSlice: async (stage) => {
      const runner = booted().get(stage);
      if (runner === undefined) throw new Error(`The ${stage} stage has not started`);
      const context = Context.current();
      const heartbeat = setInterval(() => context.heartbeat(), HEARTBEAT_MS);
      try {
        return await runner.runSlice();
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}

/**
 * Starting a workflow that is already running is a no-op that writes no
 * history. A failed peek is the stage's own error, recorded on its row by
 * `hasWork`; only a failure to reach Temporal propagates to the host.
 */
async function relayStage(client: Client, runner: RunStageHandle): Promise<void> {
  if (runner.busy) return;
  if (runner.paused || !(await runner.hasWork())) {
    void runner.idle();
    return;
  }
  await client.workflow.start(stageWorkflow, {
    workflowId: stageWorkflowId(runner.name),
    taskQueue: STAGE_TASK_QUEUE,
    args: [runner.name],
    workflowIdConflictPolicy: 'USE_EXISTING',
  });
}

const failureOf = (work: Promise<void>): Promise<unknown> =>
  work.then(
    () => null,
    (error: unknown) => error,
  );

/** One stage failing to start does not hold the others back; the first failure is still reported. */
async function relayStages(client: Client, booted: BootedStages): Promise<void> {
  const failures = await Promise.all(
    [...booted().values()].map((runner) => failureOf(relayStage(client, runner))),
  );
  const failure = failures.find((error) => error !== null);
  if (failure !== undefined) throw failure;
}

/** Each stage runs at most one slice at a time; a stage's own concurrency lives inside its slice. */
export const stageLane = (booted: BootedStages = bootedStages): TemporalLane => ({
  taskQueue: STAGE_TASK_QUEUE,
  activities: createStageActivities(booted),
  concurrency: ALL_STAGE_NAMES.length,
  relay: (client) => relayStages(client, booted),
});
