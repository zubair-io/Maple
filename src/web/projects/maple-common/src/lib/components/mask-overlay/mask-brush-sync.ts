// mask-brush-sync.ts — brush-raster registry sync (#360).
//
// The render samples a brush layer's RASTER (registered in the worker under
// the stroke's content digest), while the model carries the DABS. This class
// keeps the two attached: each sync pass stamps the computed digest onto
// leaves that carry a stale one, uploads unregistered strokes, and releases
// rasters whose stroke is gone (deleted, undone past, asset switched).
// `MaskSessionService` drives it from an effect over the layer stack, so
// every authoring path, undo/redo, and a sidecar re-parse converge without
// their own registration code; `image-canvas` keeps that service alive for
// renders the mask tool never armed.
//
// The worker registry is id-keyed but digest-addressed: every upload mints a
// NEW id (`mask_raster_register` semantics), and the render resolves a
// carried id first, then the digest. Uploads are content-keyed, so a stroke
// that stops changing uploads once; a stroke mid-drag uploads per pass, and
// the superseded ids are released by the sweep below (the fresh-parse render
// resolves by digest, so a lingering duplicate would serve a stale frame).

import type { LocalAdjustment } from '../../models/local-adjustment';
import type { BrushRasterUpload } from '../../raw-pipeline/raw-pipeline.brush-raster.types';
import { brushDigest, brushRasterDims, flattenBrushDabs } from './mask-brush';

/** The host surface the sync writes through — the service's pipeline +
 *  library calls, faked in the spec. Stamps carry no undo entry: the digest
 *  and the raster id are derived metadata, not authored content. */
export interface BrushSyncIo {
  /** Focused asset dims, or null when nothing can register yet. */
  dims: () => { width: number; height: number } | null;
  /** Upload one stroke; resolves with the worker's raster id. */
  register: (upload: BrushRasterUpload) => Promise<number>;
  /** Forget one raster id. */
  release: (rasterId: number) => void;
  /** Set the digest of the brush leaf at `index`. */
  stampDigest: (index: number, digest: string) => void;
  /**
   * Set the raster id of the brush leaf at `index` — but ONLY if that leaf
   * still hashes to `digest` (the stroke may have grown past the uploaded
   * content while the upload was in flight). Returns whether it stamped.
   */
  stampRasterId: (index: number, digest: string, rasterId: number) => boolean;
}

export class BrushRasterSync {
  /** `digest@WxH` registrations live in the worker, each mapped to its id. */
  private readonly registered = new Map<string, number>();
  /** Registrations with an upload in flight — a second pass must not double-send. */
  private readonly pending = new Set<string>();

  constructor(private readonly io: BrushSyncIo) {}

  /** Forget every registration — the worker was recreated, so the registry
   *  is empty. In-flight uploads are NOT cancelled: they were dispatched
   *  through `ensureWorker`, so they land in the live registry and their
   *  completions repopulate this map; ones the retire rejected retry on the
   *  next pass. */
  reset(): void {
    this.registered.clear();
  }

  /** True when no raster is held and none is uploading — the session's
   *  effect skips the pipeline entirely then (not even the generation
   *  read), so non-brush sessions never subscribe to worker retires. */
  get isIdle(): boolean {
    return this.registered.size === 0 && this.pending.size === 0;
  }

  sync(layers: readonly LocalAdjustment[]): void {
    const dims = this.io.dims();
    const grid = dims ? brushRasterDims(dims.width, dims.height) : null;
    const seen = new Set<string>();
    layers.forEach((layer, index) => {
      if (layer.mask.kind !== 'brush') return;
      const digest = brushDigest(layer.mask.dabs);
      if (layer.mask.digest !== digest) this.io.stampDigest(index, digest);
      if (!grid) {
        // Nothing focused: keep this stroke's rasters until dims return.
        for (const key of this.registered.keys()) {
          if (key.startsWith(`${digest}@`)) seen.add(key);
        }
        return;
      }
      const [width, height] = grid;
      // The raster's shape follows the image aspect, so the same stroke on
      // a differently shaped photo is a different registration.
      const key = `${digest}@${width}x${height}`;
      seen.add(key);
      if (layer.mask.dabs.length === 0 || this.registered.has(key) || this.pending.has(key)) return;
      const dabs = flattenBrushDabs(layer.mask.dabs);
      this.pending.add(key);
      this.io.register({ digest, width, height, dabs }).then(
        (rasterId) => {
          this.pending.delete(key);
          if (!this.io.stampRasterId(index, digest, rasterId)) {
            // The stroke moved on mid-upload — nobody will ever carry this
            // digest, so the raster is garbage already.
            this.io.release(rasterId);
            return;
          }
          const prev = this.registered.get(key);
          this.registered.set(key, rasterId);
          if (prev !== undefined && prev !== rasterId) this.io.release(prev);
        },
        () => {
          // The worker refused the upload (or died mid-flight and the
          // retire rejected it): stay unregistered, the next pass retries.
          this.pending.delete(key);
        },
      );
    });
    for (const [key, rasterId] of this.registered) {
      if (seen.has(key)) continue;
      this.registered.delete(key);
      this.io.release(rasterId);
    }
  }
}
