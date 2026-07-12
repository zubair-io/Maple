/**
 * FFI decode CHILD PROCESS entry point. Owns the raw-ffi dylib for the indexer
 * (thumb + preview stages) and the `/api/assets/:id/histogram` route.
 *
 * Why a child process and not a Worker thread (the prior design):
 *   bun:ffi symbol calls run inline on the calling thread, so the libraw
 *   embedded-preview extractor (single-threaded C) pegs one core per decode —
 *   moving it off the main thread kept the HTTP event loop responsive. But a
 *   Worker thread shares the process address space, so a SIGSEGV deep in libraw
 *   on a malformed RAW takes down the WHOLE API process (it is not a catchable
 *   JS exception). Under `restart: unless-stopped` that becomes a crash-loop:
 *   reboot → re-index → re-hit the poison asset → re-crash, pinning the CPU.
 *
 *   A child process has its own address space. A native crash here kills only
 *   THIS process; the parent (HTTP server) survives, the pool observes the exit,
 *   rejects just the in-flight call (which the stage handler catches and turns
 *   into a soft skip), and respawns a fresh child for the next request. The
 *   uncatchable process-kill becomes a catchable promise rejection — so the
 *   existing retry / dead-letter machinery in `run-stage.ts` finally applies to
 *   a decoder crash. See `ffi-pool.ts` / `ffi-child-worker.ts` for the manager.
 *
 * Transport: Bun IPC. The parent posts `FfiRequest`s via `subprocess.send`; we
 * reply with `FfiResponse`s via `process.send`. One request in flight at a time
 * per child; the pool fans out across N children for parallel decodes.
 */

import { tryGetRawFfi } from './raw_ffi.ts';
import type { FfiRequest, FfiResponse } from './raw_ffi-protocol.ts';
import { installChildHardening } from '../runtime/child-process-worker.ts';

// Lower CPU priority (so the HTTP server's event loop wins under indexer load)
// + self-exit if the parent dies. Shared with the face child; see runtime.
installChildHardening('ffi-decode');

const ffi = tryGetRawFfi();

function send(msg: FfiResponse): void {
  // `process.send` exists only when spawned with an IPC channel (always true in
  // production via the pool). The optional-chain keeps a stray direct `bun
  // raw_ffi.child.ts` invocation from throwing.
  process.send?.(msg);
}

function handle(req: FfiRequest): FfiResponse {
  if (!ffi) {
    return { type: req.type, id: req.id, ok: false, error: 'raw-ffi dylib not loaded in child' };
  }

  if (req.type === 'renderThumb') {
    const ok = ffi.renderThumbnailJpegToFile(req.rawPath, req.outPath, req.maxPx, req.quality);
    return {
      type: 'renderThumb',
      id: req.id,
      ok,
      error: ok ? undefined : 'render-failed (see child stderr)',
    };
  }

  if (req.type === 'renderDevelop') {
    // Full develop with the sidecar applied → JPEG to disk. Like renderThumb,
    // the heavy pixel buffer never crosses the FFI/IPC boundary — Rust writes
    // the file and we return only ok/error.
    const ok = ffi.renderDevelopJpegToFile(
      req.rawPath,
      req.xmpPath ?? null,
      req.outPath,
      req.maxPx,
      req.quality,
    );
    return {
      type: 'renderDevelop',
      id: req.id,
      ok,
      error: ok ? undefined : 'render-failed (see child stderr)',
    };
  }

  // histogram — render-with-xmp + bin entirely in Rust; only the 3×256 counts
  // (~3 KB) come back across the FFI boundary into a JS-owned buffer (no pixel
  // buffer ever crosses), then across IPC. See `maple_histogram_file`.
  const bins = ffi.computeHistogramBins(req.rawPath, req.xmpPath ?? null);
  if (!bins) {
    return { type: 'histogram', id: req.id, ok: false, error: 'render-failed (see child stderr)' };
  }
  return { type: 'histogram', id: req.id, ok: true, bins };
}

process.on('message', (raw: unknown) => {
  const req = raw as FfiRequest;
  if (!req || typeof req !== 'object') return;
  try {
    send(handle(req));
  } catch (e) {
    // A thrown JS error (as opposed to a native crash, which kills the process
    // and is handled by the parent's exit watcher) is reported so the pool can
    // reject the specific call rather than time out.
    send({
      type: req.type,
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
