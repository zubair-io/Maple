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

import { tryGetRawFfi } from "./raw_ffi.ts";

interface RenderRequest {
  type: "renderThumb";
  id: number;
  rawPath: string;
  outPath: string;
  maxPx: number;
  quality: number;
}

interface RenderResponse {
  type: "renderThumb";
  id: number;
  ok: boolean;
  error?: string;
}

const ffi = tryGetRawFfi();

self.addEventListener("message", (event: MessageEvent) => {
  const req = event.data as RenderRequest;
  if (req?.type !== "renderThumb") return;

  if (!ffi) {
    self.postMessage({
      type: "renderThumb",
      id: req.id,
      ok: false,
      error: "raw-ffi dylib not loaded in worker",
    } satisfies RenderResponse);
    return;
  }

  try {
    const ok = ffi.renderThumbnailJpegToFile(
      req.rawPath,
      req.outPath,
      req.maxPx,
      req.quality,
    );
    self.postMessage({
      type: "renderThumb",
      id: req.id,
      ok,
      error: ok ? undefined : "render-failed (see worker stderr)",
    } satisfies RenderResponse);
  } catch (e) {
    self.postMessage({
      type: "renderThumb",
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    } satisfies RenderResponse);
  }
});
