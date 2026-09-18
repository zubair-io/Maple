/**
 * Bun Worker entry point owning the clustering LOAD + COMPUTE stage against
 * SQLite (#3749) — the port of `people/cluster.worker.ts`.
 *
 * It runs on its own thread so that neither the O(N·D) embedding decode and
 * normalise nor the synchronous O(N·K·D) comparison pass ever blocks the HTTP
 * thread. It runs the same `prepareClusteringPass` the in-process fallback
 * runs, over the same rows, so moving it off-thread changes timing and nothing
 * else. Only a small serializable result crosses back: assignments, updated
 * centroids and per-face envelopes. The embeddings never leave this thread.
 *
 * ## What changed from the Mongo worker, and why it had to
 *
 * The Mongo worker opens its own database connection from parameters in the
 * dispatch message. Reproducing that here would give the clustering thread an
 * independent SQLite **writer**, and the pass does write — `recomputeCentroids`
 * persists refreshed centroids before the seeds are read back. Two writers is
 * exactly what the pool's single-writer design exists to prevent.
 *
 * So this worker takes a database *path*, not a connection: `createWorkerDb`
 * opens it read-only for queries and sends every write to the host thread,
 * which runs it on the pool's one writer. `worker-db.ts` has the full argument,
 * including why read-after-write still works across that split.
 *
 * The handle is built once and kept for the life of the worker. The coordinator
 * guarantees one pass at a time, so there is no concurrent use to reason about,
 * and holding the reader open avoids reopening the file every pass.
 */

import { createWorkerDb, type MessageChannelLike, type WorkerDb } from '../worker-db.ts';
import { prepareClusteringPass } from './people.cluster-load.ts';
import type { PreparedClusteringPass } from './people.cluster-load.ts';

/** What the host sends to start a pass. */
interface PrepareRequest {
  type: 'prepare';
  id: number;
  similarityThreshold: number;
  /** The database file. A path, deliberately — never a connection. */
  path: string;
}

const channel = self as unknown as MessageChannelLike;

/** The handle, and the path it was opened for. */
let handle: { path: string; db: WorkerDb } | null = null;

/**
 * The worker's database handle for `path`.
 *
 * A path change only happens between test files — production fixes the database
 * at boot — but when it does the old reader is closed rather than silently
 * reused, which is what keeps two test databases from bleeding into each other.
 */
function databaseFor(path: string): WorkerDb {
  if (handle && handle.path === path) return handle.db;
  handle?.db.close();
  const db = createWorkerDb(path, channel);
  handle = { path, db };
  return db;
}

self.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as PrepareRequest | undefined;
  if (message?.type !== 'prepare') return;
  void runPrepare(message);
});

async function runPrepare(message: PrepareRequest): Promise<void> {
  try {
    const db = databaseFor(message.path);
    const result: PreparedClusteringPass = await prepareClusteringPass(
      message.similarityThreshold,
      db,
    );
    self.postMessage({ type: 'prepare', id: message.id, ok: true, result });
  } catch (error) {
    self.postMessage({
      type: 'prepare',
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
