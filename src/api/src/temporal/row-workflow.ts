/**
 * The shape every row-backed workflow shares: one activity runs the row, and
 * the workflow ends the way the row did. This file is bundled into Temporal's
 * workflow sandbox, so it may import nothing but `@temporalio/workflow` and types.
 */

import {
  ActivityCancellationType,
  ApplicationFailure,
  defineSignal,
  setHandler,
  type ActivityOptions,
} from '@temporalio/workflow';

/** How the row stands once an activity attempt returns. */
export type RowRun = { outcome: 'done' | 'cancelled' } | { outcome: 'failed'; error: string };

/** Sent with every dispatch, including the one that starts the workflow. */
export const dispatchSignal = defineSignal('dispatch');

export const ROW_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: '7 days',
  heartbeatTimeout: '5 minutes',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '1 minute' },
};

/**
 * A row resumed in the instant its previous run is finishing would otherwise be
 * signalled into a workflow that is about to close and never run. Running again
 * for a dispatch that arrived mid-run closes that gap; for a row that has
 * finished, the extra pass only reports how.
 */
async function runUntilSettled(
  run: () => Promise<RowRun>,
  dispatch: { pending: boolean },
): Promise<RowRun> {
  dispatch.pending = false;
  const settled = await run();
  return dispatch.pending ? runUntilSettled(run, dispatch) : settled;
}

/** Ends the way the row did, so Temporal's own list tells failed rows from finished ones. */
export async function runRow(
  run: () => Promise<RowRun>,
  failureType: string,
): Promise<RowRun['outcome']> {
  const dispatch = { pending: false };
  setHandler(dispatchSignal, () => {
    dispatch.pending = true;
  });
  const settled = await runUntilSettled(run, dispatch);
  if (settled.outcome === 'failed')
    throw ApplicationFailure.nonRetryable(settled.error, failureType);
  return settled.outcome;
}
