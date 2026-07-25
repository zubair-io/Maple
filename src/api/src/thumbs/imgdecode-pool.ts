// Non-RAW image decode pool. Dispatches sharp + heic-convert renders into an
// isolated child process so a malformed/huge JPEG/HEIC/PNG cannot crash the
// HTTP server. Mirrors the prior `heic-pool.ts` shape (single child, pending
// Map, reject-all-on-crash + respawn) but backed by `ChildProcessWorker` (Bun
// IPC, not a Worker thread) so the child has its own address space.
//
// Why off-PROCESS (not off-thread): a Worker thread shares the API's address
// space, so a SIGSEGV in libvips/libheif on a poison image kills the WHOLE
// server. A child process crash is observable and contained: the parent sees
// the unexpected exit, rejects the in-flight call, and respawns a fresh child
// for the next request. The uncatchable process-kill becomes a catchable
// rejection the existing stage-retry / dead-letter machinery already handles.
//
// Dispatch: a single persistent child handles all concurrent requests — sharp's
// libuv threadpool runs them in parallel inside the child, exactly as the old
// inline path did. The pending Map correlates IPC replies back to callers by
// request id.
//
// Crash handling: an unexpected child exit rejects ALL pending calls, drops the
// child, and respawns on the next request. Sibling calls sharing the same child
// are all affected (one child, not N), but that is the same blast radius as the
// prior Worker-thread design — the gain is containment vs the HTTP server.

import {
  ChildProcessWorker,
  childScriptPath,
  DEFAULT_NATIVE_CHILD_NICE,
} from '../runtime/child-process-worker.ts';
import type { ImgDecodeResponse } from './imgdecode-protocol.ts';

const IMGDECODE_CHILD_SCRIPT = childScriptPath(import.meta.url, './imgdecode.child.ts');

/** Minimal worker surface the pool needs. Satisfied by `ChildProcessWorker`
 * and by the fake injected in tests. */
export interface ImgDecodeWorker {
  postMessage(msg: unknown): void;
  terminate(): void;
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void;
  addEventListener(type: 'error', cb: (e: { message?: string }) => void): void;
}

/** Factory that builds a worker. Production uses `ChildProcessWorker`;
 * tests inject a fake so the dispatch / crash logic can be exercised without
 * a real child process. */
export type ImgDecodeWorkerFactory = () => ImgDecodeWorker;

/** `resolve` accepts either result shape — `render` replies carry `error`,
 * `validate` replies carry `reason` (matching `AvifValidationResult`'s own
 * field name in `thumbs/validate-avif.ts`) — narrowed to whichever the caller
 * that created this pending entry actually awaits. */
interface PendingCall {
  resolve: (result: { ok: boolean; error?: string } | { ok: boolean; reason?: string }) => void;
  reject: (err: Error) => void;
}

class ImgDecodePool {
  private worker: ImgDecodeWorker | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private spawnFailed = false;
  private readonly workerFactory: ImgDecodeWorkerFactory;

  constructor(opts?: { workerFactory?: ImgDecodeWorkerFactory }) {
    this.workerFactory =
      opts?.workerFactory ??
      (() =>
        new ChildProcessWorker(IMGDECODE_CHILD_SCRIPT, {
          nice: DEFAULT_NATIVE_CHILD_NICE,
          label: 'imgdecode',
        }) as unknown as ImgDecodeWorker);
  }

  /** Render `srcPath` to a resized thumbnail at `outPath` (AVIF by default;
   * pass `format: 'jpeg'` for the VLM describe/OCR preview tier). Resolves
   * with `{ ok, error? }`. Rejects on child spawn failure or crash. */
  renderImageThumbToFile(
    srcPath: string,
    outPath: string,
    maxPx: number,
    quality: number,
    ext: string,
    format?: 'avif' | 'jpeg',
  ): Promise<{ ok: boolean; error?: string }> {
    return this.dispatch((id) => ({
      type: 'render',
      id,
      srcPath,
      outPath,
      maxPx,
      quality,
      ext,
      format,
    }));
  }

  /**
   * Decode `filePath` in full and confirm it's a genuine, complete AVIF at
   * or under `expectedLongEdgePx` — see `thumbs/avif-checks.ts` for the
   * actual check semantics, which run inside the child (#2257: this used to
   * be an in-parent `sharp(filePath)` call in `thumbs/validate-avif.ts`,
   * adding a full pixel decode of a freshly-written, possibly-malformed
   * file directly to the HTTP server's process). Resolves with
   * `{ ok, reason? }`. Rejects on child spawn failure or crash — same
   * contract as `renderImageThumbToFile`. */
  validateAvif(
    filePath: string,
    expectedLongEdgePx: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    return this.dispatch((id) => ({ type: 'validate', id, filePath, expectedLongEdgePx }));
  }

  /**
   * Terminate the child and reject any pending calls. Call from the server's
   * graceful shutdown so the isolated decode child is reaped deterministically —
   * Bun does NOT auto-reap spawned children on parent exit; the orphan-guard
   * (2-second poll in the child) is only a backstop. Mirrors `ffi-pool.ts`.
   */
  shutdown(): void {
    this.rejectAllPendingAndDropWorker(new Error('imgdecode-pool: shutting down'));
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Shared by `renderImageThumbToFile` and `validateAvif`: assign an id,
   * register the pending call, and post `buildMessage(id)` to the child.
   * Both callers only differ in the message shape and the result type each
   * awaits — the ensure/register/post/error-handling mechanics are identical. */
  private dispatch<TResult>(
    buildMessage: (id: number) => Record<string, unknown>,
  ): Promise<TResult> {
    const id = this.nextId++;
    return new Promise<TResult>((resolve, reject) => {
      let w: ImgDecodeWorker;
      try {
        w = this.ensureWorker();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.pending.set(id, { resolve: resolve as PendingCall['resolve'], reject });
      try {
        w.postMessage(buildMessage(id));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Shared by `shutdown` and the child's `error` listener: drain every
   * pending call with `err`, terminate the (possibly already-dead) worker,
   * and clear it so the next request spawns a fresh child. */
  private rejectAllPendingAndDropWorker(err: Error): void {
    const calls = [...this.pending.values()];
    this.pending.clear();
    try {
      this.worker?.terminate();
    } catch {
      // best-effort
    }
    this.worker = null;
    for (const p of calls) p.reject(err);
  }

  private ensureWorker(): ImgDecodeWorker {
    if (this.worker) return this.worker;
    if (this.spawnFailed) throw new Error('imgdecode-pool: worker previously failed to spawn');

    let w: ImgDecodeWorker;
    try {
      w = this.workerFactory();
    } catch (e) {
      this.spawnFailed = true;
      throw new Error(
        'imgdecode-pool: failed to spawn worker — ' + (e instanceof Error ? e.message : String(e)),
        { cause: e },
      );
    }

    w.addEventListener('message', (event) => {
      const msg = event.data as ImgDecodeResponse;
      if (!msg || (msg.type !== 'render' && msg.type !== 'validate')) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === 'render') p.resolve({ ok: msg.ok, error: msg.error });
      else p.resolve({ ok: msg.ok, reason: msg.reason });
    });

    w.addEventListener('error', (event) => {
      // An unexpected child exit: reject ALL pending calls and drop the worker
      // so the next request spawns a fresh child.
      this.rejectAllPendingAndDropWorker(
        new Error('imgdecode-pool: worker errored — ' + (event.message ?? 'unknown')),
      );
    });

    this.worker = w;
    return w;
  }
}

let _pool: ImgDecodePool | null = null;

/** Process-wide imgdecode pool. Lazily constructed on first call. */
export function imgdecodePool(): ImgDecodePool {
  if (!_pool) _pool = new ImgDecodePool();
  return _pool;
}

/** Test-only: drop the singleton so a fresh pool is constructed next call. */
export function _resetImgdecodePoolForTests(): void {
  _pool = null;
}

/** Test-only: build an isolated pool with an injected worker factory. */
export function _createImgdecodePoolForTests(opts: {
  workerFactory: ImgDecodeWorkerFactory;
}): ImgDecodePool {
  return new ImgDecodePool({ workerFactory: opts.workerFactory });
}

/**
 * Convenience wrapper: render `srcPath` to a resized thumbnail at `outPath`
 * via the shared imgdecode child pool. This is the function that replaces
 * the old `render.ts#renderImageThumbToFile` at all call sites in the parent
 * process (that one now only runs inside the child — see
 * `imgdecode.child.ts`). The heavy buffers (input image, intermediate
 * output) never leave the child.
 *
 * `quality` — encode quality (0–100) on the target codec's own scale.
 * `ext` — lowercase source extension without dot (e.g. "jpeg", "heic", "png").
 * `format` — output codec, default `'avif'` (the 256px grid-thumbnail tier
 * — see THUMB_AVIF_QUALITY for its default quality); pass `'jpeg'` for the
 * 1280px VLM describe/OCR preview tier.
 *
 * Rejects on child crash or spawn failure. Never loads sharp or heic-convert in
 * the parent process.
 */
export function renderImageThumbToFileViaPool(
  srcPath: string,
  outPath: string,
  maxPx: number,
  quality: number,
  ext: string,
  format?: 'avif' | 'jpeg',
): Promise<{ ok: boolean; error?: string }> {
  return imgdecodePool().renderImageThumbToFile(srcPath, outPath, maxPx, quality, ext, format);
}

/**
 * Convenience wrapper: decode-validate `filePath` via the shared imgdecode
 * child pool. This is the function that replaces the old in-parent
 * `sharp(filePath)` call in `thumbs/validate-avif.ts#validateAvifOutput`
 * (#2257) — the actual check logic (`thumbs/avif-checks.ts#checkAvifOutput`)
 * now only ever runs inside the child.
 *
 * Rejects on child crash or spawn failure. Never loads sharp in the parent
 * process.
 */
export function validateAvifViaPool(
  filePath: string,
  expectedLongEdgePx: number,
): Promise<{ ok: boolean; reason?: string }> {
  return imgdecodePool().validateAvif(filePath, expectedLongEdgePx);
}

export type { ImgDecodePool };
