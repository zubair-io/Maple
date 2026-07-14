// MapleIdFallbackHasherService — Angular wrapper around the dedicated
// fallback-form `maple_id` hashing Web Worker (#1995).
//
// Lazy-creates the worker on first call, reuses it for subsequent calls.
// Reads a File's bytes in bounded `File.slice()` chunks and streams each one
// to the worker as a transferable `ArrayBuffer` — never buffers the whole
// file in this thread's memory at once, which is the whole point of the
// WASM `FallbackIdHasher` being a streaming class (raw-wasm/src/id.rs)
// instead of a single `fallback(fullBytes, size)` call.
//
// IMPORTANT: this file imports ONLY `./maple-id-fallback.types` (a plain
// types-only module) — never `./maple-id-fallback.worker` or `pkg/raw_wasm`
// directly. The worker is referenced solely through the runtime
// `new Worker(new URL('./maple-id-fallback.worker', import.meta.url))` call
// below, which does not create a static import edge. This service IS
// re-exported from `public-api.ts` (ng-packagr builds it), and ng-packagr
// cannot resolve the wasm-pack output module `pkg/raw_wasm` — see
// `raw-wasm-init.ts`'s module doc for the same constraint on the existing
// decode worker, and `RawPipelineService.ensureWorker()` for the identical
// `new Worker(new URL(...))` pattern this mirrors.

import { Injectable, OnDestroy } from '@angular/core';
import type {
  HashFallbackFinalizeRequest,
  HashFallbackResponse,
  HashFallbackUpdateRequest,
} from './maple-id-fallback.types';

/** Default chunk size for streaming a File through the worker: 8 MiB. Large
 * enough to keep the per-chunk `postMessage` count small for a 100+ MB RAW
 * (≈13 chunks), small enough to keep peak in-flight memory bounded. */
export const DEFAULT_FALLBACK_HASH_CHUNK_SIZE = 8 * 1024 * 1024;

interface PendingHash {
  resolve: (hex: string) => void;
  reject: (err: Error) => void;
}

@Injectable({ providedIn: 'root' })
export class MapleIdFallbackHasherService implements OnDestroy {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingHash>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./maple-id-fallback.worker', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener('message', (event: MessageEvent<HashFallbackResponse>) => {
      const msg = event.data;
      const handler = this.pending.get(msg.id);
      if (!handler) return;
      this.pending.delete(msg.id);
      if (msg.type === 'hash-fallback-success') handler.resolve(msg.hex);
      else handler.reject(new Error(msg.message));
    });
    worker.addEventListener('error', (event) => {
      const message = event.message || 'unknown error';
      this.pending.forEach(({ reject }) =>
        reject(new Error(`maple-id-fallback worker error: ${message}`)),
      );
      this.pending.clear();
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  /**
   * Stream `file`'s full bytes through the WASM fallback-form hasher and
   * resolve with the 32-char lowercase hex `maple_id` — matching
   * `src/api/src/indexer/id.ts`'s `fallback(fileBytes, file.size)` for the
   * same content.
   */
  async hashFallback(file: File, chunkSize = DEFAULT_FALLBACK_HASH_CHUNK_SIZE): Promise<string> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const result = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        const buffer = await file.slice(offset, offset + chunkSize).arrayBuffer();
        const req: HashFallbackUpdateRequest = { id, type: 'hash-fallback-update', chunk: buffer };
        worker.postMessage(req, [buffer]);
      }
    } catch (err) {
      // `file.slice(...).arrayBuffer()` can throw mid-stream (the local
      // file is deleted, becomes unreadable, or a permission is revoked
      // while streaming) — without this, `id` never leaves `this.pending`
      // (nothing ever resolves/rejects it — the worker never got a
      // finalize for this id, so it never posts back), a permanent leak of
      // one Map entry per failed read, and the worker is left holding a
      // half-fed `FallbackIdHasher` for `id` forever too. Best-effort
      // finalize the worker side so IT frees the hasher (the response, if
      // any ever arrives, is a no-op — `id` is already gone from
      // `pending`), then surface the original read error to the caller.
      // Scoped to only the read loop, not the `await result` below: a
      // legitimate worker-reported failure already cleans up its own
      // `pending`/worker-side state through the normal message-handler
      // path and shouldn't re-enter this recovery branch.
      this.pending.delete(id);
      try {
        const abortFinalize: HashFallbackFinalizeRequest = {
          id,
          type: 'hash-fallback-finalize',
          filesize: BigInt(file.size),
        };
        worker.postMessage(abortFinalize);
      } catch {
        // Worker already gone/terminated — nothing left to clean up there.
      }
      throw err;
    }
    const finalizeReq: HashFallbackFinalizeRequest = {
      id,
      type: 'hash-fallback-finalize',
      filesize: BigInt(file.size),
    };
    worker.postMessage(finalizeReq);
    return result;
  }

  ngOnDestroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
