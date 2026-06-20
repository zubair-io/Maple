// Single-worker clustering pool. Off-main-thread online clustering so the
// synchronous O(N·K·D) `clusterEmbeddings` pass AND the O(N·D) embedding
// load + normalize never block HTTP handlers.
//
// What runs on the worker (since #710): the WHOLE load + compute stage —
// `recomputeCentroids`, `loadCentroids`, `loadUnassignedFaces`, and
// `clusterEmbeddings`. The worker opens its OWN Mongo connection (env passed
// in the dispatch message), so the embeddings are decoded, normalised, and
// clustered entirely off the main thread. Only a small serializable result
// crosses back (assignments + updated centroids + per-face envelopes) — the
// embeddings themselves NEVER cross `postMessage`, which retires the old
// structured-clone-of-Float32Array[] cost by construction.
//
// Why one worker (not N): the online pass is order-sensitive and inherently
// sequential — a face competes against every cluster opened by earlier
// faces — so it can't be sharded across workers without changing results.
// And the `ClusterCoordinator` already guarantees single-flight (one pass
// at a time, mid-pass triggers coalesce), so there's never more than one
// in-flight call. One worker, lazily spawned, lives for the process.
//
// Fallback: if Bun's `Worker` can't spawn (unsupported runtime, sandbox),
// `prepareClusteringPassOffThread` degrades to running the same load+compute
// stage in-process. That re-introduces the event-loop block, but it's
// correct, and it keeps environments without Worker support (some test/CI
// shells) working rather than hard-failing. The worker runs the SAME pure
// core against the SAME Mongo, so either path returns identical output.

import { child as childLogger } from '../log.ts';
import { prepareClusteringPass, type PreparedClusteringPass } from './cluster-load.ts';
import { DEFAULT_SIMILARITY_THRESHOLD } from './cluster-embeddings.ts';

const log = childLogger('people:cluster-pool');

/** A prepared pass plus execution telemetry. `viaWorker` is true when the
 *  load + compute genuinely ran on the Worker thread, false when it degraded
 *  to the in-process (event-loop-blocking) fallback because no Worker could
 *  spawn. Lets callers — and the off-thread test — distinguish the two paths
 *  instead of inferring from timing. */
export interface PrepareResult {
  pass: PreparedClusteringPass;
  viaWorker: boolean;
}

/** Mongo connection params handed to the worker so it can open its own
 *  handle. Resolved on the main thread (env is read here, not in the worker,
 *  so per-test `MAPLE_MONGO_DB` overrides reach the worker correctly). */
export interface WorkerMongoConfig {
  uri: string;
  dbName: string;
}

interface PendingCall {
  resolve: (result: PreparedClusteringPass) => void;
  reject: (err: Error) => void;
}

interface PrepareResponse {
  type: 'prepare';
  id: number;
  ok: boolean;
  result?: PreparedClusteringPass;
  error?: string;
}

function resolveMongoConfig(): WorkerMongoConfig {
  return {
    uri: process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017',
    dbName: process.env.MAPLE_MONGO_DB ?? 'maple',
  };
}

class ClusterWorkerPool {
  private worker: Worker | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private workerLoadFailed = false;

  /** Lazy worker spawn. Throws if Bun's `Worker` API is unavailable so the
   *  caller can fall back to in-process clustering. */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (this.workerLoadFailed) {
      throw new Error('cluster-pool: worker previously failed to start');
    }

    let w: Worker;
    try {
      w = new Worker(new URL('./cluster.worker.ts', import.meta.url).href);
    } catch (e) {
      this.workerLoadFailed = true;
      throw new Error(
        'cluster-pool: failed to spawn worker — ' + (e instanceof Error ? e.message : String(e)),
        { cause: e },
      );
    }

    w.addEventListener('message', (event) => {
      const msg = event.data as PrepareResponse;
      if (msg?.type !== 'prepare') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok && msg.result) {
        p.resolve(msg.result);
      } else {
        p.reject(new Error(msg.error ?? 'cluster-pool: clustering failed'));
      }
    });

    w.addEventListener('error', (event) => {
      // Reject every in-flight call so callers don't hang. The next request
      // spawns a fresh worker.
      const err = new Error('cluster-pool: worker errored — ' + (event.message || 'unknown'));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    });

    this.worker = w;
    return w;
  }

  /** Dispatch one load + compute pass to the worker. Resolves with the
   *  worker's result, or (when no worker can spawn) runs the same stage
   *  in-process. Rejects only on a genuine worker runtime error — never
   *  silently falls back to the blocking path once a worker is up. */
  run(similarityThreshold: number): Promise<PrepareResult> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'cluster worker unavailable — clustering in-process (blocks the event loop)',
      );
      return prepareClusteringPass(similarityThreshold).then((pass) => ({
        pass,
        viaWorker: false,
      }));
    }

    const id = this.nextId++;
    const mongo = resolveMongoConfig();
    return new Promise<PreparedClusteringPass>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        // No embeddings cross here — only the threshold + Mongo params. The
        // worker reads, normalises, and clusters the embeddings itself, then
        // returns a small serializable result. This is what eliminates the
        // structured-clone-of-Float32Array[] cost from the prior design.
        worker.postMessage({ type: 'prepare', id, similarityThreshold, mongo });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }).then((pass) => ({ pass, viaWorker: true }));
  }
}

let _pool: ClusterWorkerPool | null = null;

/** Process-wide clustering pool. Lazily constructed on first call. */
function clusterPool(): ClusterWorkerPool {
  if (!_pool) _pool = new ClusterWorkerPool();
  return _pool;
}

/**
 * Run the full clustering load + compute stage off the main thread on a
 * persistent Worker so neither the synchronous O(N·K·D) loop nor the O(N·D)
 * embedding decode/normalise ever freezes the HTTP event loop. Output is
 * identical to running `prepareClusteringPass` in-process — the worker runs
 * the same core against the same Mongo. Degrades to in-process execution only
 * when no Worker can spawn.
 */
export function prepareClusteringPassOffThread(
  similarityThreshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): Promise<PrepareResult> {
  return clusterPool().run(similarityThreshold);
}
