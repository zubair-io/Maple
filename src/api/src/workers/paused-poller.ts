/**
 * Throttled cross-process pause-state poller.
 *
 * Re-reads `worker_config.<name>.paused` from Mongo at most once per
 * `intervalMs`, caching the last-known value between reads. Used by interval
 * workers (missing-reaper, migration) so a pause written by the API process
 * takes effect without IPC, without hammering Mongo on every tick.
 */

import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';

/** Returns a per-worker function that returns the current paused state.
 * Caches the result and only re-reads Mongo once per `intervalMs`. */
export function makePausedPoller(
  name: string,
  initialValue: boolean,
  intervalMs = 2000,
): () => Promise<boolean> {
  let cached = initialValue;
  let lastReadAt = 0;
  return async () => {
    const now = Date.now();
    if (now - lastReadAt >= intervalMs) {
      lastReadAt = now;
      try {
        const { getDb } = await import('../db/client.ts');
        const db = await getDb();
        const repo = new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config'));
        const cfg = await repo.load(name);
        if (cfg !== null) cached = cfg.paused;
      } catch {
        /* keep cached value on error */
      }
    }
    return cached;
  };
}
