/**
 * Single-worker clustering pool over SQLite (#3749).
 *
 * One worker, not several: the online pass is inherently sequential, because a
 * face competes against every cluster the faces before it opened, so sharding it
 * across threads would change the answer. The coordinator already guarantees a
 * single pass at a time, so one lazily spawned worker that lives for the process
 * is exactly enough.
 *
 * ## The two pools, and why they are not the same pool
 *
 * There are now two worker pools in the process: this one, which owns clustering
 * CPU, and the database pool, which owns SQLite connections. The interaction
 * between them is the thing this slice had to get right rather than inherit.
 *
 * The clustering worker does **not** open its own writable connection, the way
 * the Mongo worker opens its own Mongo handle. It reads through a read-only
 * connection of its own and sends every write to this thread, where
 * `serveWorkerDbRequests` runs it on the database pool's single writer. So the
 * clustering pool consumes the database pool rather than bypassing it, and the
 * "exactly one writer" invariant holds with two pools in play.
 *
 * ## The fallback
 *
 * When no Worker can spawn — an unsupported runtime, a restricted sandbox —
 * the same stage runs in-process against the pool directly. That reintroduces
 * the event-loop block the worker exists to avoid, which is why it is reported
 * through `viaWorker` rather than left for a caller to infer from timing, but
 * it is correct: the same core over the same rows in the same order.
 */

import { child as childLogger } from '../../../log.ts';
import { DEFAULT_SIMILARITY_THRESHOLD } from '../../../people/cluster-embeddings.ts';
import { sqlitePool } from '../index.ts';
import { serveWorkerDbRequests, type MessageChannelLike } from '../worker-db.ts';
import { prepareClusteringPass } from './people.cluster-load.ts';
import type { PreparedClusteringPass } from '../../../people/cluster-load.ts';
import type { SqliteDb } from './db-handle.ts';

const log = childLogger('people:cluster-pool:sqlite');

/**
 * A prepared pass plus how it was produced. `viaWorker` is true when the load
 * and compute genuinely ran on the worker thread, false when it degraded to the
 * in-process path — the only way to tell the two apart, since their output is
 * identical by design.
 */
export interface PrepareResult {
  pass: PreparedClusteringPass;
  viaWorker: boolean;
}

/** Where the worker should open its read-only connection, and what to cluster. */
interface ClusterDispatch {
  path: string;
  similarityThreshold: number;
}

interface PrepareResponse {
  type: 'prepare';
  id: number;
  ok: boolean;
  result?: PreparedClusteringPass;
  error?: string;
}

interface PendingCall {
  resolve: (pass: PreparedClusteringPass) => void;
  reject: (error: Error) => void;
}

class ClusterWorkerPool {
  private worker: Worker | null = null;
  private detachDb: (() => void) | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private spawnFailed = false;

  /**
   * Spawn the worker and wire it to the database pool, or throw so the caller
   * can fall back to running in-process.
   */
  private ensureWorker(db: SqliteDb): Worker {
    if (this.worker) return this.worker;
    if (this.spawnFailed) throw new Error('cluster-pool: worker previously failed to start');

    const spawned = this.spawn();
    // Attached before the first dispatch: the worker's very first act may be a
    // write, and a request that arrives with nobody serving it simply waits.
    this.detachDb = serveWorkerDbRequests(spawned as unknown as MessageChannelLike, db);

    spawned.addEventListener('message', (event) => {
      const message = event.data as PrepareResponse | undefined;
      if (message?.type !== 'prepare') return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      // Deferred by one macrotask for the Bun 1.4.3 message-drop bug — a pass
      // makes several round trips before this one, so settling synchronously
      // here is exactly the shape that triggers it. See `worker-db.ts`.
      setImmediate(() => {
        if (message.ok && message.result) waiter.resolve(message.result);
        else waiter.reject(new Error(message.error ?? 'cluster-pool: clustering failed'));
      });
    });

    spawned.addEventListener('error', (event) => {
      // Fail every in-flight call rather than let callers hang; the next
      // request spawns a fresh worker.
      const error = new Error(`cluster-pool: worker errored — ${event.message || 'unknown'}`);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
      this.dispose();
    });

    this.worker = spawned;
    return spawned;
  }

  private spawn(): Worker {
    try {
      return new Worker(new URL('./people.cluster.worker.ts', import.meta.url).href);
    } catch (error) {
      this.spawnFailed = true;
      throw new Error(
        `cluster-pool: failed to spawn worker — ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private dispose(): void {
    this.detachDb?.();
    this.detachDb = null;
    this.worker?.terminate();
    this.worker = null;
  }

  /** Dispatch one pass, or run it in-process when no worker is available. */
  run(dispatch: ClusterDispatch, db: SqliteDb): Promise<PrepareResult> {
    const worker = ((): Worker | null => {
      try {
        return this.ensureWorker(db);
      } catch (error) {
        log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'cluster worker unavailable — clustering in-process (blocks the event loop)',
        );
        return null;
      }
    })();

    if (!worker) {
      return prepareClusteringPass(dispatch.similarityThreshold, db).then((pass) => ({
        pass,
        viaWorker: false,
      }));
    }

    const id = this.nextId++;
    return new Promise<PreparedClusteringPass>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        // Only the threshold and the database path cross here. The worker opens
        // its own read-only connection and reads the embeddings itself, which
        // is what keeps them off `postMessage` entirely.
        worker.postMessage({ type: 'prepare', id, ...dispatch });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).then((pass) => ({ pass, viaWorker: true }));
  }

  /** Terminate the worker and stop serving its database requests. */
  shutdown(): void {
    this.dispose();
  }
}

let pool: ClusterWorkerPool | null = null;

function clusterPool(): ClusterWorkerPool {
  if (!pool) pool = new ClusterWorkerPool();
  return pool;
}

/**
 * Run the full clustering load + compute stage off the main thread.
 *
 * `dbOverride` is the tests' seam and, in the worker case, decides where the
 * worker's writes land; production passes nothing and gets the process-wide
 * pool. When an override is supplied it is used in-process, because a handle a
 * test owns cannot be reached from another thread — see the note on file-backed
 * databases in `test-sqlite.test-helpers.ts`.
 */
export function prepareClusteringPassOffThread(
  similarityThreshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  dbOverride?: SqliteDb,
): Promise<PrepareResult> {
  if (dbOverride) {
    return prepareClusteringPass(similarityThreshold, dbOverride).then((pass) => ({
      pass,
      viaWorker: false,
    }));
  }
  const db = sqlitePool();
  return clusterPool().run({ path: db.path, similarityThreshold }, db);
}

/** Stop the clustering worker. Idempotent; used by shutdown and by tests. */
export function shutdownClusterPool(): void {
  pool?.shutdown();
  pool = null;
}
