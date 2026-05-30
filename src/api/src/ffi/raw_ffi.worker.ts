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
import { computeHistogram, type HistogramBins } from '../thumbs/histogram.ts';

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
      // Render-with-xmp + bin in-place. We deliberately bin INSIDE the
      // worker so only the 3×256 bin arrays (~4 KB) cross postMessage —
      // shipping the rendered RGB888 buffer back to the main thread for a
      // 100 MP frame would post ~300 MB per request and defeat the
      // worker boundary.
      const result = ffi.renderToRgb(req.rawPath, req.xmpPath ?? null);
      if (!result) {
        self.postMessage({
          type: 'histogram',
          id: req.id,
          ok: false,
          error: 'render-failed (see worker stderr)',
        } satisfies HistogramResponse);
        return;
      }
      const bins = computeHistogram(result.data, result.width, result.height);
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
