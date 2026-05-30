// Single-worker HEIC/HEIF decode pool. Off-main-thread thumbnail decode so the
// synchronous `heic-convert` WASM pass (~500–2000 ms per file) doesn't block
// the HTTP event loop. Mirrors `ffi/ffi-pool.ts` + `people/cluster-pool.ts`:
// lazy single-worker spawn, request-id correlation Map, error handler that
// rejects every in-flight call and respawns on the next request.
//
// Why one worker (not N): HEIC cache misses are bursty but the decode is the
// expensive part, and a single worker already removes the block from the main
// thread. The route + indexer await one decode at a time per request, and the
// manager queues concurrent calls behind a single Worker. Live tunable later
// if profiling warrants more.
//
// Fallback: if Bun's `Worker` can't spawn (unsupported runtime, sandbox),
// `decodeHeicThumbOffThread` degrades to running the canonical chain
// in-process. That re-introduces the event-loop block, but it's correct and
// keeps environments without Worker support (some test/CI shells) working
// rather than hard-failing. The worker runs the *same* `renderHeicThumbToFile`
// core, so either path writes byte-identical output.
//
// Lifecycle: lazy — the worker spawns on first request and lives for the
// process. bun cleans it up at exit.

import { child as childLogger } from '../log.ts';
import { renderHeicThumbToFile } from './render.ts';

const log = childLogger('thumbs:heic-pool');

/** Small result that crosses `postMessage` — never the image bytes. */
export interface HeicDecodeResult {
  ok: boolean;
  error?: string;
  /** Execution telemetry: true when the decode ran on the Worker thread,
   *  false when it degraded to the in-process (event-loop-blocking) fallback
   *  because no Worker could spawn. Lets callers — and the off-thread test —
   *  distinguish the two paths instead of inferring from timing. */
  viaWorker: boolean;
}

interface PendingCall {
  resolve: (result: HeicDecodeResult) => void;
  reject: (err: Error) => void;
}

interface DecodeResponse {
  type: 'decodeHeic';
  id: number;
  ok: boolean;
  error?: string;
}

class HeicWorkerPool {
  private worker: Worker | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private workerLoadFailed = false;

  /** Lazy worker spawn. Throws if Bun's `Worker` API is unavailable so the
   *  caller can fall back to in-process decode. */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (this.workerLoadFailed) {
      throw new Error('heic-pool: worker previously failed to start');
    }

    let w: Worker;
    try {
      w = new Worker(new URL('./heic.worker.ts', import.meta.url).href);
    } catch (e) {
      this.workerLoadFailed = true;
      throw new Error(
        'heic-pool: failed to spawn worker — ' + (e instanceof Error ? e.message : String(e)),
      );
    }

    w.addEventListener('message', (event) => {
      const msg = event.data as DecodeResponse;
      if (msg?.type !== 'decodeHeic') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      // A `decodeHeic` reply only ever originates from the spawned worker, so
      // any result that arrives here genuinely ran off-thread.
      p.resolve({ ok: msg.ok, error: msg.error, viaWorker: true });
    });

    w.addEventListener('error', (event) => {
      // Reject every in-flight call so callers don't hang. The next request
      // spawns a fresh worker.
      const err = new Error('heic-pool: worker errored — ' + (event.message || 'unknown'));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    });

    this.worker = w;
    return w;
  }

  /** Decode `srcPath` (HEIC/HEIF) to a resized JPEG at `thumbPath`. Resolves
   *  with the worker's `{ ok, error? }`, or (when no worker can spawn) runs
   *  the canonical chain in-process. Rejects only on a genuine worker runtime
   *  error — never silently falls back to the blocking path once a worker is
   *  up. */
  decode(srcPath: string, thumbPath: string, sizePx: number): Promise<HeicDecodeResult> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'heic worker unavailable — decoding in-process (blocks the event loop)',
      );
      return renderHeicThumbToFile(srcPath, thumbPath, sizePx)
        .then(() => ({ ok: true, viaWorker: false }) satisfies HeicDecodeResult)
        .catch(
          (err) =>
            ({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              viaWorker: false,
            }) satisfies HeicDecodeResult,
        );
    }

    const id = this.nextId++;
    return new Promise<HeicDecodeResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({
          type: 'decodeHeic',
          id,
          srcPath,
          thumbPath,
          sizePx,
        });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

let _pool: HeicWorkerPool | null = null;

/** Process-wide HEIC decode pool. Lazily constructed on first call. */
function heicPool(): HeicWorkerPool {
  if (!_pool) _pool = new HeicWorkerPool();
  return _pool;
}

/**
 * Decode a HEIC/HEIF file to a resized JPEG thumbnail off the main thread on a
 * persistent Worker so the synchronous libheif/WASM decode never freezes the
 * HTTP event loop. On-disk output is byte-identical to calling
 * `renderHeicThumbToFile` directly — the worker runs the same canonical chain.
 * Degrades to in-process execution only when no Worker can spawn.
 */
export function decodeHeicThumbOffThread(
  srcPath: string,
  thumbPath: string,
  sizePx: number,
): Promise<HeicDecodeResult> {
  return heicPool().decode(srcPath, thumbPath, sizePx);
}
