// N-worker FFI pool. Off-main-thread thumbnail / preview / histogram
// rendering so the synchronous bun:ffi symbol calls don't block HTTP
// handlers.
//
// Why a pool (not one worker): bun:ffi calls run inline on whichever thread
// invokes them, so the embedded-preview extractor (single-threaded, no
// rayon) pegs exactly one core per in-flight decode. With one worker the
// whole process serializes RAW thumb/preview behind a single decode; a pool
// of N lets N decodes run on N cores at once. The size is operator-tunable
// and DB-persisted (see `ffi-pool-config.repo.ts`) — default 1 keeps the
// historical single-decode behaviour, pure opt-in.
//
// Dispatch model: a queue of pending requests + a set of workers, each with
// a busy flag. A request grabs a free (idle, non-surplus) worker, else it
// lazy-spawns one up to `targetSize`, else it queues. When a worker frees it
// pulls the next queued request. We don't pay N dlopens until there's work —
// workers spawn on demand up to the target.
//
// Resize (setPoolSize): grow → raise the spawn ceiling and drain the queue
// (idle work spawns the extra workers lazily). Shrink → mark surplus workers;
// each terminates AFTER its in-flight call drains — we never kill a worker
// mid-decode.
//
// Crash handling: a worker `error` rejects only ITS in-flight call, drops the
// worker, and re-dispatches the queue (a fresh worker spawns on the next
// request that needs one). Other workers' in-flight calls are untouched.

import { tryGetRawFfi } from './raw_ffi.ts';
import type { HistogramBins } from '../thumbs/histogram.ts';
import { DEFAULT_FFI_WORKERS, MAX_FFI_WORKERS, MIN_FFI_WORKERS } from './ffi-pool-config.repo.ts';

interface RenderResponse {
  type: 'renderThumb';
  id: number;
  ok: boolean;
  error?: string;
}

interface HistogramResponse {
  type: 'histogram';
  id: number;
  ok: boolean;
  bins?: HistogramBins;
  error?: string;
}

type WorkerResponse = RenderResponse | HistogramResponse;

/** Minimal worker surface the pool depends on. The real bun `Worker`
 * satisfies this; tests inject a fake so the dispatch / resize / crash logic
 * can be exercised without loading the native dylib on a worker thread. */
export interface PoolWorker {
  postMessage(msg: unknown): void;
  terminate(): void;
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void;
  addEventListener(type: 'error', cb: (e: { message?: string }) => void): void;
}

/** Factory that builds a worker. Production passes `defaultWorkerFactory`
 * (spawns the real `raw_ffi.worker.ts`); tests pass a fake. */
export type WorkerFactory = () => PoolWorker;

function defaultWorkerFactory(): PoolWorker {
  return new Worker(new URL('./raw_ffi.worker.ts', import.meta.url).href) as unknown as PoolWorker;
}

/** A unit of work queued for the next free worker. `post` writes the request
 * onto the worker; `onResponse` decodes a worker message into resolve/reject;
 * `onError` rejects when the worker carrying it crashes. */
interface PendingRequest {
  id: number;
  post: (w: PoolWorker) => void;
  onResponse: (msg: WorkerResponse) => boolean;
  onError: (err: Error) => void;
}

/** A worker slot. `inFlight` is the request currently running on it (null =
 * idle). `surplus` marks a worker scheduled for termination on a shrink — it
 * accepts no new work and self-terminates once its in-flight call drains. */
interface WorkerSlot {
  worker: PoolWorker;
  inFlight: PendingRequest | null;
  surplus: boolean;
}

class FfiWorkerPool {
  private slots: WorkerSlot[] = [];
  private queue: PendingRequest[] = [];
  private nextId = 1;
  private targetSize = DEFAULT_FFI_WORKERS;
  private spawnFailed = false;
  private readonly workerFactory: WorkerFactory;
  /** When set, availability is forced (tests bypass the real dylib probe). */
  private readonly availableOverride: boolean | null;

  constructor(opts?: { workerFactory?: WorkerFactory; availableOverride?: boolean }) {
    this.workerFactory = opts?.workerFactory ?? defaultWorkerFactory;
    this.availableOverride = opts?.availableOverride ?? null;
  }

  /** True iff the dylib is reachable. False = caller should degrade. */
  available(): boolean {
    if (this.availableOverride !== null) return this.availableOverride;
    return tryGetRawFfi() !== null;
  }

  /** Effective pool size (lazy spawn ceiling). */
  poolSize(): number {
    return this.targetSize;
  }

  /** Live snapshot for diagnostics: configured target, spawned worker count,
   * how many are busy, and the queue depth. */
  stats(): { target: number; spawned: number; busy: number; queued: number } {
    return {
      target: this.targetSize,
      spawned: this.slots.length,
      busy: this.slots.filter((s) => s.inFlight !== null).length,
      queued: this.queue.length,
    };
  }

  /**
   * Set the target pool size (clamped to [MIN, MAX]). Grow: raise the ceiling
   * and dispatch any queued work, which lazy-spawns the extra workers. Shrink:
   * mark surplus workers; an idle surplus worker terminates immediately, a
   * busy one terminates once its in-flight call drains (never mid-decode).
   */
  setPoolSize(n: number): void {
    const clamped = Math.max(MIN_FFI_WORKERS, Math.min(MAX_FFI_WORKERS, Math.floor(n)));
    this.targetSize = clamped;

    // Clear any stale surplus flags first (a grow after a shrink should
    // un-retire workers we haven't terminated yet).
    for (const slot of this.slots) slot.surplus = false;

    if (this.slots.length > clamped) {
      // Shrink: mark the newest workers surplus. Idle ones terminate now;
      // busy ones drain first (handled in the response/error paths).
      const surplusCount = this.slots.length - clamped;
      const victims = this.slots.slice(this.slots.length - surplusCount);
      for (const slot of victims) {
        slot.surplus = true;
        if (slot.inFlight === null) this.terminateSlot(slot);
      }
    }

    // Grow (or post-shrink): a freed ceiling may let queued work spawn.
    this.dispatch();
  }

  /** Render a RAW thumbnail to disk. Returns true on success, false on a soft
   * failure. Rejects only on hard infra errors (worker crash, dylib missing). */
  async renderThumbnailJpegToFile(
    rawPath: string,
    outPath: string,
    maxPx: number,
    quality = 82,
  ): Promise<boolean> {
    if (!this.available()) {
      throw new Error('ffi-pool: raw-ffi dylib not available');
    }
    const id = this.nextId++;
    return new Promise<boolean>((resolve, reject) => {
      this.enqueue({
        id,
        post: (w) => w.postMessage({ type: 'renderThumb', id, rawPath, outPath, maxPx, quality }),
        onResponse: (msg) => {
          if (msg.type !== 'renderThumb') return false;
          if (msg.ok) resolve(true);
          else if (msg.error) reject(new Error(msg.error));
          else resolve(false);
          return true;
        },
        onError: reject,
      });
    });
  }

  /**
   * Render a RAW with `xmpPath`'s adjustments applied, bin the RGB888 output
   * into 3×256 channel histograms inside the worker, and return the bins.
   * Rejects on dylib-missing or any render failure.
   */
  async computeHistogram(rawPath: string, xmpPath: string | null): Promise<HistogramBins> {
    if (!this.available()) {
      throw new Error('ffi-pool: raw-ffi dylib not available');
    }
    const id = this.nextId++;
    return new Promise<HistogramBins>((resolve, reject) => {
      this.enqueue({
        id,
        post: (w) => w.postMessage({ type: 'histogram', id, rawPath, xmpPath }),
        onResponse: (msg) => {
          if (msg.type !== 'histogram') return false;
          if (msg.ok && msg.bins) resolve(msg.bins);
          else reject(new Error(msg.error ?? 'histogram failed'));
          return true;
        },
        onError: reject,
      });
    });
  }

  // ── internals ──────────────────────────────────────────────────────────

  private enqueue(req: PendingRequest): void {
    this.queue.push(req);
    this.dispatch();
  }

  /** Pull queued work onto idle workers, lazy-spawning up to the target. */
  private dispatch(): void {
    while (this.queue.length > 0) {
      const slot = this.acquireSlot();
      if (!slot) break; // all busy and at the spawn ceiling — wait for a free worker
      const req = this.queue.shift()!;
      slot.inFlight = req;
      try {
        req.post(slot.worker);
      } catch (e) {
        // postMessage threw (shouldn't, but be safe): release the slot and
        // reject the request.
        slot.inFlight = null;
        req.onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  /** Find an idle non-surplus worker, else spawn one if below the ceiling. */
  private acquireSlot(): WorkerSlot | null {
    const idle = this.slots.find((s) => s.inFlight === null && !s.surplus);
    if (idle) return idle;
    if (this.activeCount() < this.targetSize) return this.spawnSlot();
    return null;
  }

  /** Workers that count toward the ceiling — everything not retired. */
  private activeCount(): number {
    return this.slots.filter((s) => !s.surplus).length;
  }

  private spawnSlot(): WorkerSlot | null {
    if (this.spawnFailed) return null;
    let w: PoolWorker;
    try {
      w = this.workerFactory();
    } catch (e) {
      // First spawn failure latches: the worker module is unusable, so don't
      // retry on every request. Reject all queued work so callers don't hang.
      this.spawnFailed = true;
      const err = new Error(
        'ffi-pool: failed to spawn worker — ' + (e instanceof Error ? e.message : String(e)),
      );
      const queued = this.queue.splice(0);
      for (const req of queued) req.onError(err);
      return null;
    }

    const slot: WorkerSlot = { worker: w, inFlight: null, surplus: false };

    w.addEventListener('message', (event) => {
      const msg = event.data as WorkerResponse;
      const req = slot.inFlight;
      if (!req || msg?.id !== req.id) return;
      req.onResponse(msg);
      this.releaseSlot(slot);
    });

    w.addEventListener('error', (event) => {
      // Reject only THIS worker's in-flight call; sibling workers are fine.
      // Drop the slot; the next request that needs a worker spawns a fresh
      // one. Matches the prior single-worker respawn-on-next-request model,
      // now isolated to the crashed worker.
      const err = new Error('ffi-pool: worker errored — ' + (event.message || 'unknown'));
      const req = slot.inFlight;
      this.removeSlot(slot);
      // Terminate the crashed worker so its thread (and dlopen'd dylib) is
      // released — dropping it from the pool alone leaks the worker. Mirrors
      // the prior single-worker `this.worker?.terminate()` cleanup. Best-effort:
      // a throw here must not break crash recovery (reject + respawn) below.
      try {
        slot.worker.terminate();
      } catch {
        // best-effort
      }
      if (req) req.onError(err);
      this.dispatch();
    });

    this.slots.push(slot);
    return slot;
  }

  /** A worker finished its call. Terminate it if it was retired on a shrink,
   * otherwise hand it the next queued request. */
  private releaseSlot(slot: WorkerSlot): void {
    slot.inFlight = null;
    if (slot.surplus) {
      this.terminateSlot(slot);
      return;
    }
    this.dispatch();
  }

  private terminateSlot(slot: WorkerSlot): void {
    this.removeSlot(slot);
    try {
      slot.worker.terminate();
    } catch {
      // best-effort
    }
  }

  private removeSlot(slot: WorkerSlot): void {
    const i = this.slots.indexOf(slot);
    if (i !== -1) this.slots.splice(i, 1);
  }
}

let _pool: FfiWorkerPool | null = null;

/** Process-wide FFI pool. Lazily constructed on first call. */
export function ffiPool(): FfiWorkerPool {
  if (!_pool) _pool = new FfiWorkerPool();
  return _pool;
}

/** Test-only: drop the singleton so a fresh pool is built next call. */
export function _resetFfiPoolForTests(): void {
  _pool = null;
}

/** Test-only: build an isolated pool with an injected worker factory. The
 * `availableOverride` skips the real dylib probe so dispatch logic can run
 * without the native lib. */
export function _createFfiPoolForTests(opts: {
  workerFactory: WorkerFactory;
  availableOverride?: boolean;
}): FfiWorkerPool {
  return new FfiWorkerPool({
    workerFactory: opts.workerFactory,
    availableOverride: opts.availableOverride ?? true,
  });
}

export type { FfiWorkerPool };
