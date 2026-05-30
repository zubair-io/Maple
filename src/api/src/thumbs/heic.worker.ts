// Bun Worker entry point that owns HEIC/HEIF decode for `/api/fs/thumb` and
// the indexer's thumb/preview stages. Lives on its own JS thread so the
// synchronous `heic-convert` decode (libheif compiled to Emscripten WASM,
// ~500–2000 ms per file) never blocks the main HTTP thread. Before this
// worker, a single HEIC cache miss froze the entire Bun event loop —
// including /api/health and static HTML — for the whole decode.
//
// The worker imports the *same* canonical chain (`renderHeicThumbToFile`) the
// in-process fallback uses, so its on-disk output is byte-identical to running
// the chain in-process — the move off-thread changes timing only, never bytes.
//
// The large input buffer and intermediate JPEG stay INSIDE this worker; only
// the tiny `{ ok, error? }` result crosses postMessage back to the manager
// (`heic-pool.ts`). Same discipline as the FFI histogram path, which bins the
// ~300 MB render buffer in-worker and ships back only the 4 KB result.

import { renderHeicThumbToFile } from './render.ts';

interface DecodeRequest {
  type: 'decodeHeic';
  id: number;
  srcPath: string;
  thumbPath: string;
  sizePx: number;
}

interface DecodeResponse {
  type: 'decodeHeic';
  id: number;
  ok: boolean;
  error?: string;
}

// Serialize renders inside the worker. The sibling FFI/cluster workers get
// one-at-a-time for free because their handlers are SYNCHRONOUS — the worker
// event loop runs each message to completion before picking up the next. The
// HEIC chain has real awaits (readFile → heic-convert → sharp), so an `async`
// handler would yield at the first await and let a second message start a
// second render, leaving multiple large input + intermediate-JPEG buffers
// resident during a burst. Instead the handler is synchronous: it appends the
// job to a promise chain and returns immediately. Only the running link
// allocates buffers, so peak memory stays at one input + one intermediate
// regardless of burst depth; queued jobs sit in the chain as tiny closures.
let tail: Promise<void> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent) => {
  const req = event.data as DecodeRequest;
  if (req?.type !== 'decodeHeic') return;

  tail = tail.then(async () => {
    try {
      await renderHeicThumbToFile(req.srcPath, req.thumbPath, req.sizePx);
      self.postMessage({
        type: 'decodeHeic',
        id: req.id,
        ok: true,
      } satisfies DecodeResponse);
    } catch (e) {
      self.postMessage({
        type: 'decodeHeic',
        id: req.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      } satisfies DecodeResponse);
    }
  });
});
