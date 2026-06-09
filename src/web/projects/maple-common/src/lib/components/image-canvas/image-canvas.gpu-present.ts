// ImageCanvasGpuPresent — the GPU live-render present path for ImageCanvasComponent
// (epic #925, P4b-web / #1038). Extracted from the component to keep it under the
// file-size budget; the behaviour is unchanged.
//
// When `RawPipelineService.gpuLiveRenderEnabled` is on, a RAW asset renders through a
// persistent `WebLiveSession` in the worker that presents straight to a transferred
// `OffscreenCanvas` (zero readback, 16ms-ready) instead of the `decode()` → u8 →
// 2D-canvas path. Flag OFF (the default) keeps the EXACT 2D path in the component,
// untouched — this helper is only ever reached behind the `gpuLiveRenderEnabled` /
// `active()` guards there.
//
// SCOPE (invariant #6 — stated, not silently dropped): the GPU path renders the
// plain live preview only. Before/after-split + the gradient placeholder stay on the
// 2D path (flag-off / mock assets); they are not supported on the GPU live canvas
// this ticket. The histogram/waveform scopes read `currentPixels`, which the
// zero-readback GPU path does not populate — they go stale on the flag-on path (a
// documented follow-up; the flag is off by default).
//
// `transferControlToOffscreen()` is ONE-WAY per element, so each session-open creates
// a FRESH GPU canvas element (a new asset = a new session at possibly new dims); the
// previous element is removed.

import { signal } from '@angular/core';
import type { ElementRef, WritableSignal } from '@angular/core';
import type { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import type { LibraryStateService } from '../../state/library-state.service';
import type { ImageCanvasService } from './image-canvas.service';
import type { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import type { AssetId } from '../../models/asset';

/**
 * The slice of `ImageCanvasComponent` the GPU present path reaches back into. Defined
 * here (the component implements it) so the helper never imports the component class —
 * that would be a circular import. The cold-open bookkeeping (`coldOpenDone`,
 * `lastRenderedXmp`) is common to the 2D and GPU paths and intentionally stays
 * single-owner on the component; the helper mirrors it here exactly so the #846
 * adjustment effect behaves identically on either path.
 */
export interface GpuPresentHost {
  /** The wrap element the GPU canvas is appended to (sibling of the 2D canvas). */
  readonly wrapRef: ElementRef<HTMLElement>;
  readonly pipeline: RawPipelineService;
  readonly state: LibraryStateService;
  readonly canvasSvc: ImageCanvasService;
  readonly xmpSerializer: XmpSerializerService;
  readonly loading: WritableSignal<boolean>;
  readonly imageBitmap: WritableSignal<ImageBitmap | null>;

  /** The asset currently being presented; the helper stale-guards against it. */
  readonly currentAssetId: AssetId | null;
  /** Monotonic render generation; bumped by the component on asset/edit changes. */
  readonly renderGeneration: number;
  /** The XMP the canvas currently reflects (dedup key for the adjustment effect). */
  lastRenderedXmp: string | null;

  /** Open the adjustment-effect gate once the GPU cold-open has presented. */
  markColdOpenDone(): void;
  /**
   * The GPU canvas's CSS layout, mirrored from the 2D canvas: the CSS pixel size
   * (`effectivePx`) and the current pan offset. Read whenever the canvas is created
   * or the zoom/pan/resize effect fires.
   */
  currentLayout(): { canvasW: number; canvasH: number; pan: { x: number; y: number } };
}

/**
 * Owns the GPU live session + its dedicated canvas element. The component delegates
 * cold-open, edit re-render, view-positioning, and teardown here; it keeps the shared
 * cold-open bookkeeping (via `GpuPresentHost`) so the 2D and GPU paths stay in sync.
 */
export class ImageCanvasGpuPresent {
  /** True while a worker GPU session is presenting to the OffscreenCanvas. */
  readonly active = signal(false);
  private canvasEl: HTMLCanvasElement | null = null;

  constructor(private readonly host: GpuPresentHost) {}

  /** Whether this asset/extension is eligible to open a GPU session at all. */
  get enabled(): boolean {
    return this.host.pipeline.gpuLiveRenderEnabled;
  }

  /**
   * Cold-open a RAW through the persistent GPU live session (#1038): create a fresh
   * GPU canvas, transfer it to the worker, and open the session (which presents the
   * first frame with no readback). Returns `true` on success, `false` on any failure
   * (a gpu-off WASM bundle, no WebGPU, decode error) so the caller falls back to the
   * 2D `decode()` path. Mirrors the cold-open bookkeeping of `loadReal` (dims, the
   * As-Shot WB seed, the `coldOpenDone` gate + `lastRenderedXmp` dedup) so the #846
   * adjustment effect behaves identically — only the render mechanism differs.
   */
  async open(assetId: AssetId, bytes: Uint8Array, ext: string): Promise<boolean> {
    // `OffscreenCanvas` / `transferControlToOffscreen` must exist (they do on every
    // WebGPU-capable browser; guard so an old browser falls back cleanly).
    if (typeof OffscreenCanvas === 'undefined') return false;
    this.host.loading.set(true);
    performance.mark(`maple:open:${assetId}:start`);
    try {
      const canvasEl = this.createCanvas();
      const offscreen = canvasEl.transferControlToOffscreen();
      const info = await this.host.pipeline.openLiveSession(offscreen, bytes, ext);

      // Stale guard: a fast asset switch may have moved on (or torn this down)
      // while the open was in flight.
      if (assetId !== this.host.currentAssetId || this.canvasEl !== canvasEl) {
        return true; // superseded; the newer open/teardown owns the canvas now
      }

      this.active.set(true);
      // Clear the 2D bitmap so the (hidden) 2D canvas doesn't retain stale pixels.
      this.host.imageBitmap()?.close();
      this.host.imageBitmap.set(null);
      this.host.canvasSvc.currentPixels.set(null);

      // Same cold-open bookkeeping as the 2D path so #846 dedups identically.
      this.host.state.updateAssetDimensions(assetId, info.width, info.height);
      this.host.state.seedAsShotWhiteBalance(assetId, info.asShotTemperature, info.asShotTint);
      this.host.markColdOpenDone();
      const liveXmp = this.host.xmpSerializer.serialize(this.host.state.adjustmentFor(assetId)());
      if (this.host.lastRenderedXmp === null) {
        this.host.lastRenderedXmp = liveXmp;
      }
      performance.mark(`maple:open:${assetId}:paint`);
      performance.measure(
        `maple:open`,
        `maple:open:${assetId}:start`,
        `maple:open:${assetId}:paint`,
      );
      return true;
    } catch (e) {
      // gpu-off bundle / no WebGPU / decode error → tear down + signal fallback.
      console.warn('[image-canvas] GPU live session open failed; falling back to 2D:', e);
      this.teardown();
      return false;
    } finally {
      this.host.loading.set(false);
    }
  }

  /**
   * Re-render the open session for `xmp` and present to the OffscreenCanvas (the #846
   * edit path) — the worker re-renders + presents with zero readback, so there's no
   * bitmap to publish. The worker serializes renders (the wasm `&mut self` re-entrancy
   * guard), so an overlapping debounce fire can't trip "recursive use of an object
   * detected". Returns `true` once the result is accepted as current; on a stale
   * (superseded) generation it returns `false` and accepts the last-writer-wins
   * present (the next render repaints), matching the 2D path's "drop the stale result"
   * intent without a CPU buffer to discard.
   */
  async render(xmp: string, generation: number): Promise<boolean> {
    try {
      await this.host.pipeline.renderLiveSession(xmp);
      if (generation !== this.host.renderGeneration) return false;
      return true;
    } catch (e) {
      console.error('[image-canvas] GPU session re-render failed:', e);
      return false;
    }
  }

  /**
   * Position + CSS-scale the GPU canvas to match the 2D canvas's layout (the surface
   * is image-resolution; CSS scales it to the viewport, same model as the 2D canvas's
   * `drawImage` target). Driven by the same zoom/pan/resize effect in the component.
   */
  applyView(): void {
    const el = this.canvasEl;
    if (!el) return;
    const { canvasW, canvasH, pan } = this.host.currentLayout();
    el.style.width = `${canvasW}px`;
    el.style.height = `${canvasH}px`;
    el.style.transform = `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`;
  }

  /** Tear down the GPU live session + remove its canvas element. Idempotent. */
  teardown(): void {
    if (this.active() || this.canvasEl) {
      this.host.pipeline.closeLiveSession();
    }
    this.active.set(false);
    this.removeCanvasEl();
  }

  /**
   * Create a fresh GPU canvas element, style it like the 2D canvas (absolute,
   * centered, CSS-scaled by the same pan transform), append it to the canvas wrap,
   * and remove any previous one. `transferControlToOffscreen()` is one-way per
   * element, so a new element is required for every session-open.
   */
  private createCanvas(): HTMLCanvasElement {
    this.removeCanvasEl();
    const el = document.createElement('canvas');
    el.className = 'block absolute top-1/2 left-1/2';
    el.setAttribute('data-gpu-live', '');
    // Match the 2D canvas's pan transform; `draw()` sizes/positions the 2D canvas,
    // and `applyView()` keeps this one in sync on zoom/pan/resize.
    this.host.wrapRef.nativeElement.appendChild(el);
    this.canvasEl = el;
    this.applyView();
    return el;
  }

  private removeCanvasEl(): void {
    this.canvasEl?.remove();
    this.canvasEl = null;
  }
}
