/**
 * Retrying a write that lost the file lock — the one failure mode two
 * processes on one SQLite file introduces (#3752).
 *
 * ## The problem this exists for
 *
 * The pool guarantees single-writer ordering *within* a process: one writer
 * thread, requests executed in call order, so two callers in the API can never
 * collide. After the cutover there are two processes — the API and the worker
 * child it spawns — and that guarantee does not span them. Across processes the
 * arbitration is SQLite's own: the second writer to ask for the `RESERVED` lock
 * waits for `busy_timeout` and then fails with `SQLITE_BUSY`.
 *
 * Every throughput figure in this epic was measured in one process, so the
 * honest position is that the steady-state contention is not known. What *is*
 * known is its shape: the worker tier writes in bounded batches (stage
 * writeback commits per batch, the importer per transaction), so a lock is held
 * for the length of one batch rather than one stage's run. The 5-second
 * `busy_timeout` the pool sets already absorbs anything of that length. This
 * ladder covers the tail beyond it.
 *
 * ## Why the retry lives here rather than at each call site
 *
 * The change feed carried its own copy first, because it was the first writer
 * that could be interrupted mid-batch by the worker tier. Every repository has
 * that property now, so the retry belongs to the primitive both processes go
 * through — `SqlitePool.write` and `SqlitePool.transaction` — and not to
 * whichever repository happened to notice first.
 *
 * ## Why retrying is safe
 *
 * Both primitives are atomic. A single statement either applied or did not; a
 * transaction runs inside `BEGIN IMMEDIATE`/`COMMIT` and a failure rolls the
 * whole batch back. So a retry starts from exactly the state the first attempt
 * started from, and re-running it cannot double-apply. This is *only* true of
 * lock contention: a constraint violation or a closed pool fails identically
 * every time, and retrying those would turn one log line into four.
 *
 * ## Why this module does not log, though it would like to
 *
 * It has no import of `log.ts`, and must not grow one. `pool.ts` imports this
 * module, and the clustering worker (`repos/people.cluster.worker.ts`) reaches
 * `pool.ts` through `worker-db.ts` — so anything imported here is loaded inside
 * a `Worker` thread. Importing pino there wedges the thread: the worker never
 * answers its first message and the caller waits forever. Measured by adding a
 * one-line `log.warn` to this file, which took `people.cluster-pool.test.ts`
 * from 214 ms to a hard timeout, and removing it again.
 *
 * A retry that succeeds is therefore silent, and a retry that exhausts the
 * ladder throws, which the caller logs where it already has a logger — see
 * `recordAssetChangeRow` in `repos/changes.repo.ts`.
 */

/**
 * Backoff between attempts, in milliseconds. Three retries spanning ~525 ms.
 *
 * Sized against the lock holder rather than against the clock: a worker batch
 * that has already outlasted the pool's 5-second `busy_timeout` is either
 * finishing imminently or is a batch that should have been smaller, and half a
 * second of retries distinguishes the two without hiding the second case.
 */
const BUSY_RETRY_DELAYS_MS = [25, 100, 400] as const;

/**
 * Whether a failed write is worth attempting again.
 *
 * Matching on the message rather than on a code is what the pool leaves
 * available: an `Error` does not structured-clone across the worker boundary,
 * so `worker-handle.ts` flattens the driver's error into text with the SQLite
 * code appended. Both spellings are checked — the code for the pool path, the
 * driver's own wording for a test or the importer driving `bun:sqlite` direct.
 */
export function isBusyError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(text);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt`, and runs it again while the writer is locked by another
 * process.
 *
 * Exhausting the ladder rethrows the last error: a lock held for longer than
 * five and a half seconds is a real problem, and swallowing it would only move
 * the symptom somewhere harder to find.
 */
export async function retryOnBusy<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 0; ; tries++) {
    try {
      return await attempt();
    } catch (err) {
      const delay = isBusyError(err) ? BUSY_RETRY_DELAYS_MS[tries] : undefined;
      if (delay === undefined) throw err;
      await sleep(delay);
    }
  }
}
