// mask-brush-session.ts — brush mask authoring state (#360).
//
// Split from `mask-session.service.ts` (at its file budget): the brush tip
// (tool state — every dab the overlay stamps copies these values in), the
// brush-layer factory, and the dab-series → worker-raster sync driver. The
// owning service constructs one of these in its constructor — the effect
// below is created there, so it runs in the service's injection context —
// and exposes it as `brush`.
//
// The render samples a brush layer's RASTER (registered in the worker under
// the stroke's content digest), while the model carries the DABS. The sync
// (`mask-brush-sync.ts`) keeps the two attached; the digest/raster-id stamps
// are derived metadata, so they bypass the undo stack. `image-canvas`
// injects the owning service to keep the sync alive for renders the mask
// tool never armed.

import { effect, signal } from '@angular/core';
import type { LocalAdjustment, LocalMask } from '../../models/local-adjustment';
import type { BrushRasterUpload } from '../../raw-pipeline/raw-pipeline.brush-raster.types';
import {
  BRUSH_DEFAULT_FEATHER,
  BRUSH_DEFAULT_FLOW,
  BRUSH_DEFAULT_SIZE,
  brushDigest,
  defaultBrushMask,
} from './mask-brush';
import { BrushRasterSync } from './mask-brush-sync';

/** Focused-asset shape the brush session needs — structural, so the owning
 *  service passes its library signal through without an import cycle. */
export interface BrushFocusedAsset {
  readonly id: string;
  readonly width?: number;
  readonly height?: number;
}

/** The host surface a `MaskBrushSession` writes through — the owning
 *  service's layer stack, library and pipeline calls. */
export interface MaskBrushDeps {
  /** Current layer stack. */
  layers: () => readonly LocalAdjustment[];
  /** Focused asset, or null when nothing can register yet. */
  focusedAsset: () => BrushFocusedAsset | null;
  /** Append a layer carrying `mask` and no adjustments, select it, return
   *  its index — one undo entry. */
  addLayer: (mask: LocalMask) => number;
  /** Replace the layer stack of `assetId` — no undo entry. The stamp calls
   *  this with the id it read, so a mid-flight asset switch never lands
   *  derived metadata on the wrong asset. */
  updateLayers: (assetId: string, layers: LocalAdjustment[]) => void;
  /** Upload one stroke; resolves with the worker's raster id. */
  registerRaster: (upload: BrushRasterUpload) => Promise<number>;
  /** Forget one raster id. */
  releaseRaster: (rasterId: number) => void;
  /** Worker generation — a retire wipes the registry. */
  workerGeneration: () => number;
}

export class MaskBrushSession {
  /** Current brush tip — tool state, not layer state: every dab the overlay
   *  stamps copies these values in. */
  readonly size = signal(BRUSH_DEFAULT_SIZE);
  readonly feather = signal(BRUSH_DEFAULT_FEATHER);
  readonly flow = signal(BRUSH_DEFAULT_FLOW);
  readonly erase = signal(false);

  private readonly sync: BrushRasterSync;
  /** Last worker generation the sync ran against — a retire wipes the
   *  registry, so a new generation resets the sync's registered set. */
  private generation = -1;

  constructor(private readonly deps: MaskBrushDeps) {
    this.sync = new BrushRasterSync({
      dims: () => {
        const a = deps.focusedAsset();
        return a?.width && a?.height ? { width: a.width, height: a.height } : null;
      },
      register: (upload) => deps.registerRaster(upload),
      release: (rasterId) => deps.releaseRaster(rasterId),
      stampDigest: (index, digest) => {
        this.stamp(index, digest, undefined);
      },
      stampRasterId: (index, digest, rasterId) => this.stamp(index, digest, rasterId),
    });
    // Brush-raster sync: every layer-stack change re-attaches dab series to
    // worker rasters. Stamps converge (a stamped digest reads back equal),
    // so the effect settles after at most two passes. Layers are read
    // FIRST: with no brush layer and nothing registered there is nothing to
    // sync, and the pipeline is not touched at all (no worker subscription
    // for non-brush sessions).
    effect(() => {
      const layers = deps.layers();
      if (!layers.some((layer) => layer.mask.kind === 'brush') && this.sync.isIdle) return;
      const generation = deps.workerGeneration();
      if (generation !== this.generation) {
        this.generation = generation;
        this.sync.reset();
      }
      this.sync.sync(layers);
    });
  }

  setSize(size: number): void {
    if (Number.isFinite(size)) this.size.set(Math.min(0.5, Math.max(0.002, size)));
  }

  setFeather(feather: number): void {
    if (Number.isFinite(feather)) this.feather.set(Math.min(1, Math.max(0, feather)));
  }

  setFlow(flow: number): void {
    if (Number.isFinite(flow)) this.flow.set(Math.min(1, Math.max(0.01, flow)));
  }

  setErase(erase: boolean): void {
    this.erase.set(erase);
  }

  /** Append a brush layer carrying an empty dab series, select it, return
   *  its index — one undo entry. */
  add(): number {
    return this.deps.addLayer(defaultBrushMask());
  }

  /**
   * Stamp derived brush metadata (content digest, worker raster id) onto the
   * brush leaf at `index` — no undo entry. Refuses unless the leaf still
   * hashes to `digest`, so an upload completion a longer stroke outgrew
   * stamps nothing. Returns whether the leaf carries `digest` afterwards.
   */
  private stamp(index: number, digest: string, rasterId: number | undefined): boolean {
    const a = this.deps.focusedAsset();
    const layers = this.deps.layers();
    const layer = a ? layers[index] : undefined;
    if (!a || layer?.mask.kind !== 'brush' || brushDigest(layer.mask.dabs) !== digest) return false;
    const mask = { ...layer.mask, digest, rasterId: rasterId ?? layer.mask.rasterId };
    if (mask.digest === layer.mask.digest && mask.rasterId === layer.mask.rasterId) return true;
    this.deps.updateLayers(
      a.id,
      layers.map((l, i) => (i === index ? { ...l, mask } : l)),
    );
    return true;
  }
}
