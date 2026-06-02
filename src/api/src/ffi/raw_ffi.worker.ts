// Bun Worker entry point that owns the raw-ffi dylib for the indexer +
// /api/fs/thumb. Lives on its own JS thread so the synchronous bun:ffi
// symbol calls (50–200 ms per RAW thumbnail) never block the main HTTP
// thread. The main thread talks to this worker via postMessage; one
// in-flight call at a time, queue handled by the manager in `ffi-pool.ts`.
//
// One worker is sufficient for thumbnail generation: bun:ffi calls are
// synchronous within whatever thread invokes them, so adding more workers
// would just consume more memory without unblocking anything (each call
// still runs to completion before the next can start). Throughput is
// gated by the dylib, not the pool size.

import { tryGetRawFfi } from './raw_ffi.ts';
import { type HistogramBins } from '../thumbs/histogram.ts';

interface RenderRequest {
  type: 'renderThumb';
  id: number;
  rawPath: string;
  outPath: string;
  maxPx: number;
  quality: number;
}

interface HistogramRequest {
  type: 'histogram';
  id: number;
  rawPath: string;
  /** Optional XMP sidecar path — applied to the render so a re-edit
   *  invalidates the histogram. Pass null/undefined for default
   *  adjustments (rare; the route always resolves the sidecar). */
  xmpPath: string | null;
}

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

type WorkerRequest = RenderRequest | HistogramRequest;

const ffi = tryGetRawFfi();

self.addEventListener('message', (event: MessageEvent) => {
  const req = event.data as WorkerRequest;

  if (req?.type === 'renderThumb') {
    if (!ffi) {
      self.postMessage({
        type: 'renderThumb',
        id: req.id,
        ok: false,
        error: 'raw-ffi dylib not loaded in worker',
      } satisfies RenderResponse);
      return;
    }
    try {
      const ok = ffi.renderThumbnailJpegToFile(req.rawPath, req.outPath, req.maxPx, req.quality);
      self.postMessage({
        type: 'renderThumb',
        id: req.id,
        ok,
        error: ok ? undefined : 'render-failed (see worker stderr)',
      } satisfies RenderResponse);
    } catch (e) {
      self.postMessage({
        type: 'renderThumb',
        id: req.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      } satisfies RenderResponse);
    }
    return;
  }

  if (req?.type === 'histogram') {
    if (!ffi) {
      self.postMessage({
        type: 'histogram',
        id: req.id,
        ok: false,
        error: 'raw-ffi dylib not loaded in worker',
      } satisfies HistogramResponse);
      return;
    }
    try {
      // Render-with-xmp + bin entirely in Rust; only the 3×256 counts (~3 KB)
      // come back across the FFI boundary, into a JS-owned buffer, and then
      // across postMessage. The rendered RGB888 buffer (≈300 MB at 100 MP)
      // never crosses either boundary — that's the whole point of doing this
      // off the main thread, and binning in Rust also removes the `toBuffer`
      // lifetime trap the old `renderToRgb` path carried (GC double-free).
      const bins = ffi.computeHistogramBins(req.rawPath, req.xmpPath ?? null);
      if (!bins) {
        self.postMessage({
          type: 'histogram',
          id: req.id,
          ok: false,
          error: 'render-failed (see worker stderr)',
        } satisfies HistogramResponse);
        return;
      }
      self.postMessage({
        type: 'histogram',
        id: req.id,
        ok: true,
        bins,
      } satisfies HistogramResponse);
    } catch (e) {
      self.postMessage({
        type: 'histogram',
        id: req.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      } satisfies HistogramResponse);
    }
    return;
  }
});
