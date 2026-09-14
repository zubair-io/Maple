/**
 * In-package async execution for `@justmaple/maple`'s native calls (#3508).
 *
 * `callNative(method, args)` is the single entry point every builder/export
 * code path in this package uses instead of calling `loadNativeBinding()`
 * directly. By default it posts the call to a lazily-spawned pool of Bun
 * `Worker` threads (`native-worker-entry.ts` runs inside each one) so the
 * actual synchronous `bun:ffi` call never touches the CALLER's event loop.
 * `setMapleExecutionMode('sync')` is the documented escape hatch: it makes
 * `callNative` call straight through to `loadNativeBinding()` on the
 * caller's own thread, exactly as this package did before #3508, for
 * callers who have their own off-thread strategy (or who are fine
 * blocking — e.g. a one-shot CLI invocation with nothing else running).
 *
 * This pool provides EVENT-LOOP RESPONSIVENESS, not crash isolation — see
 * `native-worker-entry.ts`'s module doc and `README.md` § "Execution model".
 * The API server's own `src/api/src/ffi/` child-PROCESS pool is unrelated
 * and unaffected by anything in this file.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { loadNativeBinding, type NativeBinding } from './native';
import { restoreFromTransfer, type WorkerRequest, type WorkerResponse } from './worker-protocol';

export type MapleExecutionMode = 'worker' | 'sync';

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;
const DEFAULT_CONCURRENCY = 4;

let executionMode: MapleExecutionMode = 'worker';
let configuredConcurrency: number | null = null;

/** Switch every future `callNative` call between the default worker-pool
 *  dispatch and the pre-#3508 same-thread synchronous call. */
export function setMapleExecutionMode(mode: MapleExecutionMode): void {
  executionMode = mode;
}

export function getMapleExecutionMode(): MapleExecutionMode {
  return executionMode;
}

function clampConcurrency(n: number): number {
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.trunc(n) || MIN_CONCURRENCY));
}

/** Set the worker pool's target size. Takes effect the next time a worker
 *  needs to be spawned (existing idle workers above the new target are not
 *  forcibly killed) — same lazy-spawn philosophy as the API's own
 *  `ffi-pool-slots.ts`. */
export function setMapleConcurrency(n: number): void {
  configuredConcurrency = clampConcurrency(n);
}

export function getMapleConcurrency(): number {
  if (configuredConcurrency !== null) return configuredConcurrency;
  const fromEnv = Number(process.env.MAPLE_WORKER_CONCURRENCY);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return clampConcurrency(fromEnv);
  return DEFAULT_CONCURRENCY;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  busyWith: number | null; // request id, or null when idle
}

class NativeWorkerPool {
  private workers: PoolWorker[] = [];
  private readonly pending = new Map<number, PendingCall>();
  private readonly queue: WorkerRequest[] = [];
  private nextId = 1;
  private shuttingDown = false;

  dispatch(method: string, args: unknown[]): Promise<unknown> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('Maple worker pool is shut down'));
    }
    const id = this.nextId++;
    const request: WorkerRequest = { id, method, args };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const worker = this.acquireIdleWorker();
      if (worker) {
        this.send(worker, request);
      } else {
        this.queue.push(request);
      }
    });
  }

  private acquireIdleWorker(): PoolWorker | null {
    const idle = this.workers.find((w) => w.busyWith === null);
    if (idle) return idle;
    if (this.workers.length < getMapleConcurrency()) {
      return this.spawnWorker();
    }
    return null;
  }

  private spawnWorker(): PoolWorker {
    const entry = workerEntryUrl();
    const raw = new Worker(entry);
    const poolWorker: PoolWorker = { worker: raw, busyWith: null };
    raw.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      this.handleResponse(poolWorker, event.data);
    });
    raw.addEventListener('error', (event: ErrorEvent) => {
      this.handleWorkerDeath(poolWorker, event.message || 'Maple worker error');
    });
    raw.addEventListener('close', () => {
      this.handleWorkerDeath(poolWorker, 'Maple worker exited');
    });
    this.workers.push(poolWorker);
    return poolWorker;
  }

  private send(poolWorker: PoolWorker, request: WorkerRequest): void {
    poolWorker.busyWith = request.id;
    poolWorker.worker.ref?.();
    poolWorker.worker.postMessage(request);
  }

  /**
   * Settle the pending promise for one worker reply. The actual
   * `resolve`/`reject` is deferred one macrotask out (`setTimeout(fn, 0)`
   * rather than a same-tick call or even `queueMicrotask`) — a real Bun
   * engine quirk (reproduced on `1.4.3-canary.1`) otherwise drops the NEXT
   * worker `message` event entirely when that event's listener settles a
   * promise that `expect(...).rejects` is awaiting AND it is not the first
   * worker round trip in the test: `bun:test`'s `.rejects` matcher appears
   * to peek the promise synchronously in a way that, chained directly off a
   * prior worker-driven resolution, wedges the pool's `Worker` message port
   * — the dispatch still reaches the worker (confirmed by log tracing) and
   * the worker still replies, but the main thread's `message` listener never
   * fires for that reply, hanging until the test's own timeout. Deferring
   * the settle with a macrotask breaks the direct continuation chain and
   * reliably avoids it — see the worker-pool tests for the regression case.
   */
  private handleResponse(poolWorker: PoolWorker, response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    this.pending.delete(response.id);
    poolWorker.busyWith = null;
    this.drainQueueOrIdle(poolWorker);
    if (!pending) return; // response for a request this pool no longer tracks
    if (response.ok) {
      const restored = restoreFromTransfer(response.result);
      setTimeout(() => pending.resolve(restored), 0);
    } else {
      const err = new Error(response.error || 'Maple native call failed');
      setTimeout(() => pending.reject(err), 0);
    }
  }

  /** A dead worker (crash or unexpected exit) rejects only the ONE request
   *  it was serving — every other in-flight/queued request is unaffected,
   *  and the pool spawns a fresh worker lazily next time one is needed. */
  private handleWorkerDeath(poolWorker: PoolWorker, message: string): void {
    this.workers = this.workers.filter((w) => w !== poolWorker);
    if (poolWorker.busyWith !== null) {
      const pending = this.pending.get(poolWorker.busyWith);
      this.pending.delete(poolWorker.busyWith);
      if (pending) setTimeout(() => pending.reject(new Error(message)), 0);
    }
    this.pumpQueue();
  }

  private drainQueueOrIdle(poolWorker: PoolWorker): void {
    const next = this.queue.shift();
    if (next) {
      this.send(poolWorker, next);
    } else {
      poolWorker.worker.unref?.();
    }
  }

  private pumpQueue(): void {
    while (this.queue.length > 0) {
      const worker = this.acquireIdleWorker();
      if (!worker) return;
      const next = this.queue.shift();
      if (next) this.send(worker, next);
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const [, pending] of this.pending) {
      pending.reject(new Error('Maple worker pool shut down'));
    }
    this.pending.clear();
    for (const poolWorker of this.workers) {
      poolWorker.worker.terminate();
    }
    this.workers = [];
    this.queue.length = 0;
  }
}

/** Resolves the worker-thread entry script's URL relative to THIS module —
 *  `.ts` under `bun test`/a source checkout, `.js` once built into `dist/`
 *  by the two-entrypoint build (`package.json`'s `build` script, #3508). */
function workerEntryUrl(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  const entryPath = path.join(path.dirname(here), `native-worker-entry${ext}`);
  return pathToFileURL(entryPath).href;
}

let pool: NativeWorkerPool | null = null;

function getPool(): NativeWorkerPool {
  if (!pool) pool = new NativeWorkerPool();
  return pool;
}

/**
 * Call one `NativeBinding` method by name. In the default `'worker'`
 * execution mode this posts to the worker pool and never touches the
 * caller's event loop; in `'sync'` mode it calls straight through to
 * `loadNativeBinding()` on the caller's own thread (the escape hatch).
 */
export async function callNative<K extends keyof NativeBinding>(
  method: K,
  args: Parameters<NativeBinding[K]>,
): Promise<ReturnType<NativeBinding[K]>> {
  if (executionMode === 'sync') {
    const native = loadNativeBinding();
    const fn = native[method] as unknown as (...a: unknown[]) => unknown;
    return fn.apply(native, args) as ReturnType<NativeBinding[K]>;
  }
  const result = await getPool().dispatch(method as string, args);
  return result as ReturnType<NativeBinding[K]>;
}

/** Terminate every spawned worker and stop accepting new calls. Callers that
 *  want a script to exit the instant Maple work is done (rather than relying
 *  on idle workers' own `unref()`) can call this explicitly; it is also
 *  exposed so the CLI (`bin/maple.js`) and tests can force a clean exit. */
export function shutdownMaplePool(): void {
  pool?.shutdown();
  pool = null;
}

/** Test-only: drop the pool/config singletons so the next call rebuilds them
 *  (e.g. to pick up a just-changed `MAPLE_WORKER_CONCURRENCY`). */
export function _resetMaplePoolForTests(): void {
  pool?.shutdown();
  pool = null;
  configuredConcurrency = null;
}
