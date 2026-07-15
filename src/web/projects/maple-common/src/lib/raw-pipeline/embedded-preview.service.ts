// EmbeddedPreviewService — Angular wrapper around the dedicated
// embedded-RAW-preview-extraction Web Worker (#2010, epic #1993 Stage 4).
//
// Lazy-creates the worker on first call, reuses it for subsequent calls.
//
// IMPORTANT: this file imports ONLY `./embedded-preview.types` (a plain
// types-only module) — never `./embedded-preview.worker` or `./pkg/raw_wasm`
// directly. The worker is referenced solely through the runtime
// `new Worker(new URL('./embedded-preview.worker', import.meta.url))` call
// below, which does not create a static import edge. This service IS
// re-exported from `public-api.ts` (ng-packagr builds it), and ng-packagr
// cannot resolve the wasm-pack output module `pkg/raw_wasm` — see
// `raw-wasm-init.ts`'s module doc for the same constraint on the existing
// decode worker, and `MapleIdFallbackHasherService` for the identical
// pattern this mirrors.

import { Injectable, OnDestroy } from '@angular/core';
import type { ExtractPreviewRequest, ExtractPreviewResponse } from './embedded-preview.types';

/** Long-edge target in pixels for the extracted preview. Matches the
 * server's `PREVIEW_LONG_EDGE_PX` (`src/api/src/indexer/previewer.ts`) and
 * `LibraryCache`'s own "embedded 1280px" preview-channel doc comment — the
 * same size across all three platforms so this tier's derivation stays
 * genuinely comparable, not just format-compatible. */
export const EMBEDDED_PREVIEW_LONG_EDGE_PX = 1280;

export interface ExtractedEmbeddedPreview {
  width: number;
  height: number;
  /** JPEG blob — see `embedded-preview.worker.ts`'s module doc for why this
   * tier is JPEG rather than the AVIF the grid-thumbnail tier uses. */
  blob: Blob;
}

interface PendingExtract {
  resolve: (result: ExtractedEmbeddedPreview) => void;
  reject: (err: Error) => void;
}

@Injectable({ providedIn: 'root' })
export class EmbeddedPreviewService implements OnDestroy {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingExtract>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./embedded-preview.worker', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener('message', (event: MessageEvent<ExtractPreviewResponse>) => {
      const msg = event.data;
      const handler = this.pending.get(msg.id);
      if (!handler) return;
      this.pending.delete(msg.id);
      if (msg.type === 'extract-preview-success') {
        handler.resolve({
          width: msg.width,
          height: msg.height,
          blob: new Blob([msg.jpeg], { type: 'image/jpeg' }),
        });
      } else {
        handler.reject(new Error(msg.message));
      }
    });
    worker.addEventListener('error', (event) => {
      const message = event.message || 'unknown error';
      this.pending.forEach(({ reject }) =>
        reject(new Error(`embedded-preview worker error: ${message}`)),
      );
      this.pending.clear();
      // Terminate the broken instance before dropping the reference —
      // without this, a worker that errored (e.g. a script load failure)
      // keeps running abandoned rather than being cleaned up, and only the
      // reference gets replaced on the next `ensureWorker()` call. Mirrors
      // `MapleIdFallbackHasherService.ensureWorker()`'s identical guard.
      worker.terminate();
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  /**
   * Extract `raw`'s embedded RAW preview/thumbnail (baked in at capture
   * time — NOT a re-render from sensor data), downsampled to `maxLongEdge`
   * px on the long edge (never upscaled), oriented per EXIF, JPEG-encoded.
   * Matches the server's/Apple's embedded-preview-extraction derivation
   * (`raw_core::preview::extract_embedded_preview`) — same rawler
   * preview/full/thumbnail-slot hunt, same resize, same orientation bake —
   * so web's "unedited" pixels are genuinely the camera-embedded bytes, not
   * a re-render, on every platform.
   *
   * `raw` is copied into a fresh transferable `ArrayBuffer` before posting
   * (the caller's view stays valid afterwards) — the caller is expected to
   * already hold these bytes in memory (e.g.
   * `LibraryCache.bytesForAsset()`), so this never itself reads the file.
   *
   * Rejects if the RAW has no embedded preview to extract (rare — every
   * modern RAW container embeds one; see `raw_core::preview`'s module doc)
   * or on a decode/encode error.
   */
  async extractEmbeddedPreview(
    raw: Uint8Array,
    ext: string,
    maxLongEdge: number = EMBEDDED_PREVIEW_LONG_EDGE_PX,
    quality = 0,
  ): Promise<ExtractedEmbeddedPreview> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const result = new Promise<ExtractedEmbeddedPreview>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const request: ExtractPreviewRequest = {
      id,
      type: 'extract-preview',
      raw: buffer,
      ext,
      maxLongEdge,
      quality,
    };
    worker.postMessage(request, [buffer]);
    return result;
  }

  /** Reject any extraction still in flight (mirrors
   * `MapleIdFallbackHasherService.ngOnDestroy()`'s reasoning) — otherwise a
   * caller `await`ing `extractEmbeddedPreview()` across a destroy would
   * hang forever, since the terminated worker never posts a response. */
  ngOnDestroy(): void {
    this.pending.forEach(({ reject }) =>
      reject(new Error('EmbeddedPreviewService destroyed with an extraction still in flight')),
    );
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}
