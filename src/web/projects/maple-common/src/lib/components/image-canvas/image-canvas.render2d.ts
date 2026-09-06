// image-canvas.render2d.ts — the 2D-canvas decode/paint paths for
// ImageCanvasComponent, extracted behind a host interface so the component
// stays inside the file-size budget. Same precedent as image-canvas.gpu-present.ts
// (which owns the GPU live path); this owns the WASM-CPU cold-open + re-render.
//
// Everything here mutates the host's shared cold-open bookkeeping
// (`lastRenderedXmp`, painted dims, native dims) exactly the way the inlined
// methods did — the host is the single owner of that state, common to the 2D
// and GPU paths.

import type { WritableSignal } from '@angular/core';
import type { LibraryStateService } from '../../state/library-state.service';
import type { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import type { ImageCanvasService } from './image-canvas.service';
import type { AssetId } from '../../models/asset';
import type { AdjustmentModel } from '../../models/adjustment-model';
import type { RenderSizing } from './image-canvas.two-phase';
import type { ImageCanvasNativeDetail } from './image-canvas.native-detail';
import type { ImageCanvasFilmSync } from './image-canvas.film';
import { imageDataToBitmap } from '../../raw-pipeline/image-utils';

/**
 * The shared canvas surface the 2D render paths read/write. The component
 * exposes these directly (most are already public for `GpuPresentHost`); the
 * extracted functions never touch DOM, only this state + the pipeline.
 */
export interface Render2dHost {
  readonly state: LibraryStateService;
  readonly canvasSvc: ImageCanvasService;
  readonly pipeline: RawPipelineService;
  /** #3171 — `runRender2d` reads `cpuLutBytesForCurrent()` off this for the
   *  focused asset's currently-resolved film-look LUT bytes. */
  readonly filmSync: ImageCanvasFilmSync;
  readonly nativeDetail?: Pick<ImageCanvasNativeDetail, 'recordBase'>;
  readonly imageBitmap: WritableSignal<ImageBitmap | null>;
  readonly loading: WritableSignal<boolean>;
  readonly currentAssetId: AssetId | null;
  readonly renderGeneration: number;
  /** Dedup key — mutated by the cold open. */
  lastRenderedXmp: string | null;

  /** Crop-aware serialize (strips crop while the crop tool is armed). */
  serializeForRender(model: AdjustmentModel): string;
  /** Fast-phase (viewport long-edge) render target. */
  fastTargetPx(): number;
  /** Open the adjustment-effect gate once the cold open has painted. */
  markColdOpenDone(): void;
  /** True when an embedded camera preview is already painted for this asset. */
  hasProvisionalPreview(assetId: AssetId): boolean;
  /** Record that final decoded pixels replaced the provisional camera preview. */
  clearProvisionalPreview(assetId: AssetId): void;
  /** Record the decode's native (full-res, oriented) dims for refine/zoom math. */
  recordNativeDims(w: number, h: number): void;
  /** Record the painted bitmap's dims (long edge + aspect) for the refine guard
   *  and the fit/draw geometry. */
  recordPaintedDims(w: number, h: number): void;
  /** Schedule a refine pass for the given XMP at the current generation. */
  scheduleRefine(xmp: string, generation: number): void;
}

/**
 * #3182 fallback defaults for a decode/session-open reply that predates the
 * lens-correction fields (older worker builds, minimal test fakes): no known
 * corrections ⇒ the panel reads as disabled, CA reads as inert. Shared by the
 * 2D cold open below and the GPU live-session open (`image-canvas.gpu-present.ts`).
 */
export function lensCorrectionCapabilityFrom(reply: {
  hasLensCorrections?: boolean;
  lensCorrectionCaInert?: boolean;
}): { hasLensCorrections: boolean; lensCorrectionCaInert: boolean } {
  return {
    hasLensCorrections: reply.hasLensCorrections ?? false,
    lensCorrectionCaInert: reply.lensCorrectionCaInert ?? true,
  };
}

/**
 * WASM-CPU cold open (#1101): decode at the fast-phase target, seed the asset
 * dims + As-Shot WB, open the cold-open gate, paint, and kick a refine if the
 * view is already zoomed past fit. Mirrors the inlined `loadReal` 2D tail.
 */
export async function coldOpen2d(
  host: Render2dHost,
  assetId: AssetId,
  filename: string,
  ext: string,
  bytes: Uint8Array,
): Promise<void> {
  host.loading.set(true);
  const generation = host.renderGeneration;
  const sizing = { maxLongEdge: host.fastTargetPx(), qualityPreview: true };
  // Bracket the whole click → pixels path. `maple:open` is the outer measure;
  // `maple:decode` (service) and `maple:wasm` (worker) are nested sub-intervals.
  performance.mark(`maple:open:${assetId}:start`);
  try {
    // Viewport-sized cold open (#1101): decode at the fast-phase target so first
    // pixels land at viewport resolution; the refine pass sharpens past fit.
    const decoded = await host.pipeline.decode(bytes, ext, undefined, sizing.maxLongEdge, true);
    if (assetId !== host.currentAssetId || generation !== host.renderGeneration) return;

    // Update dimensions on the asset — the NATIVE dims (the sized reply carries
    // them), not the viewport-sized buffer's.
    const nativeW = decoded.nativeWidth ?? decoded.width;
    const nativeH = decoded.nativeHeight ?? decoded.height;
    host.state.updateAssetDimensions(assetId, nativeW, nativeH);
    if (assetId === host.currentAssetId) {
      host.recordNativeDims(nativeW, nativeH);
    }

    // Seed WB sliders from the camera "As Shot" metadata (cosmetic sync with
    // what Rust used; guarded on "still default" so it never clobbers edits).
    host.state.seedAsShotWhiteBalance(assetId, decoded.asShotTemperature, decoded.asShotTint);
    // #3182: record the decode-time lens-correction signal for the Lens
    // Corrections panel. Absent (older stubs / non-updated fakes) reads as
    // the fail-closed default (see `lensCorrectionCapabilityFrom` above).
    const lensCorrections = lensCorrectionCapabilityFrom(decoded);
    host.state.seedLensCorrections(
      assetId,
      lensCorrections.hasLensCorrections,
      lensCorrections.lensCorrectionCaInert,
      decoded.cameraSupport,
    );

    // Open the gate + record what this no-XMP render reflects (the seed's effect
    // re-fire dedups against it). Guard on still-current asset.
    if (assetId === host.currentAssetId) {
      host.markColdOpenDone();
      const liveXmp = host.serializeForRender(host.state.adjustmentFor(assetId)());
      if (host.lastRenderedXmp === null) {
        // Normal cold open: record the seeded baseline so the gate-driven +
        // As-Shot-seed effect re-fires dedup against it.
        host.lastRenderedXmp = liveXmp;
      }
    }

    host.canvasSvc.currentPixels.set(decoded);

    const bitmap = await imageDataToBitmap(decoded);
    if (assetId !== host.currentAssetId || generation !== host.renderGeneration) {
      bitmap.close();
      return;
    }
    host.nativeDetail?.recordBase({
      assetId,
      generation,
      displayXmp: host.lastRenderedXmp!,
      sizing,
    });
    host.imageBitmap()?.close();
    host.imageBitmap.set(bitmap);
    host.recordPaintedDims(decoded.width, decoded.height);
    host.clearProvisionalPreview(assetId);
    performance.mark(`maple:open:${assetId}:paint`);
    performance.measure(`maple:open`, `maple:open:${assetId}:start`, `maple:open:${assetId}:paint`);

    // A cold open while zoomed past fit needs the refine pass right away.
    if (assetId === host.currentAssetId && host.lastRenderedXmp !== null) {
      host.scheduleRefine(host.lastRenderedXmp, host.renderGeneration);
    }
  } catch (e) {
    console.error('Decode failed for', filename, e);
    if (!host.hasProvisionalPreview(assetId)) {
      host.imageBitmap()?.close();
      host.imageBitmap.set(null);
    }
  } finally {
    host.loading.set(false);
  }
}

/**
 * Re-render the retained RAW bytes with `xmp` at `sizing`'s target and publish
 * the result — only if `generation` is still current when the render returns (a
 * stale result is dropped, never painted). Mirrors the inlined `runRender` 2D
 * branch (the GPU branch stays on the component). #3171: threads the focused
 * asset's currently-resolved film-look LUT bytes (`host.filmSync`) through to
 * `RawPipelineService.decode()`, which routes them to the `sizedFilm`/`film`
 * WASM entry per `selectLegacyDecodeRoute` — `undefined` (no look set, or the
 * fetch is still in flight) decodes with no look, same as before this ticket.
 */
export async function runRender2d(
  host: Render2dHost,
  xmp: string,
  generation: number,
  sizing: RenderSizing,
  bytes: Uint8Array,
  ext: string,
): Promise<void> {
  try {
    const filmLut = host.filmSync.cpuLutBytesForCurrent();
    const decoded = await host.pipeline.decode(
      bytes,
      ext,
      xmp,
      sizing.maxLongEdge,
      sizing.qualityPreview,
      filmLut,
    );
    // Stale guard: a newer edit (or asset switch) bumped the generation.
    if (generation !== host.renderGeneration) return;

    host.canvasSvc.currentPixels.set(decoded);
    const bitmap = await imageDataToBitmap(decoded);
    if (generation !== host.renderGeneration) {
      bitmap.close();
      return;
    }
    host.imageBitmap()?.close();
    host.imageBitmap.set(bitmap);
    host.recordPaintedDims(decoded.width, decoded.height);
    host.lastRenderedXmp = xmp;
    if (host.currentAssetId)
      host.nativeDetail?.recordBase({
        assetId: host.currentAssetId,
        generation,
        renderXmp: xmp,
        displayXmp: xmp,
        sizing,
        filmLut,
      });
  } catch (e) {
    console.error('[image-canvas] adjustment re-render failed:', e);
  }
}
