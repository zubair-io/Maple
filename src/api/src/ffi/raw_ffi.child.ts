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
import {
  coerceFfiRequest,
  rejectedFfiReply,
  type FfiRejectedResponse,
  type FfiResponse,
} from './raw_ffi-protocol.ts';
import { handleFfiRequest } from './raw_ffi-dispatch.ts';
import { installChildHardening } from '../runtime/child-process-worker.ts';

// Lower CPU priority (so the HTTP server's event loop wins under indexer load)
// + self-exit if the parent dies. Shared with the face child; see runtime.
installChildHardening('ffi-decode');

const ffi = tryGetRawFfi();

function send(msg: FfiResponse | FfiRejectedResponse): void {
  // `process.send` exists only when spawned with an IPC channel (always true in
  // production via the pool). The optional-chain keeps a stray direct `bun
  // raw_ffi.child.ts` invocation from throwing.
  process.send?.(msg);
}

// Message loop: guard, dispatch, report. The try/catch is what turns a thrown
// JS error into a reply the pool can reject; the arm count lives in
// `handleFfiRequest`.
// fallow-ignore-next-line complexity
process.on('message', async (raw: unknown) => {
  const req = coerceFfiRequest(raw);
  if (!req) {
    // Not a request this child can dispatch (unknown `type`, or no routable
    // `id`). Never fall through to an arm: answer with an error when there is
    // an id to route the reply by, so the pool rejects that caller instead of
    // leaving its promise pending.
    const reply = rejectedFfiReply(raw);
    if (reply) send(reply);
    return;
  }
  try {
    send(await handleFfiRequest(ffi, req));
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
