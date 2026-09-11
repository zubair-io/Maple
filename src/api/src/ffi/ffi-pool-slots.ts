// Worker-slot engine behind `ffi-pool.ts`: the pending-request queue, the
// per-child slots, and the spawn / dispatch / resize / crash-recovery
// plumbing every FFI request method sits on top of.
//
// Split out of `ffi-pool.ts` (#3499) along the seam that was already there —
// nothing in here knows what an FFI request MEANS (it moves opaque
// `PendingRequest`s onto whichever child is free), and nothing left in
// `ffi-pool.ts` touches a slot directly. That file is now just the typed
// request surface: one method per protocol message.
//
// Dispatch model: a queue of pending requests + a set of workers, each with
// a busy flag. A request grabs a free (idle, non-surplus) worker, else it
// lazy-spawns one up to `targetSize`, else it queues. When a worker frees it
// pulls the next queued request. We don't pay N child spawns (+ N dlopens)
// until there's work — children spawn on demand up to the target.
//
// Resize (setPoolSize): grow → raise the spawn ceiling and drain the queue
// (idle work spawns the extra children lazily). Shrink → mark surplus workers;
// each terminates AFTER its in-flight call drains — we never kill a child
// mid-decode.
//
// Crash handling: a worker `error` (the child's unexpected `onExit`) rejects
// only ITS in-flight call, drops the child, and re-dispatches the queue (a
// fresh child spawns on the next request that needs one). Sibling children's
// in-flight calls are untouched.

import type { FfiResponse } from './raw_ffi-protocol.ts';
import { DEFAULT_FFI_WORKERS, MAX_FFI_WORKERS, MIN_FFI_WORKERS } from './ffi-pool-config.repo.ts';

/** Minimal worker surface the pool depends on. The `ChildProcessWorker`
 * (Bun.spawn-backed) satisfies this; tests inject a fake so the dispatch /
 * resize / crash logic can be exercised without spawning a real child. */
export interface PoolWorker {
  postMessage(msg: unknown): void;
  terminate(): void;
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void;
  addEventListener(type: 'error', cb: (e: { message?: string }) => void): void;
}

/** Factory that builds a worker. Production passes `defaultChildWorkerFactory`
 * (spawns the real `raw_ffi.child.ts` process); tests pass a fake. */
export type WorkerFactory = () => PoolWorker;

/** A unit of work queued for the next free worker. `post` writes the request
 * onto the worker; `onResponse` decodes a worker message into resolve/reject;
 * `onError` rejects when the worker carrying it crashes. */
export interface PendingRequest {
  id: number;
  post: (w: PoolWorker) => void;
  onResponse: (msg: FfiResponse) => boolean;
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

/** The queue + child-slot machinery. One instance per `FfiWorkerPool`. */
export class WorkerSlotPool {
  private slots: WorkerSlot[] = [];
  private queue: PendingRequest[] = [];
  private targetSize = DEFAULT_FFI_WORKERS;
  private spawnFailed = false;
  private shuttingDown = false;
  private readonly workerFactory: WorkerFactory;

  constructor(workerFactory: WorkerFactory) {
    this.workerFactory = workerFactory;
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

  /** True once `shutdown()` has run — `ffiPool()` uses this (#3524). */
  get isShutDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Terminate every child and stop spawning new ones. Called from the server's
   * graceful shutdown so the isolated decode children are reaped deterministically
   * — Bun does NOT auto-reap a spawned child when the parent exits, and the
   * `disconnect` event is unreliable, so without this they'd linger as orphans.
   * In-flight + queued calls reject so their stage handlers settle (soft-skip)
   * rather than hang on a child that's about to die.
   */
  shutdown(): void {
    this.shuttingDown = true;
    const queued = this.queue.splice(0);
    for (const req of queued) req.onError(new Error('ffi-pool: shutting down'));
    for (const slot of [...this.slots]) {
      const req = slot.inFlight;
      slot.inFlight = null;
      // terminateSlot() flags the child so its onExit isn't read as a crash.
      this.terminateSlot(slot);
      if (req) req.onError(new Error('ffi-pool: shutting down'));
    }
  }

  enqueue(req: PendingRequest): void {
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
    if (this.spawnFailed || this.shuttingDown) return null;
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

    w.addEventListener('message', (event) => this.onWorkerMessage(slot, event.data as FfiResponse));

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

  /** A reply arrived on a worker: settle the in-flight request it answers.
   * `onResponse` returns false when the reply's `type` is not the one the
   * request expects — a child dispatch bug (the child answered with a
   * different arm, or rejected an unrecognised type). Settle the caller with
   * an error rather than leave its promise pending: nothing else (no timeout)
   * would ever resolve it. */
  private onWorkerMessage(slot: WorkerSlot, msg: FfiResponse): void {
    const req = slot.inFlight;
    if (!req || msg?.id !== req.id) return;
    if (!req.onResponse(msg)) {
      // `error` is carried by most reply variants but not all (`validateAvif`
      // reports a `reason` instead), so read it through the union rather than
      // off `msg` directly.
      const detail = 'error' in msg ? msg.error : undefined;
      req.onError(
        new Error(
          `ffi-pool: mismatched response type '${String(msg.type)}' for request ${req.id}` +
            (detail ? ` — ${detail}` : ''),
        ),
      );
    }
    this.releaseSlot(slot);
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
