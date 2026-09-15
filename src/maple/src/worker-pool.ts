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
import { getNapiLoadError, tryLoadNapiBinding } from './native-napi';
import { restoreFromTransfer, type WorkerRequest, type WorkerResponse } from './worker-protocol';

export type MapleExecutionMode = 'worker' | 'sync';

/** The Bun fallback has one waiting slot per configured worker. Await an
 *  outstanding call before retrying; Maple never queues rejected inputs. */
export class MapleWorkerPoolOverloadedError extends Error {
  readonly code = 'MAPLE_WORKER_POOL_OVERLOADED';

  constructor() {
    super('Maple worker pool is full; await an outstanding call before submitting more work');
    this.name = 'MapleWorkerPoolOverloadedError';
  }
}

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
    // Admit before retaining args or creating a pending entry. Existing
    // accepted work drains if concurrency is lowered below the queue size.
    const worker = this.acquireIdleWorker();
    if (worker instanceof Error) return Promise.reject(worker);
    if (!worker && this.queue.length >= getMapleConcurrency()) {
      return Promise.reject(new MapleWorkerPoolOverloadedError());
    }
    const id = this.nextId++;
    const request: WorkerRequest = { id, method, args };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (worker) {
        this.send(worker, request);
      } else {
        this.queue.push(request);
      }
    });
  }

  private acquireIdleWorker(): PoolWorker | Error | null {
    const idle = this.workers.find((w) => w.busyWith === null);
    if (idle) return idle;
    if (this.workers.length < getMapleConcurrency()) {
      try {
        return this.spawnWorker();
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
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
    try {
      poolWorker.worker.postMessage(request);
    } catch (error) {
      // Structured-clone failures must release the slot and queued inputs,
      // just like a worker failure, rather than strand the pending map.
      this.handleWorkerDeath(poolWorker, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Settle the pending promise for one worker reply. The actual
   * `resolve`/`reject` is deferred one macrotask out (`setImmediate(fn)`
   * rather than a same-tick call or even `queueMicrotask`) — a real Bun
   * engine quirk (reproduced on `1.4.3-canary.1`) otherwise drops the NEXT
   * worker `message` event entirely when that event's listener settles a
   * promise that is awaited through ANY `expect(...)` async matcher —
   * `.resolves` on a genuinely successful call included, not just
   * `.rejects` on a failing one — AND it is not the first worker round trip
   * in the test: `bun:test`'s async matchers appear to peek the promise
   * synchronously in a way that, chained directly off a prior worker-driven
   * resolution, wedges the pool's `Worker` message port — the dispatch
   * still reaches the worker (confirmed by log tracing) and the worker
   * still replies, but the main thread's `message` listener never fires for
   * that reply. This is a genuine process wedge (requires `kill -9`, not a
   * clean test-timeout-then-exit) until something external intervenes.
   * Deferring the settle with a macrotask breaks the direct continuation
   * chain and reliably avoids it — see the worker-pool tests for the
   * regression case.
   *
   * `setImmediate(fn)` was chosen over `setTimeout(fn, 0)` (the original
   * fix) because Bun/Node clamp `setTimeout(fn, 0)` to a historical ~1ms
   * minimum-delay floor, while `setImmediate` queues onto the next check
   * phase of the event loop with no such floor — same "one macrotask out"
   * effect on the continuation chain, far less latency. Measured locally on
   * this machine, isolating just the scheduling primitive (200 samples each,
   * no worker involved): `setTimeout(fn, 0)` cost ~1.13ms mean per settle,
   * `setImmediate(fn)` cost ~0.002ms mean — over 500x less. A separate
   * measurement of a full real worker round trip end to end (dispatch,
   * cross-thread reply, settle) via `callNative('validateFilename', ...)`
   * with the `setImmediate` fix in place came out to ~0.15ms mean, dominated
   * by actual thread IPC rather than the settle itself. Still not a
   * main-thread STALL either way — the event loop is free to do other work
   * during the wait, and multiple in-flight calls overlap this delay rather
   * than serializing it — so this was never at risk of violating this
   * epic's "no main-thread stall > 1ms" budget, but it is a real, measurable
   * per-call latency win given that `src/api/scripts/bench-maple-vs-sharp.ts`
   * reports timings to two decimal places.
   */
  private handleResponse(poolWorker: PoolWorker, response: WorkerResponse): void {
    if (!this.workers.includes(poolWorker) || poolWorker.busyWith !== response.id) return;
    const pending = this.pending.get(response.id);
    this.pending.delete(response.id);
    poolWorker.busyWith = null;
    this.drainQueueOrIdle(poolWorker);
    if (!pending) return; // response for a request this pool no longer tracks
    if (response.ok) {
      const restored = restoreFromTransfer(response.result);
      setImmediate(() => pending.resolve(restored));
    } else {
      const err = new Error(response.error || 'Maple native call failed');
      setImmediate(() => pending.reject(err));
    }
  }

  /** A dead worker (crash or unexpected exit) rejects only the ONE request
   *  it was serving — every other in-flight/queued request is unaffected,
   *  and the pool spawns a fresh worker lazily next time one is needed.
   *  Defensive cleanup on the dead worker itself: `terminate()` is a no-op
   *  if the worker is already gone but guards against a partial-death state
   *  where the OS thread lingers, and `unref()` is belt-and-braces in case
   *  it is somehow still ref'd — either one lingering could keep the whole
   *  process alive forever (see `test/process-exit.test.ts`) if Bun's
   *  observed "error then close, worker already dead" behavior ever doesn't
   *  hold in some edge case. */
  private handleWorkerDeath(poolWorker: PoolWorker, message: string): void {
    if (!this.workers.includes(poolWorker)) return; // error + close may both fire
    this.workers = this.workers.filter((w) => w !== poolWorker);
    const failedRequestId = poolWorker.busyWith;
    poolWorker.busyWith = null;
    poolWorker.worker.terminate();
    poolWorker.worker.unref?.();
    if (failedRequestId !== null) {
      const pending = this.pending.get(failedRequestId);
      this.pending.delete(failedRequestId);
      if (pending) setImmediate(() => pending.reject(new Error(message)));
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
      if (worker instanceof Error) {
        // Surviving busy workers can still drain accepted work on reply.
        if (this.workers.length > 0) return;
        // No worker remains and a replacement cannot start. Reject work so neither
        // its promises nor image buffers remain retained indefinitely.
        for (const request of this.queue.splice(0)) {
          const pending = this.pending.get(request.id);
          this.pending.delete(request.id);
          if (pending) setImmediate(() => pending.reject(worker));
        }
        return;
      }
      if (!worker) return;
      const next = this.queue.shift();
      if (next) this.send(worker, next);
    }
  }

  /** Test-only: the live `Worker` currently serving an in-flight request, if
   *  any. Lets a test reach in and `.terminate()` a real worker mid-call to
   *  exercise `handleWorkerDeath` for real, rather than only the caught
   *  in-worker-error path. */
  getBusyWorkerForTests(): Worker | null {
    return this.workers.find((w) => w.busyWith !== null)?.worker ?? null;
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const [, pending] of this.pending) {
      pending.reject(new Error('Maple worker pool shut down'));
    }
    this.pending.clear();
    const workers = this.workers;
    this.workers = [];
    this.queue.length = 0;
    for (const poolWorker of workers) {
      poolWorker.worker.terminate();
    }
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
 * Call one `NativeBinding` method by name.
 *
 * - `'sync'` execution mode calls straight through to `loadNativeBinding()`
 *   (`bun:ffi`) on the caller's own thread — the pre-#3508 escape hatch for a
 *   caller with its own off-thread strategy. A caller who explicitly asked
 *   for this synchronous escape hatch is asking for that same-thread
 *   `bun:ffi` behavior specifically, not for napi's off-thread-but-still-
 *   fast path, so this mode never tries napi.
 * - Otherwise, the `raw-napi` addon (#3509) is tried first when one is
 *   resolvable for this platform (Node **and** Bun, when a matching addon is
 *   installed) — its `Task`/`AsyncTask` bindings already run off the JS
 *   thread on N-API's own libuv worker pool, so no dispatch through this
 *   package's own `Worker` pool is needed on that path at all.
 * - Falling that, the call posts to the `bun:ffi` worker pool as before.
 *
 * A method absent from the resolved napi binding (there is exactly one:
 * `lastError`, which napi implements as a stub — see `native-napi.ts` — so
 * this only matters for a genuinely unknown method name reaching here, e.g.
 * a caller that bypassed the type system) falls through to the worker pool
 * rather than throwing here, so the pool's own "unknown native method" error
 * still surfaces the same way regardless of whether a napi addon happens to
 * be installed.
 *
 * One more thing the fallback path must guard against: the worker pool
 * itself is Bun-only. `spawnWorker()` below calls `new Worker(...)` against
 * the bare global `Worker` — Bun's/a browser's constructor, not
 * `node:worker_threads`'s — which simply does not exist on plain Node, so
 * reaching it there throws a bare, uninformative `ReferenceError: Worker is
 * not defined`. Before this task, that was survivable only because Node was
 * never a working runtime for this package's `'worker'` mode at all; this
 * task is what makes Node a supported runtime in the first place (via
 * napi), which makes "napi genuinely unavailable on Node" a real,
 * user-reachable failure path rather than a moot one. So: when no napi
 * function answers this call AND there is no `Bun` global to fall back to,
 * this throws a specific error naming what actually went wrong (the real
 * napi load failure, preserved by `native-napi.ts` rather than swallowed)
 * instead of letting execution fall through into that crash.
 */
/** Whether a Bun-only global (the worker pool's `new Worker(...)`, and
 *  `loadNativeBinding()`'s `bun:ffi`) is actually usable in this process.
 *  `globalThis.Bun` is a non-configurable, non-writable property under real
 *  Bun (confirmed empirically — neither `delete` nor `Object.defineProperty`
 *  can override it for a test), so this indirection is what lets
 *  `worker-pool.test.ts` exercise the "no Bun" branch below via a real
 *  monkey-patch rather than needing to fake the global itself. */
let isBunRuntime = (): boolean => typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

/** Test-only: override the "is this Bun" check `callNative` uses to decide
 *  whether the bun:ffi/worker-pool fallback is even reachable, so a test can
 *  exercise the plain-Node "no working backend" error path without needing
 *  to mutate the real (non-configurable) `globalThis.Bun`. Pass `undefined`
 *  to restore the real check. */
export function _setIsBunRuntimeForTests(fn: (() => boolean) | undefined): void {
  isBunRuntime =
    fn ?? ((): boolean => typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined');
}

/** Builds the error `callNative` throws when no napi function answered this
 *  call AND the bun:ffi/worker-pool fallback isn't reachable either (plain
 *  Node, no Bun global) — pulled out as its own function so its exact
 *  wording can be unit-tested without needing to fake `globalThis.Bun` (see
 *  `isBunRuntime` above) or actually reach `callNative`'s async dispatch. */
export function buildNoNativeBindingError(napiError: Error | null): Error {
  return new Error(
    'Maple has no working native binding for this Node process: the raw-napi addon is ' +
      `unavailable${napiError ? ` (${napiError.message})` : ''}, and the bun:ffi ` +
      'worker-pool fallback requires Bun (it cannot run on plain Node). Build/install a ' +
      'raw-napi addon for this platform, or run under Bun instead.',
  );
}

export async function callNative<K extends keyof NativeBinding>(
  method: K,
  args: Parameters<NativeBinding[K]>,
): Promise<ReturnType<NativeBinding[K]>> {
  if (executionMode === 'sync') {
    const native = loadNativeBinding();
    const fn = native[method] as unknown as (...a: unknown[]) => unknown;
    return fn.apply(native, args) as ReturnType<NativeBinding[K]>;
  }
  const napi = tryLoadNapiBinding();
  const napiFn = napi
    ? ((napi as unknown as Record<string, unknown>)[method as string] as
        | ((...a: unknown[]) => unknown)
        | undefined)
    : undefined;
  if (typeof napiFn === 'function') {
    return (await napiFn.apply(napi, args)) as ReturnType<NativeBinding[K]>;
  }
  if (!isBunRuntime()) {
    throw buildNoNativeBindingError(getNapiLoadError());
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

/** Test-only: the live `Worker` currently serving an in-flight request, if
 *  any — see `NativeWorkerPool.getBusyWorkerForTests`. Returns `null` if the
 *  pool hasn't been created yet or no worker is currently busy. */
export function _getBusyMapleWorkerForTests(): Worker | null {
  return pool?.getBusyWorkerForTests() ?? null;
}
