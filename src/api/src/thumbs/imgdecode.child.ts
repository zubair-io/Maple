/**
 * Non-RAW image decode CHILD PROCESS entry point. Owns the sharp + heic-convert
 * pipeline for thumbnail and preview generation of JPEG/HEIC/PNG/WEBP/TIFF/AVIF,
 * and (#2257) the decode-based AVIF output validator that used to run inline in
 * the API parent process.
 *
 * Why a child process (not the prior Worker thread):
 *   heic-convert is libheif compiled to Emscripten WASM and runs SYNCHRONOUSLY
 *   for ~500–2000 ms per file. A Worker thread shares the API's address space, so
 *   a malformed/huge non-RAW image that OOMs or segfaults inside libheif/libvips
 *   can take down the WHOLE API process. A child process has its own address space:
 *   a crash here kills only THIS child; the parent observes the exit, rejects the
 *   in-flight call, and respawns a fresh child for the next request. The sharp
 *   libuv threadpool runs multiple concurrent decodes from within this one child,
 *   so burst throughput is unchanged. See `imgdecode-pool.ts` / the manager.
 *
 *   The `validate` op decodes a freshly written, possibly malformed AVIF —
 *   exactly the input most likely to trip a libheif/libvips crash — so it
 *   belongs in this same isolated child, not back in the parent (#2257).
 *
 * Transport: Bun IPC. The parent posts `ImgDecodeRequest`s via `subprocess.send`;
 * we reply with `ImgDecodeResponse`s via `process.send`. Multiple requests may be
 * in-flight at once; each is handled concurrently (sharp parallelizes them on its
 * libuv threadpool). Only small values cross IPC — the heavy AVIF thumbnail bytes
 * are written straight to `outPath` on disk inside this child, and a `validate`
 * request never ships pixel data back at all.
 */

import type { ImgDecodeResponse } from './imgdecode-protocol.ts';
import { coerceRequest } from './imgdecode-protocol.ts';
import { installChildHardening } from '../runtime/child-process-worker.ts';

// Lower CPU priority + orphan guard so the HTTP event loop wins under indexer
// load and this child exits if its parent dies. Shared mechanism with ffi-decode.
installChildHardening('imgdecode');

// Sharp and heic-convert are imported here (inside the child) so they are NEVER
// loaded into the parent HTTP server process. A crash in libvips or libheif can
// only take down this child, never the HTTP server.
import { renderImageThumbToFile } from './render.ts';
import { checkAvifOutput } from './avif-checks.ts';

function send(msg: ImgDecodeResponse): void {
  process.send?.(msg);
}

async function handleRender(req: {
  type: 'render';
  id: number;
  srcPath: string;
  outPath: string;
  maxPx: number;
  quality: number;
  ext: string;
  format?: 'avif' | 'jpeg';
}): Promise<void> {
  try {
    // renderImageThumbToFile returns a boolean; we convert to ok/error shape.
    const ok = await renderImageThumbToFile(
      req.srcPath,
      req.outPath,
      req.maxPx,
      req.ext,
      req.quality,
      req.format,
    );
    send({ type: 'render', id: req.id, ok });
  } catch (e) {
    send({
      type: 'render',
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function handleValidate(req: {
  type: 'validate';
  id: number;
  filePath: string;
  expectedLongEdgePx: number;
}): Promise<void> {
  try {
    const result = await checkAvifOutput(req.filePath, req.expectedLongEdgePx);
    send(
      result.ok
        ? { type: 'validate', id: req.id, ok: true }
        : { type: 'validate', id: req.id, ok: false, reason: result.reason },
    );
  } catch (e) {
    send({
      type: 'validate',
      id: req.id,
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}

process.on('message', (raw: unknown) => {
  const req = coerceRequest(raw);
  if (!req) return;

  // Async: each request runs concurrently on sharp's libuv threadpool. The
  // pending Map in the pool correlates replies back by `id`. `coerceRequest`
  // has already rejected anything that is neither variant, so this is an
  // exhaustive dispatch over the discriminated union, not a fallback.
  if (req.type === 'render') void handleRender(req);
  else void handleValidate(req);
});
