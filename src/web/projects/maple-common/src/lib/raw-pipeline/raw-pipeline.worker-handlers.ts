// raw-pipeline.worker-handlers.ts
// Extracted from raw-pipeline.worker.ts (pure code move — no behaviour change).
// Contains: WebLiveSession interface declarations, scope-readback module state and
// the `readbackScopeSnapshot()` helper function.

import type { ScopeSnapshot } from './raw-pipeline.types';

/**
 * The `WebLiveSession` class from the `gpu`-feature WASM build (#1038). Typed
 * locally (the default bundle omits it); read off the module namespace and
 * existence-checked. `open` is a static async constructor; the instance exposes an
 * async `render(xmp)` and getters for dims + As-Shot WB.
 */
export interface WebLiveSessionInstance {
  render(xmp: string | null): Promise<string>;
  /** Developed (viewport-sized per #1080) dims == the canvas dims. */
  readonly width: number;
  readonly height: number;
  /** Native oriented dims — what a full-res render would produce (#1080). */
  readonly fullWidth: number;
  readonly fullHeight: number;
  readonly asShotTemperature: number;
  readonly asShotTint: number;
  readonly colorSpace: string;
  free(): void;
}
export interface WebLiveSessionCtor {
  open(
    raw: Uint8Array,
    ext: string,
    xmp: string | null,
    canvas: OffscreenCanvas,
    // Viewport target in real pixels (#1080): the session develop fits the
    // image to this long edge and sizes the canvas to the developed dims.
    // undefined => the WASM-side 2048 default cap.
    maxLongEdge?: number,
  ): Promise<WebLiveSessionInstance>;
}

// ── Scope readback (#1045) ───────────────────────────────────────────────────
// The GPU live path presents straight to the transferred `OffscreenCanvas` with NO
// CPU readback, so the histogram/waveform/parade/vectorscope scopes (which read a
// CPU-side `currentPixels` RGBA on the 2D path) had no pixel source and went stale.
// We retain the canvas JS ref here (passing it to wasm `open()` does NOT neuter the
// ref) and, AFTER each present, draw it — downsampled — onto a small 2D canvas and
// read back a tiny RGB snapshot to fold into the session reply. Scopes are
// statistical reductions, so a small downsampled readback of exactly the displayed
// pixels is the apt source (cheaper than a full-res buffer, and reflects what the
// user sees). Wrapped in try/catch: any failure (gpu-off bundle never opens a
// session; a surface that isn't `drawImage`-able; a 2D-context miss) returns null,
// the reply omits the snapshot, and the component leaves `currentPixels` null →
// the scopes render their pseudo fallback, i.e. exactly today's flag-on behaviour.

/** The transferred editor `OffscreenCanvas` for the open session — the readback source. */
export let liveCanvas: OffscreenCanvas | null = null;

/** Long-edge cap for the scope readback. Scopes are ~100–250px wide; a 512px long
 *  edge oversamples them comfortably while keeping the readback + transfer trivial. */
const SCOPE_READBACK_MAX_DIM = 512;

/** Reusable downsample target so a slider drag doesn't churn `OffscreenCanvas`es. */
let scopeReadbackCanvas: OffscreenCanvas | null = null;

/**
 * Set the live canvas reference used by `readbackScopeSnapshot()`.
 * Call this from the worker after a successful session open or close.
 */
export function setLiveCanvas(canvas: OffscreenCanvas | null): void {
  liveCanvas = canvas;
}

/**
 * Draw the presented GPU `OffscreenCanvas` onto a small 2D canvas and read back a
 * downsampled, packed-RGB snapshot for the scopes (#1045). Returns null (caller
 * omits the snapshot → scopes keep their pseudo fallback) on any failure, so the
 * GPU path is never WORSE than today even if a browser won't snapshot the surface.
 *
 * `OffscreenCanvas` is undefined-guarded by the open path already; this only runs
 * after a successful present, when `liveCanvas` is set.
 */
export function readbackScopeSnapshot(): ScopeSnapshot | null {
  const src = liveCanvas;
  if (!src || typeof OffscreenCanvas === 'undefined') return null;
  try {
    const srcW = src.width;
    const srcH = src.height;
    if (srcW === 0 || srcH === 0) return null;
    const scale = Math.min(1, SCOPE_READBACK_MAX_DIM / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    if (!scopeReadbackCanvas) {
      scopeReadbackCanvas = new OffscreenCanvas(w, h);
    } else if (scopeReadbackCanvas.width !== w || scopeReadbackCanvas.height !== h) {
      scopeReadbackCanvas.width = w;
      scopeReadbackCanvas.height = h;
    }
    const ctx = scopeReadbackCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, w, h);
    // A webgpu-context canvas is a valid `drawImage` SOURCE (its current presented
    // contents are snapshotted); we can't `getContext('2d')` on it, hence the
    // separate 2D target. The snapshot reflects the last presented frame.
    ctx.drawImage(src as unknown as CanvasImageSource, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    // Pack RGBA → RGB to match the `DecodedImage` / `DecodeSuccess.rgb` contract.
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    const buffer = rgb.buffer.slice(0, rgb.byteLength) as ArrayBuffer;
    return { width: w, height: h, rgb: buffer };
  } catch (e) {
    // Surface-not-snapshottable / context miss → no snapshot (scopes stay on pseudo).
    console.warn('[raw-pipeline.worker] scope readback failed; scopes use fallback:', e);
    return null;
  }
}
