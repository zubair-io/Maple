/**
 * Keep the describe stage's dispatch fan-out equal to the total capacity of
 * its configured servers.
 *
 * Describe is the one stage whose concurrency is not an independent knob:
 * each server carries its own concurrency (Settings → Workers → Describe),
 * and the pool in `describe-server-pool.ts` enforces those per-server
 * limits. The stage-level number only decides how many claimed assets are
 * dispatched at once, so anything other than the sum is a bug — too high
 * and assets hold a lease queued for admission, too low and servers idle
 * with backlog waiting.
 *
 * Called from `applyDescribeConfig`, which runs both in the API process on
 * save and in the worker process's config-refresh loop, so the derived
 * value converges no matter which process notices the change first.
 */

import { getDb } from '../db/client.ts';
import { child as childLogger } from '../log.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';

const log = childLogger('describe:capacity');

export async function syncDescribeStageCapacity(capacity: number): Promise<void> {
  try {
    const db = await getDb();
    const repo = new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config'));
    const current = await repo.load('describe');
    if (current?.concurrency === capacity) return;
    await repo.patch('describe', { concurrency: capacity });
    log.info({ capacity }, 'describe stage concurrency synced to total server capacity');
  } catch (err) {
    // Best-effort: a DB hiccup here must never stop the describe config
    // from being applied. The next refresh tick retries.
    log.warn({ err }, 'failed to sync describe stage concurrency');
  }
}
