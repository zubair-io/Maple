import { setTimeout as sleep } from 'node:timers/promises';
import { nextOperationId } from '../db/repos/operations.repo.ts';
import { recordedAttempt } from '../temporal/recorded-attempt.test-helpers.ts';
import { executeJob, type ExecuteJobOptions } from './execute-job.ts';
import { markJobDispatched } from './jobs.repo.ts';
import { setOperationWaitForTests } from './operations.ts';

/**
 * Runs `work` — typically a route request that starts an operation and waits
 * for it — while operation rows are run the way the operations lane runs them,
 * minus Temporal: relayed in creation order, each executed as one attempt.
 */
export async function withOperationsRunning<T>(
  work: () => Promise<T>,
  options: ExecuteJobOptions = {},
): Promise<T> {
  setOperationWaitForTests({ timeoutMs: 30_000, intervalMs: 5 });
  const state = { settled: false };
  const drain = async (): Promise<void> => {
    if (state.settled) return;
    const id = await nextOperationId();
    if (id === null) await sleep(5);
    else {
      await markJobDispatched(id);
      await executeJob(id, recordedAttempt(`test:${id}`), options);
    }
    return drain();
  };
  try {
    const running = work().finally(() => {
      state.settled = true;
    });
    const [result] = await Promise.all([running, drain()]);
    return result;
  } finally {
    state.settled = true;
    setOperationWaitForTests(null);
  }
}
