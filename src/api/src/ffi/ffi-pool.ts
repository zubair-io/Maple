// N-process FFI decode pool. Off-main-PROCESS thumbnail / preview / histogram
// rendering so the synchronous bun:ffi symbol calls neither block HTTP
// handlers nor, when libraw segfaults on a malformed RAW, take down the API.
//
// Why off-process (not just off-thread): bun:ffi calls run inline on whichever
// thread invokes them, so the embedded-preview extractor (single-threaded C)
// pegs exactly one core per in-flight decode. The prior design moved that onto
// a Bun Worker THREAD — which kept the event loop responsive but shared the
// process address space, so a SIGSEGV deep in libraw on one bad asset killed
// the WHOLE API process (a native crash is not a catchable JS exception). Under
// `restart: unless-stopped` that became a crash-loop (reboot → re-index → re-hit
// the poison asset → re-crash) that pinned the CPU. Each "worker" is now an
// isolated child PROCESS: a native crash kills only that child, the pool
// observes the exit and rejects just its in-flight call, and the HTTP server
// keeps serving. The uncatchable process-kill becomes a catchable rejection the
// stage handler already turns into a soft skip. See `ffi-child-worker.ts`.
//
// Why a pool (not one): with one child the whole pipeline serializes RAW
// thumb/preview behind a single decode; a pool of N lets N decodes run on N
// cores at once. The size is operator-tunable and DB-persisted (see
// `ffi-pool-config.repo.ts`) — default 1 keeps the historical single-decode
// behaviour, pure opt-in.
//
// Why TWO lanes (not one pool): since #3499 the cheap bitmap ops
// (`renderBitmap`, `validateAvif`) share the same queue as multi-second RAW
// demosaics, so one RAW decode head-of-line-blocks every JPEG thumb behind
// it (measured #3527: 4 bitmaps fired with one CR2 develop finished at
// 8.3–8.7s on a 1-wide pool vs ~0.18s unblocked). The bitmap lane is a second
// `WorkerSlotPool` pinned at 1 child, so bitmap work always has a child that
// RAW work can never occupy — the pre-#3499 property (bitmaps ran
// concurrently with RAW in the retired imgdecode child) restored without
// raising RAW decode parallelism or its RAM ceiling. Same child script serves
// both lanes; the dispatch arms already live side by side in
// `raw_ffi-dispatch.ts`, and every heavy arm re-restores its lens profile per
// request, so no request has affinity for a particular child.
//
// Dispatch model, resize semantics and crash recovery live in
// `ffi-pool-slots.ts` — this file is the typed request surface (one method
// per protocol message) over that engine, plus the lane routing.

import { nativeLibAvailable } from './raw_ffi.ts';
import type { HistogramBins } from '../thumbs/histogram.ts';
import type { LensProfileInventory } from '../lens-profiles/types.ts';
import type { VerifiedRemovalAssets } from './raw_ffi-removal-assets.ts';
import { defaultChildWorkerFactory } from './ffi-child-worker.ts';
import { WorkerSlotPool } from './ffi-pool-slots.ts';
import type { PendingRequest, PoolWorker, WorkerFactory } from './ffi-pool-slots.ts';

/** The worker plumbing's public types are re-exported here: `ffi-pool.ts`
 * stays the single import site for consumers (`ffi-child-worker.ts`, the
 * pool tests) even though the engine now lives in its own module. */
export type { PoolWorker, WorkerFactory };

/** Which lane a request rides: the operator-sized RAW lane, or the pinned
 * single-child bitmap lane that RAW work can never occupy (#3527). */
type FfiLane = 'raw' | 'bitmap';

/** Bitmap-lane width. Fixed at 1 — deliberately NOT operator-tunable. Bitmap
 * ops are ~0.1s and ~70MB peak (measured #3527), so one serial child clears
 * the whole thumb+preview backlog without ever stalling behind a RAW
 * demosaic, and the extra child costs one 54MB idle process (lazy-spawned:
 * RAW-only libraries never pay it). Raising this would buy nothing the RAW
 * knob doesn't already cover; the knob keeps meaning RAW decode parallelism.
 * Kept as a named constant (not a literal) so the pinning is greppable. */
const BITMAP_POOL_SIZE = 1;

/** One lane's live snapshot — the shape `WorkerSlotPool.stats()` returns. */
export interface FfiLaneStats {
  target: number;
  spawned: number;
  busy: number;
  queued: number;
}

/** `FfiWorkerPool.stats()`: the RAW lane's numbers at the top level (so
 * `target` still reads as the `ffi_workers` knob, and existing consumers are
 * unaffected) plus the bitmap lane's breakdown under `bitmap`. */
export interface FfiPoolStats extends FfiLaneStats {
  bitmap: FfiLaneStats;
}

class FfiWorkerPool {
  private nextId = 1;
  private readonly slotPool: WorkerSlotPool;
  private readonly bitmapPool: WorkerSlotPool;
  /** When set, availability is forced (tests bypass the real dylib probe). */
  private readonly availableOverride: boolean | null;

  constructor(opts?: { workerFactory?: WorkerFactory; availableOverride?: boolean }) {
    const factory = opts?.workerFactory ?? defaultChildWorkerFactory;
    this.slotPool = new WorkerSlotPool(factory);
    this.bitmapPool = new WorkerSlotPool(factory);
    this.bitmapPool.setPoolSize(BITMAP_POOL_SIZE);
    this.availableOverride = opts?.availableOverride ?? null;
  }

  /** True iff the native lib is present. False = caller should degrade (skip
   * RAW thumb/preview/histogram). Deliberately a file-existence check, NOT a
   * `dlopen` probe: pixel decode/encode is isolated in child processes, so a
   * crash there only ever takes down a child.
   * The child does the real `dlopen`, degrading cleanly (ok=false) if unloadable. */
  available(): boolean {
    if (this.availableOverride !== null) return this.availableOverride;
    return nativeLibAvailable();
  }

  async registerLensProfile(profilePath: string): Promise<LensProfileInventory> {
    const id = this.requestId();
    return new Promise((resolve, reject) => {
      this.enqueue({
        id,
        post: (worker) => worker.postMessage({ type: 'registerLensProfile', id, profilePath }),
        onResponse: (message) => {
          if (message.type !== 'registerLensProfile') return false;
          if (message.ok && message.inventory) resolve(message.inventory);
          else reject(new Error(message.error ?? 'LCP import failed'));
          return true;
        },
        onError: reject,
      });
    });
  }

  /** Effective RAW-lane pool size (lazy spawn ceiling) — the `ffi_workers`
   * knob. The bitmap lane is pinned at `BITMAP_POOL_SIZE` and never resized. */
  poolSize(): number {
    return this.slotPool.poolSize();
  }

  /** Live snapshot for diagnostics: the RAW lane's configured target, spawned
   * worker count, busy count, and queue depth at the top level, plus the
   * bitmap lane's breakdown under `bitmap`. */
  stats(): FfiPoolStats {
    return { ...this.slotPool.stats(), bitmap: this.bitmapPool.stats() };
  }

  /** Set the RAW lane's target pool size (clamped to [MIN, MAX]); see
   * `ffi-pool-slots.ts` for the grow/shrink semantics. The bitmap lane stays
   * pinned at `BITMAP_POOL_SIZE`. */
  setPoolSize(n: number): void {
    this.slotPool.setPoolSize(n);
  }

  /** Shared enqueue for the three `_to_file` render requests (renderThumb /
   * renderDevelop / exportRecipe): all three write the image in the
   * child and report only ok/error, and share the same dispatch/promise
   * plumbing. `payload` carries the type-specific fields.
   *
   * Resolves `true` on success. REJECTS on any render failure — the child
   * sets `error` whenever the render returns non-ok — and on infra errors
   * (child crash, dylib missing). The `resolve(false)` below is an
   * unreachable defensive fallback for a malformed ok=false/no-error reply. */
  private renderToFile(
    type: 'renderThumb' | 'renderDevelop' | 'exportRecipe',
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const id = this.requestId();
    return new Promise<boolean>((resolve, reject) => {
      this.enqueue({
        id,
        post: (w) => w.postMessage({ type, id, ...payload }),
        onResponse: (msg) => {
          if (msg.type !== type) return false;
          if (msg.ok) resolve(true);
          else if (msg.error) reject(new Error(msg.error));
          else resolve(false);
          return true;
        },
        onError: reject,
      });
    });
  }

  /** Render a RAW thumbnail (AVIF) to disk. Resolves `true` on success;
   * REJECTS on a render failure or infra error (worker crash, dylib missing)
   * — callers feed the rejection into the stage retry/dead-letter path. */
  async renderThumbnailAvifToFile(
    rawPath: string,
    outPath: string,
    maxPx: number,
    quality = 55,
  ): Promise<boolean> {
    return this.renderToFile('renderThumb', {
      rawPath,
      outPath,
      maxPx,
      quality,
    });
  }

  /** Develop a RAW with `xmpPath` applied (null = neutral) and write the JPEG
   * to `outPath`. The developed counterpart to `renderThumbnailAvifToFile`
   * (#1950). Resolves `true` on success; REJECTS on a render failure or infra
   * error (child crash, dylib missing). */
  async exportRecipeToFile(
    rawPath: string,
    xmp: string,
    recipeJson: string,
    filmPath: string | null,
    outPath: string,
  ): Promise<boolean> {
    return this.renderToFile('exportRecipe', {
      rawPath,
      xmp,
      recipeJson,
      filmPath,
      outPath,
    });
  }

  async renderDevelopJpegToFile(
    rawPath: string,
    xmpPath: string | null,
    outPath: string,
    maxPx: number,
    quality = 82,
  ): Promise<boolean> {
    return this.renderToFile('renderDevelop', {
      rawPath,
      xmpPath,
      outPath,
      maxPx,
      quality,
    });
  }

  /** Render a non-RAW bitmap (JPEG/PNG/WebP/TIFF/AVIF/HEIC/PSD/HDR) to a
   * resized AVIF on disk inside the FFI child. Rides the bitmap lane, so it
   * never queues behind a RAW demosaic (#3527). Resolves the child's
   * `{ ok, error }` (never rejects on a render failure — only on infra
   * failure), matching what the retired imgdecode pool returned so call
   * sites keep their error handling. */
  async renderBitmapThumbToFile(
    srcPath: string,
    outPath: string,
    maxPx: number,
    quality: number,
    ext: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const id = this.requestId();
    return new Promise((resolve, reject) => {
      this.enqueue(
        {
          id,
          post: (w) =>
            w.postMessage({
              type: 'renderBitmap',
              id,
              srcPath,
              outPath,
              maxPx,
              quality,
              ext,
            }),
          onResponse: (msg) => {
            if (msg.type !== 'renderBitmap') return false;
            resolve({ ok: msg.ok, error: msg.error });
            return true;
          },
          onError: reject,
        },
        'bitmap',
      );
    });
  }

  /** Decode-validate an AVIF this pipeline just wrote (see `thumbs/avif-checks.ts`).
   * Rides the bitmap lane with the render it validates, never behind RAW (#3527). */
  async validateAvif(
    filePath: string,
    expectedLongEdgePx: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    const id = this.requestId();
    return new Promise((resolve, reject) => {
      this.enqueue(
        {
          id,
          post: (w) => w.postMessage({ type: 'validateAvif', id, filePath, expectedLongEdgePx }),
          onResponse: (msg) => {
            if (msg.type !== 'validateAvif') return false;
            resolve({ ok: msg.ok, reason: msg.reason });
            return true;
          },
          onError: reject,
        },
        'bitmap',
      );
    });
  }

  /** Read camera as-shot white balance in the isolated child process.
   * Rejects if the native library or the RAW's baseline is unavailable. */
  async asShotWhiteBalance(rawPath: string): Promise<{ temperature: number; tint: number }> {
    const id = this.requestId();
    return new Promise((resolve, reject) => {
      this.enqueue({
        id,
        post: (w) => w.postMessage({ type: 'asShot', id, rawPath }),
        onResponse: (msg) => {
          if (msg.type !== 'asShot') return false;
          if (msg.ok && msg.baseline) resolve(msg.baseline);
          else reject(new Error(msg.error ?? 'Cannot read as-shot white balance'));
          return true;
        },
        onError: reject,
      });
    });
  }

  /** Render a RAW with the sidecar applied and return the child's 3×256 RGB bins.
   * Rejects on dylib-missing or any render failure. */
  async computeHistogram(rawPath: string, xmpPath: string | null): Promise<HistogramBins> {
    const id = this.requestId();
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

  async verifyRemovalAssets(rawPath: string, records: string): Promise<VerifiedRemovalAssets> {
    return this.verifyRemoval('removalAssets', rawPath, records);
  }

  async verifyRemovalSource(rawPath: string, records: string): Promise<VerifiedRemovalAssets> {
    return this.verifyRemoval('removalSource', rawPath, records);
  }

  async verifyRemovalAsset(filePath: string, name: string): Promise<void> {
    const id = this.requestId();
    return new Promise((resolve, reject) =>
      this.enqueue({
        id,
        post: (w) => w.postMessage({ type: 'validateRemovalAsset', id, filePath, name }),
        onResponse: (msg) => {
          if (msg.type !== 'validateRemovalAsset') return false;
          if (msg.ok) resolve();
          else reject(new Error(msg.error ?? 'Removal asset validation failed'));
          return true;
        },
        onError: reject,
      }),
    );
  }

  private async verifyRemoval(
    type: 'removalAssets' | 'removalSource',
    rawPath: string,
    records: string,
  ): Promise<VerifiedRemovalAssets> {
    const id = this.requestId();
    return new Promise((resolve, reject) =>
      this.enqueue({
        id,
        post: (w) => w.postMessage({ type, id, rawPath, records }),
        onResponse: (msg) => {
          if (msg.type !== type) return false;
          if (msg.ok && msg.assets) resolve(msg.assets);
          else reject(new Error(msg.error ?? 'Removal asset validation failed'));
          return true;
        },
        onError: reject,
      }),
    );
  }

  /** True once `shutdown()` has run — `ffiPool()` uses this (#3524). Either
   * lane shut down means the pool is done; `shutdown()` always stops both. */
  get isShutDown(): boolean {
    return this.slotPool.isShutDown || this.bitmapPool.isShutDown;
  }

  /** Terminate every child in both lanes and stop spawning new ones — the
   * server's graceful shutdown path; see `ffi-pool-slots.ts` for why the
   * children must be reaped explicitly and what happens to in-flight work. */
  shutdown(): void {
    this.slotPool.shutdown();
    this.bitmapPool.shutdown();
  }

  // ── internals ─────────────────────────────────────────────

  /** Every request checks native availability before consuming a queue identity. */
  private requestId(): number {
    if (!this.available()) throw new Error('ffi-pool: raw-ffi dylib not available');
    return this.nextId++;
  }

  /** Route one request onto its lane's queue. RAW is the default; only the
   * cheap bitmap ops (`renderBitmap`, `validateAvif`) pass `'bitmap'`. */
  private enqueue(req: PendingRequest, lane: FfiLane = 'raw'): void {
    (lane === 'bitmap' ? this.bitmapPool : this.slotPool).enqueue(req);
  }
}

let _pool: FfiWorkerPool | null = null;

/** Process-wide FFI pool. Lazily constructed on first call. */
export function ffiPool(): FfiWorkerPool {
  if (!_pool || _pool.isShutDown) _pool = new FfiWorkerPool();
  return _pool;
}

/** Test-only: drop the singleton so a fresh pool is built next call. */
export function _resetFfiPoolForTests(): void {
  _pool = null;
}

/** Test-only: install a stand-in for the process-wide pool, returning
 * whatever was there before. Mirrors `setRawFfiForTests` /
 * `setDescribeDepsForTests`. Needed because the indexer's RAW paths reach
 * for `ffiPool()` directly, so there is otherwise no way to exercise their
 * dispatch decisions without the native dylib.
 *
 * Returns the previous value so callers can RESTORE it rather than passing
 * `null`. Nulling drops the reference to an already-constructed pool
 * without shutting it down, orphaning any workers it spawned — and this
 * singleton is process-wide, so a suite that built a real pool earlier
 * (`thumbnailer.test.ts` does, via `ffiPool().available()`) would leak it. */
export function _setFfiPoolForTests(pool: FfiWorkerPool | null): FfiWorkerPool | null {
  const previous = _pool;
  _pool = pool;
  return previous;
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
