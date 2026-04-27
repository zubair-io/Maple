// panorama.service.ts — Angular facade for the panorama Web Worker.
//
// Hides the postMessage RPC behind a Promise-returning stitch() method.
// Lazy-instantiates the worker on first call; reuses it for subsequent
// stitches. Only one stitch may be in flight at a time (stitching is
// memory-intensive and sequential ensures the WASM heap stays bounded).
//
// Build note:
//   Requires the raw-wasm bundle built with --features pano.  If the bundle
//   is missing PanoHandle.stitch the worker will reject with a clear error:
//     "TypeError: PanoHandle.stitch is not a function"
//   Rebuild:
//     cd src/raw-pipeline/raw-wasm
//     wasm-pack build --target web --features pano
//   Then sync:
//     ./src/web/scripts/sync-raw-wasm.sh

import { Injectable, OnDestroy, signal } from '@angular/core';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/** Projection geometry for the stitched panorama. */
export type PanoProjection = 'rectilinear' | 'cylindrical' | 'spherical';

/** Parallax strategy.  TPS is accepted but ignored in the MVP. */
export type PanoParallaxMode = 'homography' | 'tps';

export interface StitchOptions {
  /** Output projection.  Defaults to 'cylindrical'. */
  projection?: PanoProjection;
  /** Parallax mode.  Defaults to 'homography'. */
  parallaxMode?: PanoParallaxMode;
  /**
   * Clamp the long edge of the output to this many pixels.
   * 0 means unconstrained (default).
   */
  maxDimension?: number;
}

export interface StitchResult {
  width: number;
  height: number;
  /**
   * f16 interleaved RGB pixel buffer (3 channels × 2 bytes per pixel),
   * row-major, scene-linear Rec.2020 D65.
   *
   * Caller is responsible for rendering this to a WebGL / WebGPU canvas.
   * The buffer is transferred from the worker (zero-copy) — do not retain
   * a reference across renders.
   */
  pixelsF16: Uint16Array;
}

// ---------------------------------------------------------------------------
// Internal RPC types (must stay in sync with panorama.worker.ts)
// ---------------------------------------------------------------------------

interface StitchRequest {
  id: number;
  type: 'stitch';
  images: ArrayBuffer[];
  options: { projection: number; parallaxMode: number; maxDimension: number };
}

interface WorkerSuccess {
  id: number;
  ok: true;
  width: number;
  height: number;
  pixelsF16: ArrayBuffer;
}

interface WorkerError {
  id: number;
  ok: false;
  error: string;
}

type WorkerReply = WorkerSuccess | WorkerError;

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

const PROJECTION_MAP: Record<PanoProjection, number> = {
  rectilinear: 0,
  cylindrical: 1,
  spherical: 2,
};

const PARALLAX_MAP: Record<PanoParallaxMode, number> = {
  homography: 0,
  tps: 1,
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class PanoramaService implements OnDestroy {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: WorkerReply) => void; reject: (e: Error) => void }
  >();

  /**
   * True while a stitch is in progress.  Bind in templates to disable the
   * "Stitch panorama" button or show a progress indicator.
   */
  readonly busy = signal(false);

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Stitch two or more PNG/JPEG images into a panorama.
   *
   * - Input images must be raw byte buffers (PNG or JPEG).  DNG is accepted
   *   by the underlying pipeline but may be slow.
   * - At most one stitch may be in flight at a time.  Calling stitch() while
   *   busy throws immediately without waiting.
   * - The returned `pixelsF16` buffer is transferred from the worker
   *   (zero-copy).  Read it before the next stitch or it may be detached.
   *
   * @param images  Two or more Uint8Array byte buffers (one per image).
   * @param options Optional stitch configuration.
   * @throws If a stitch is already in progress, if fewer than 2 images are
   *         provided, or if the worker rejects (decode/stitch failure).
   */
  async stitch(images: Uint8Array[], options: StitchOptions = {}): Promise<StitchResult> {
    if (this.busy()) {
      throw new Error('PanoramaService: a stitch is already in progress');
    }
    if (images.length < 2) {
      throw new Error('PanoramaService: stitch requires at least 2 images');
    }

    this.busy.set(true);
    try {
      const worker = this.ensureWorker();
      const id = this.nextId++;

      // Transfer the underlying buffers so the main thread releases its copy.
      // Each Uint8Array view may share a buffer; slice to isolate before
      // transfer.  The slice always returns a plain ArrayBuffer (not
      // SharedArrayBuffer), but TypeScript's lib typings widen the return to
      // `ArrayBuffer | SharedArrayBuffer` — cast to silence the false-positive.
      const buffers = images.map((u8) =>
        u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer,
      );

      const opts = {
        projection: PROJECTION_MAP[options.projection ?? 'cylindrical'],
        parallaxMode: PARALLAX_MAP[options.parallaxMode ?? 'homography'],
        maxDimension: options.maxDimension ?? 0,
      };

      const request: StitchRequest = { id, type: 'stitch', images: buffers, options: opts };

      const reply = await new Promise<WorkerReply>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        worker.postMessage(request, buffers);
      });

      if (!reply.ok) {
        throw new Error(`PanoramaService: ${reply.error}`);
      }

      return {
        width: reply.width,
        height: reply.height,
        // Wrap the transferred ArrayBuffer — no copy.
        pixelsF16: new Uint16Array(reply.pixelsF16),
      };
    } finally {
      this.busy.set(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  ngOnDestroy(): void {
    this.worker?.terminate();
    this.worker = null;
    const err = new Error('PanoramaService destroyed');
    this.pending.forEach(({ reject }) => reject(err));
    this.pending.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    this.worker = new Worker(
      new URL('./panorama.worker', import.meta.url),
      { type: 'module' },
    );

    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      const handler = this.pending.get(reply.id);
      if (!handler) return; // stale reply after destroy — ignore
      this.pending.delete(reply.id);
      handler.resolve(reply);
    };

    this.worker.onerror = (event: ErrorEvent) => {
      console.error('[PanoramaService] worker error:', event.message);
      const err = new Error(`PanoramaService worker error: ${event.message}`);
      this.pending.forEach(({ reject }) => reject(err));
      this.pending.clear();
      // Null the worker so the next stitch spawns a fresh one.
      this.worker = null;
    };

    return this.worker;
  }
}
