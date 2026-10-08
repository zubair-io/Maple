// mask-brush-sync.ts — brush-raster registry sync (#360).
//
// The render samples a brush layer's RASTER (registered in the worker under
// the digest the layer carries), while the model carries the DABS. This class
// keeps the two attached: each sync pass uploads strokes with no live raster
// for the current grid and releases rasters whose stroke is gone (deleted,
// undone past, asset switched). `MaskSessionService` drives it from an effect
// over the layer stack, so every authoring path, undo/redo, and a sidecar
// re-parse converge without their own registration code; `image-canvas`
// keeps that service alive for renders the mask tool never armed.
//
// Nothing here writes the layer stack on the common path: the render resolves
// a brush by the digest it carries (raw-wasm `resolve_into`), so registering
// under that digest is enough, and a store patch would rewrite the sidecar
// and churn every mtime-keyed cache just for opening a photo. The authoring
// overlay moves the digest with the dabs (`appendedBrushDigest`); only a
// stroke carrying no usable digest gets one stamped.

import type { LocalAdjustment } from '../../models/local-adjustment';
import type { BrushRasterUpload } from '../../raw-pipeline/raw-pipeline.brush-raster.types';
import { brushDigest, brushRasterDims, flattenBrushDabs, isBrushDigest } from './mask-brush';

/** The host surface the sync writes through — the service's pipeline +
 *  library calls, faked in the spec. */
export interface BrushSyncIo {
  /** Focused asset dims, or null when nothing can register yet. */
  dims: () => { width: number; height: number } | null;
  /** Upload one stroke; resolves with the worker's raster id. */
  register: (upload: BrushRasterUpload) => Promise<number>;
  /** Forget one raster id. */
  release: (rasterId: number) => void;
  /** Name the brush leaf at `index`, which carries no usable digest. */
  stampDigest: (index: number, digest: string) => void;
  /** A raster landed: the sidecar did not change, so the canvas must be told. */
  adopted: () => void;
}

export class BrushRasterSync {
  /** `digest@WxH` registrations live in the worker, each mapped to its id. */
  private readonly registered = new Map<string, number>();
  /** Registrations with an upload in flight — a second pass must not double-send. */
  private readonly pending = new Set<string>();
  /** Registrations the latest pass wanted; a late upload outside it is garbage. */
  private wanted = new Set<string>();
  /** Bumped by `reset`; an upload sent before it is superseded. */
  private epoch = 0;

  constructor(private readonly io: BrushSyncIo) {}

  /** Forget every registration — the worker was recreated, so the registry
   *  is empty. In-flight uploads are forgotten too, so the pass the
   *  worker-generation bump triggers re-sends them; a superseded upload that
   *  still lands is released rather than adopted. */
  reset(): void {
    this.registered.clear();
    this.pending.clear();
    this.epoch++;
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
    const wanted = new Set<string>();
    layers.forEach((layer, index) => {
      if (layer.mask.kind !== 'brush' || layer.mask.dabs.length === 0) return;
      const { dabs, digest } = layer.mask;
      if (!isBrushDigest(digest)) {
        this.io.stampDigest(index, brushDigest(dabs));
        return;
      }
      if (!grid) {
        // Nothing focused: keep this stroke's rasters until dims return.
        for (const key of this.registered.keys()) {
          if (key.startsWith(`${digest}@`)) wanted.add(key);
        }
        return;
      }
      const [width, height] = grid;
      // The raster's shape follows the image aspect, so the same stroke on
      // a differently shaped photo is a different registration.
      const key = `${digest}@${width}x${height}`;
      wanted.add(key);
      if (this.registered.has(key) || this.pending.has(key)) return;
      this.pending.add(key);
      const epoch = this.epoch;
      this.io.register({ digest, width, height, dabs: flattenBrushDabs(dabs) }).then(
        (rasterId) => {
          if (epoch !== this.epoch) {
            this.io.release(rasterId);
            return;
          }
          this.pending.delete(key);
          if (!this.wanted.has(key)) {
            this.io.release(rasterId);
            return;
          }
          const prev = this.registered.get(key);
          this.registered.set(key, rasterId);
          if (prev !== undefined && prev !== rasterId) this.io.release(prev);
          this.io.adopted();
        },
        () => {
          if (epoch === this.epoch) this.pending.delete(key);
        },
      );
    });
    this.wanted = wanted;
    for (const [key, rasterId] of this.registered) {
      if (wanted.has(key)) continue;
      this.registered.delete(key);
      this.io.release(rasterId);
    }
  }
}
