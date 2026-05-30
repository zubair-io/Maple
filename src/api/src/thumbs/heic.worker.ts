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

import { renderHeicThumbToFile } from "./render.ts";

interface DecodeRequest {
  type: "decodeHeic";
  id: number;
  srcPath: string;
  thumbPath: string;
  sizePx: number;
}

interface DecodeResponse {
  type: "decodeHeic";
  id: number;
  ok: boolean;
  error?: string;
}

self.addEventListener("message", async (event: MessageEvent) => {
  const req = event.data as DecodeRequest;
  if (req?.type !== "decodeHeic") return;

  try {
    await renderHeicThumbToFile(req.srcPath, req.thumbPath, req.sizePx);
    self.postMessage({
      type: "decodeHeic",
      id: req.id,
      ok: true,
    } satisfies DecodeResponse);
  } catch (e) {
    self.postMessage({
      type: "decodeHeic",
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    } satisfies DecodeResponse);
  }
});
