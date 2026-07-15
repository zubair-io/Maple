/// <reference lib="webworker" />

// embedded-preview.worker.ts — dedicated worker for embedded-RAW-preview
// extraction (#2010, epic #1993 Stage 4).
//
// Deliberately a SEPARATE worker from `raw-pipeline.worker.ts` (the
// decode/live-render worker) — same reasoning `maple-id-fallback.worker.ts`
// documents for #1995's streaming id-hasher (see that file's module doc):
// `raw-pipeline.service.ts` enforces a single-in-flight-decode gate
// (`decodeChain`) because a RAW develop's f32 scratch buffers can blow past
// the wasm32 4 GiB heap cap if two decodes overlap — that gate exists to
// protect the performance-critical live-render path (CLAUDE.md's 16ms
// slider-tick budget). Embedded-preview extraction runs during ordinary
// folder browsing, independent of whether an image is open for editing, and
// is fundamentally lighter than a full develop (decode ONE embedded JPEG +
// resize + re-encode — no demosaic/AgX/view-transform), so it doesn't need
// that gate's protection either; folding it into the decode worker would
// only add unrelated contention for zero benefit. This worker loads the
// SAME `pkg/raw_wasm` bundle (the browser caches the compiled WASM module
// across worker instances on the same origin, so the extra load is cheap)
// but only ever touches `extract_embedded_preview` — no rayon thread pool,
// no GPU session, no `initRawWasm()`.
//
// Not re-exported from `public-api.ts` — reachable only via the runtime
// `new Worker(new URL('./embedded-preview.worker', import.meta.url))` call
// in `embedded-preview.service.ts`, which does not create a static import
// edge ng-packagr would try to resolve (see that service's module doc, and
// `raw-pipeline.service.ts`'s `ensureWorker()` for the identical pattern).

// Same gitignored, wasm-pack-generated path `raw-pipeline.worker.ts` already
// imports; only resolvable after the raw-wasm build+sync step, which
// fallow's audit job doesn't run.
// fallow-ignore-next-line unresolved-import
import init, { extract_embedded_preview, install_panic_hook } from './pkg/raw_wasm';
import type { ExtractPreviewRequest, ExtractPreviewResponse } from './embedded-preview.types';

let readyPromise: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = init().then(() => {
      // Surface Rust panics in DevTools instead of opaque WASM traps.
      try {
        install_panic_hook();
      } catch {
        // Older pkg without the export — non-fatal.
      }
    });
  }
  return readyPromise;
}

function post(msg: ExtractPreviewResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handleExtract(req: ExtractPreviewRequest): Promise<void> {
  try {
    await ensureReady();
    const result = extract_embedded_preview(
      new Uint8Array(req.raw),
      req.ext,
      req.maxLongEdge,
      req.quality,
    );
    const width = result.width;
    const height = result.height;
    // `take_jpeg()` moves the bytes out of the WASM-side struct rather than
    // cloning (mirrors `MapleRender.take_rgb()`'s contract) — wasm-bindgen
    // marshals an owned `Vec<u8>` return into a freshly-allocated JS
    // `Uint8Array`, so `.buffer` is already independent of the WASM heap
    // and safe to transfer.
    const jpeg = result.take_jpeg();
    const jpegBuffer = jpeg.buffer as ArrayBuffer;
    post({ id: req.id, type: 'extract-preview-success', width, height, jpeg: jpegBuffer }, [
      jpegBuffer,
    ]);
  } catch (err) {
    post({ id: req.id, type: 'extract-preview-error', message: errorMessage(err) });
  }
}

addEventListener('message', (event: MessageEvent<ExtractPreviewRequest>) => {
  void handleExtract(event.data);
});
