// Single-worker clustering pool. Off-main-thread online clustering so the
// synchronous O(N·K·D) `clusterEmbeddings` pass doesn't block HTTP handlers.
//
// Why one worker (not N): the online pass is order-sensitive and inherently
// sequential — a face competes against every cluster opened by earlier
// faces — so it can't be sharded across workers without changing results.
// And the `ClusterCoordinator` already guarantees single-flight (one pass
// at a time, mid-pass triggers coalesce), so there's never more than one
// in-flight call. One worker, lazily spawned, lives for the process.
//
// Fallback: if Bun's `Worker` can't spawn (unsupported runtime, sandbox),
// `clusterEmbeddingsOffThread` degrades to running the pure function
// in-process. That re-introduces the event-loop block, but it's correct,
// and it keeps environments without Worker support (some test/CI shells)
// working rather than hard-failing. The worker runs the same pure core, so
// either path returns identical output.

import { child as childLogger } from '../log.ts';
import {
  clusterEmbeddings,
  type OnlineClusterOptions,
  type OnlineClusterResult,
} from './cluster-embeddings.ts';

const log = childLogger('people:cluster-pool');

interface PendingCall {
  resolve: (result: OnlineClusterResult) => void;
  reject: (err: Error) => void;
}

interface ClusterResponse {
  type: 'cluster';
  id: number;
  ok: boolean;
  result?: OnlineClusterResult;
  error?: string;
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
      );
    }

    w.addEventListener('message', (event) => {
      const msg = event.data as ClusterResponse;
      if (msg?.type !== 'cluster') return;
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

  /** Dispatch one clustering pass to the worker. Resolves with the worker's
   *  result, or (when no worker can spawn) runs the pure function in-process.
   *  Rejects only on a genuine worker runtime error — never silently falls
   *  back to the blocking path once a worker is up. */
  run(embeddings: Float32Array[], options: OnlineClusterOptions): Promise<OnlineClusterResult> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'cluster worker unavailable — clustering in-process (blocks the event loop)',
      );
      return Promise.resolve(clusterEmbeddings(embeddings, options));
    }

    const id = this.nextId++;
    return new Promise<OnlineClusterResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        // Structured-clone copy (not transfer): the caller reuses each
        // `embedding` buffer after clustering (e.g. seeding a new person's
        // centroid), so the originals must stay intact on this thread.
        worker.postMessage({ type: 'cluster', id, embeddings, options });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

let _pool: ClusterWorkerPool | null = null;

/** Process-wide clustering pool. Lazily constructed on first call. */
function clusterPool(): ClusterWorkerPool {
  if (!_pool) _pool = new ClusterWorkerPool();
  return _pool;
}

/**
 * Run `clusterEmbeddings` off the main thread on a persistent Worker so the
 * synchronous O(N·K·D) loop never freezes the HTTP event loop. Output is
 * identical to calling `clusterEmbeddings` directly — the worker runs the
 * same pure core. Degrades to in-process execution only when no Worker can
 * spawn.
 */
export function clusterEmbeddingsOffThread(
  embeddings: Float32Array[],
  options: OnlineClusterOptions = {},
): Promise<OnlineClusterResult> {
  return clusterPool().run(embeddings, options);
}
