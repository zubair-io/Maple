/**
 * Throttled cross-process pause-state poller.
 *
 * Re-reads the worker's `paused` flag at most once per `intervalMs`, caching
 * the last-known value between reads. Used by the interval workers
 * (missing-reaper, migration) so a pause written by the API process takes
 * effect without IPC, and without a read on every tick.
 */

import { WorkerConfigRepo } from '../db/repos/worker-config.repo.ts';

/**
 * Returns a per-worker function answering the current paused state.
 *
 * The repository is constructed once and closed over rather than per read: it
 * holds no connection of its own — every call resolves the process-wide SQLite
 * handle — so there is nothing to keep warm, and one object per poller is
 * simply less work than one per tick.
 */
export function makePausedPoller(
  name: string,
  initialValue: boolean,
  intervalMs = 2000,
): () => Promise<boolean> {
  const repo = new WorkerConfigRepo();
  let cached = initialValue;
  let lastReadAt = 0;
  return async () => {
    const now = Date.now();
    if (now - lastReadAt >= intervalMs) {
      lastReadAt = now;
      try {
        const cfg = await repo.load(name);
        if (cfg !== null) cached = cfg.paused;
      } catch {
        /* keep cached value on error */
      }
    }
    return cached;
  };
}
