// Single-worker FFI pool. Off-main-thread thumbnail rendering so the
// synchronous bun:ffi symbol calls don't block HTTP handlers.
//
// Why one worker (not N): bun:ffi calls run inline on whichever thread
// invokes them. Adding workers doesn't increase rawler decode throughput
// — each render still serializes inside the worker — but it would
// quadruple the dylib load and consume memory on already-tight systems.
// One worker, one in-flight FFI, queue on the manager. Live tunable
// later if benchmarks warrant.
//
// Lifecycle: lazy — the worker spawns on first request, lives for the
// process lifetime. There's no `terminate()`; bun cleans it up at exit.

import { tryGetRawFfi } from "./raw_ffi.ts";

interface PendingCall {
  resolve: (ok: boolean) => void;
  reject: (err: Error) => void;
}

interface RenderResponse {
  type: "renderThumb";
  id: number;
  ok: boolean;
  error?: string;
}

class FfiWorkerPool {
  private worker: Worker | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private workerLoadFailed = false;

  /** True iff the dylib is reachable. False = caller should degrade. */
  available(): boolean {
    return tryGetRawFfi() !== null;
  }

  /** Lazy worker spawn. Throws if Bun's `Worker` API is unavailable. */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (this.workerLoadFailed) {
      throw new Error("ffi-pool: worker previously failed to start");
    }

    let w: Worker;
    try {
      w = new Worker(new URL("./raw_ffi.worker.ts", import.meta.url).href);
    } catch (e) {
      this.workerLoadFailed = true;
      throw new Error(
        "ffi-pool: failed to spawn worker — " +
          (e instanceof Error ? e.message : String(e)),
      );
    }

    w.addEventListener("message", (event) => {
      const msg = event.data as RenderResponse;
      if (msg?.type !== "renderThumb") return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        p.resolve(true);
      } else if (msg.error) {
        p.reject(new Error(msg.error));
      } else {
        p.resolve(false);
      }
    });

    w.addEventListener("error", (event) => {
      // Reject every in-flight call so callers don't hang. The next
      // request will spawn a fresh worker.
      const err = new Error(
        "ffi-pool: worker errored — " + (event.message || "unknown"),
      );
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    });

    this.worker = w;
    return w;
  }

  /** Render a RAW thumbnail to disk. Returns true on success, false on
   * a soft failure (e.g. exifr can't read the file). Rejects only on
   * hard infra errors (worker crash, dylib not loaded). */
  async renderThumbnailJpegToFile(
    rawPath: string,
    outPath: string,
    maxPx: number,
    quality = 82,
  ): Promise<boolean> {
    if (!this.available()) {
      throw new Error("ffi-pool: raw-ffi dylib not available");
    }

    const id = this.nextId++;
    return new Promise<boolean>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ensureWorker().postMessage({
          type: "renderThumb",
          id,
          rawPath,
          outPath,
          maxPx,
          quality,
        });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

let _pool: FfiWorkerPool | null = null;

/** Process-wide FFI pool. Lazily constructed on first call. */
export function ffiPool(): FfiWorkerPool {
  if (!_pool) _pool = new FfiWorkerPool();
  return _pool;
}
