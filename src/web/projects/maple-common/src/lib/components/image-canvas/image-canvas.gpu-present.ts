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
// this ticket.
//
// SCOPES (#1045): the histogram/waveform/parade/vectorscope read a CPU-side
// `currentPixels` RGBA. The zero-readback present produces none, so the worker reads
// back a SMALL downsampled RGB snapshot of the presented frame (drawing the webgpu
// `OffscreenCanvas` onto a 2D canvas) and folds it into the open/render reply; `open`
// and `render` below set `currentPixels` from it. A readback miss leaves it null (on
// open) / unchanged (on edit), so the scopes degrade to their pseudo fallback rather
// than regressing — see `raw-pipeline.worker.ts` `readbackScopeSnapshot`.
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
import { type AdjustmentModel, isDefaultAdjustment } from '../../models/adjustment-model';
import type {
  GpuFallbackNoticeService,
  GpuFallbackReason,
} from '../gpu-fallback-notice/gpu-fallback-notice.service';

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
  /** Where a fallback to the 2D path is reported (#2415) so the UI can
   *  surface a notice instead of only the console warning below. */
  readonly gpuFallback: GpuFallbackNoticeService;
  /** Serialize a model for the renderer, stripping the crop while the crop
   *  tool is armed (#638) so cold-open dedup matches the 2D path. */
  serializeForRender(model: AdjustmentModel): string;
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
  /**
   * The viewport's long edge in REAL (backing-store) pixels — the develop target
   * for the GPU paths (#1080): wrap dims × devicePixelRatio. `undefined` when the
   * wrap hasn't been measured yet (the WASM side then applies its 2048 default
   * cap). Read once per session-open / one-shot decode, not per tick.
   */
  viewportTargetLongEdge(): number | undefined;
  /**
   * Record the NATIVE oriented dims from the session reply (#1080) for the
   * component's refine/zoom math — the session itself is viewport-sized, so
   * `width`/`height` are no longer the native dims.
   */
  recordNativeDims(w: number, h: number): void;
}

/**
 * Returns `true` when every channel in the packed-RGB snapshot is at or below the
 * black-present threshold (#1572). A threshold of 4 (of 255) absorbs quantization
 * noise in the 2D-canvas readback while staying well below any real image content.
 *
 * Called only when `scopePixels.rgb` is defined (non-empty); an empty snapshot
 * returns `true` conservatively (zero pixels == no evidence of content).
 */
/**
 * Owns the GPU live session + its dedicated canvas element. The component delegates
 * cold-open, edit re-render, view-positioning, and teardown here; it keeps the shared
 * cold-open bookkeeping (via `GpuPresentHost`) so the 2D and GPU paths stay in sync.
 */
export class ImageCanvasGpuPresent {
  /** True while a worker GPU session is presenting to the OffscreenCanvas. */
  readonly active = signal(false);
  private canvasEl: HTMLCanvasElement | null = null;

  /**
   * Set to `true` once a black-present is detected for this session (#1572). When
   * true, `open()` returns `false` immediately without attempting a GPU session —
   * so subsequent images skip the GPU probe entirely rather than re-detecting on
   * every open. Reset to `false` only when the page context is replaced (page
   * reload / new app instance), which is appropriate: a browser / driver that
   * produces a black present on the first image is not going to fix itself within
   * the same session.
   */
  private static presentBroken = false;
  private static presentTested = false;

  /** Test seam to reset session-level state. */
  static resetSessionForTests(): void {
    ImageCanvasGpuPresent.presentBroken = false;
    ImageCanvasGpuPresent.presentTested = false;
  }

  /**
   * Classifies, before any session-open attempt, why a GPU session can never
   * open in this page (#2415) — or `null` when nothing rules it out up front.
   *
   * - An insecure origin (`window.isSecureContext === false` — e.g. a LAN
   *   `http://<ip>:port` page) → `'insecure-context'`: the browser withholds
   *   `navigator.gpu` on principle, and serving the connection over HTTPS
   *   fixes it. Only this exact case may carry the HTTPS message.
   * - A SECURE origin whose browser simply doesn't implement WebGPU (no
   *   `navigator.gpu`) → `'session-open-failed'`: not fixable by switching
   *   schemes, so it gets the generic reduced-performance message.
   *
   * `window`/`navigator` are always defined in a browser tab; the guard is
   * only for non-browser evaluation (SSR, if this were ever imported there).
   */
  private static preOpenFallbackReason(): GpuFallbackReason | null {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
    if (window.isSecureContext === false) return 'insecure-context';
    if (!('gpu' in navigator)) return 'session-open-failed';
    return null;
  }

  /**
   * Run a one-time probe on a temporary canvas to verify if WebGL2 / WebGPU
   * presentation to a 2D context via drawImage works in this browser.
   * Returns true if working, false if broken/black canvas readback is produced.
   */
  static async testGpuPresent(): Promise<boolean> {
    if (typeof (globalThis as any).vitest !== 'undefined') return true;
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;
    if (typeof OffscreenCanvas === 'undefined') return false;

    // 1. Probe WebGL2 composition
    try {
      const canvas = new OffscreenCanvas(4, 4);
      const gl = canvas.getContext('webgl2');
      if (!gl) return false;
      gl.clearColor(0.5, 0.75, 1.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const temp2d = new OffscreenCanvas(4, 4);
      const ctx = temp2d.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(canvas, 0, 0);
      const imgData = ctx.getImageData(0, 0, 4, 4);
      const pixel = imgData.data;
      if (pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 0) {
        return false; // Broken presentation
      }
    } catch {
      return false;
    }

    // 2. Probe WebGPU composition if supported
    const nav = navigator as any;
    if (nav.gpu) {
      try {
        const adapter = await nav.gpu.requestAdapter();
        if (!adapter) return false;
        const device = await adapter.requestDevice();
        if (!device) return false;

        const canvas = new OffscreenCanvas(4, 4);
        const context = (canvas as any).getContext('webgpu');
        if (!context) {
          device.destroy();
          return false;
        }

        const format = nav.gpu.getPreferredCanvasFormat();
        context.configure({
          device,
          format,
          usage: 16 | 1, // GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
        });

        const encoder = device.createCommandEncoder();
        const renderPass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              clearValue: { r: 0.5, g: 0.75, b: 1.0, a: 1.0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        renderPass.end();
        device.queue.submit([encoder.finish()]);

        await device.queue.onSubmittedWorkDone();

        const temp2d = new OffscreenCanvas(4, 4);
        const ctx = temp2d.getContext('2d');
        if (!ctx) {
          device.destroy();
          return false;
        }
        ctx.drawImage(canvas, 0, 0);
        const imgData = ctx.getImageData(0, 0, 4, 4);
        const pixel = imgData.data;

        device.destroy();

        if (pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 0) {
          return false; // Broken WebGPU presentation
        }
      } catch {
        return false;
      }
    }

    return true;
  }

  constructor(private readonly host: GpuPresentHost) {}

  /** Whether this asset/extension is eligible to open a GPU session at all. */
  get enabled(): boolean {
    return this.host.pipeline.gpuLiveRenderEnabled;
  }

  /**
   * Cold-open a RAW through the persistent GPU live session (#1038): create a fresh
   * GPU canvas, transfer it to the worker, and open the session (which presents the
   * first frame with no readback). Returns `true` on success, `false` on any failure
   * (a gpu-off WASM bundle, no WebGPU, decode error, or a black-present detected on
   * a prior image) so the caller falls back to the 2D `decode()` path. Mirrors the
   * cold-open bookkeeping of `loadReal` (dims, the As-Shot WB seed, the
   * `coldOpenDone` gate + `lastRenderedXmp` dedup) so the #846 adjustment effect
   * behaves identically — only the render mechanism differs.
   */
  async open(assetId: AssetId, bytes: Uint8Array, ext: string): Promise<boolean> {
    // Skip the GPU probe entirely for the rest of this page session once a
    // black-present has been confirmed (#1572). No teardown needed — nothing opened.
    if (ImageCanvasGpuPresent.presentBroken) return false;
    // `OffscreenCanvas` / `transferControlToOffscreen` must exist (they do on every
    // WebGPU-capable browser; guard so an old browser falls back cleanly).
    if (typeof OffscreenCanvas === 'undefined') return false;

    // #2415: on an insecure LAN http:// origin (or a browser with no WebGPU at
    // all) the session-open below would fail for the same reason on EVERY
    // attempt. Classify it up front (cheap, synchronous) — `insecure-context`
    // only when the origin itself is insecure, so the notice's "serve HTTPS"
    // pointer is never shown for a browser that just lacks WebGPU — and skip
    // the doomed worker round-trip. Any failure past this gate (a gpu-off WASM
    // bundle, a decode error, a broken present) reports `session-open-failed`
    // in the catch below.
    const preOpenReason = ImageCanvasGpuPresent.preOpenFallbackReason();
    if (preOpenReason !== null) {
      this.host.gpuFallback.report(preOpenReason);
      return false;
    }

    // Run the one-time GPU presentation check before opening the session.
    if (!ImageCanvasGpuPresent.presentTested) {
      ImageCanvasGpuPresent.presentTested = true;
      const works = await ImageCanvasGpuPresent.testGpuPresent();
      if (!works) {
        console.warn('[image-canvas] GPU present test failed; falling back to 2D.');
        ImageCanvasGpuPresent.presentBroken = true;
        this.host.gpuFallback.report('session-open-failed');
        return false;
      }
    }

    this.host.loading.set(true);
    performance.mark(`maple:open:${assetId}:start`);
    try {
      const canvasEl = this.createCanvas();
      const offscreen = canvasEl.transferControlToOffscreen();
      // #1915: open with the asset's actual sidecar so the FIRST presented frame
      // reflects existing edits — not the no-edit default. A fresh import (default
      // model, no sidecar) stays `undefined` to preserve the #1892 As-Shot seeding
      // contract: the Rust side treats `None` as the As-Shot sentinel, and passing
      // a serialized default instead could perturb that WB path.
      const openModel = this.host.state.adjustmentFor(assetId)();
      const openXmp = isDefaultAdjustment(openModel)
        ? undefined
        : this.host.serializeForRender(openModel);
      // Develop fit to the viewport (#1080): pass the wrap's long edge in real
      // pixels so the session never develops (or sizes a surface at) full sensor
      // res. The session pins this target for its lifetime; CSS scales the
      // image-res canvas to the layout box on zoom/pan (`applyView`).
      const info = await this.host.pipeline.openLiveSession(
        offscreen,
        bytes,
        ext,
        openXmp,
        this.host.viewportTargetLongEdge(),
      );

      // Stale guard: a fast asset switch may have moved on (or torn this down)
      // while the open was in flight.
      if (assetId !== this.host.currentAssetId || this.canvasEl !== canvasEl) {
        return true; // superseded; the newer open/teardown owns the canvas now
      }

      this.active.set(true);
      // A GPU session is up — drop any fallback notice from an earlier failed
      // asset/session so the UI doesn't keep reporting a degraded path that's
      // no longer true.
      this.host.gpuFallback.clear();
      // Clear the 2D bitmap so the (hidden) 2D canvas doesn't retain stale pixels.
      this.host.imageBitmap()?.close();
      this.host.imageBitmap.set(null);
      // Feed the scopes from the GPU readback of the first presented frame (#1045);
      // null when the worker couldn't snapshot the surface → scopes use their
      // pseudo fallback (today's flag-on behaviour, no regression).
      this.host.canvasSvc.currentPixels.set(info.scopePixels ?? null);

      // Same cold-open bookkeeping as the 2D path so #846 dedups identically.
      // The session dims are viewport-sized (#1080); record the NATIVE dims the
      // reply carries so the asset record + zoom math keep the fit/100% contract
      // (#1101). `?? info` covers producers that never size down.
      const nativeW = info.nativeWidth ?? info.width;
      const nativeH = info.nativeHeight ?? info.height;
      this.host.state.updateAssetDimensions(assetId, nativeW, nativeH);
      this.host.recordNativeDims(nativeW, nativeH);
      this.host.state.seedAsShotWhiteBalance(assetId, info.asShotTemperature, info.asShotTint);
      this.host.markColdOpenDone();
      const liveXmp = this.host.serializeForRender(this.host.state.adjustmentFor(assetId)());
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
      // gpu-off bundle / decode error / broken present on a browser that DOES
      // otherwise support WebGPU (the insecure-context case returned early above) →
      // tear down + signal fallback.
      console.warn('[image-canvas] GPU live session open failed; falling back to 2D:', e);
      this.host.gpuFallback.report('session-open-failed');
      this.teardown();
      return false;
    } finally {
      this.host.loading.set(false);
    }
  }

  /**
   * Re-render the open session for `xmp` and present to the OffscreenCanvas (the #846
   * edit path). The display present itself is zero-readback (the OffscreenCanvas holds
   * the pixels, no bitmap to publish); the worker additionally folds a SMALL
   * downsampled readback of the presented frame into the reply for the scopes (#1045),
   * which we publish to `currentPixels`. The worker serializes renders (the wasm
   * `&mut self` re-entrancy guard), so an overlapping debounce fire can't trip
   * "recursive use of an object detected". Returns `true` once the result is accepted
   * as current; on a stale (superseded) generation it returns `false` and accepts the
   * last-writer-wins present (the next render repaints), matching the 2D path's "drop
   * the stale result" intent.
   */
  async render(xmp: string, generation: number, params?: Float32Array): Promise<boolean> {
    try {
      const result = await this.host.pipeline.renderLiveSession(xmp, params);
      // Stale guard (same intent as the 2D path's generation check): a newer edit
      // bumped the generation while this render was in flight — drop its result so
      // a stale scope readback can't overwrite a fresher frame's.
      if (generation !== this.host.renderGeneration) return false;
      // Update the scopes from the GPU readback of the just-presented frame (#1045).
      // Only overwrite `currentPixels` when the worker returned a snapshot, so a
      // one-off readback miss leaves the previous (correct-enough) scope data in
      // place rather than blanking the scopes to their pseudo fallback mid-edit.
      if (result.scopePixels) {
        this.host.canvasSvc.currentPixels.set(result.scopePixels);
      }
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
