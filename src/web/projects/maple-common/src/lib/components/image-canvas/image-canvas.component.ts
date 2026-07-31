// ImageCanvasComponent — center column; zoom + pan + before/after divider.
// Uses real decoded pixels via RawPipelineService for imported assets.
// Falls back to gradient placeholders for mock assets.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Injector,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { ImageCanvasService } from './image-canvas.service';
import { AssetId } from '../../models/asset';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { isNonRawExtension } from '../../state/raw-extensions';
import { ImageCanvasGpuPresent, type GpuPresentHost } from './image-canvas.gpu-present';
import {
  computeEffectivePx,
  computeRefineTargetLongEdge,
  computeViewportTargetLongEdge,
  drawCanvas2d,
} from './image-canvas.draw2d';
import { TwoPhaseRenderScheduler, type RenderSizing } from './image-canvas.two-phase';
import { CanvasZoomGestures } from './image-canvas.zoom-gestures';
import { CropOverlayComponent } from '../crop-overlay/crop-overlay.component';
import { CropSessionService } from '../crop-overlay/crop-session.service';
import { type AdjustmentModel } from '../../models/adjustment-model';
import { cropStraightenTransform, displayDims, renderModelForCrop } from './image-canvas.crop';
import { coldOpen2d, runRender2d, type Render2dHost } from './image-canvas.render2d';
import { canUseLiveFastPath, buildLiveParams } from './image-canvas.live-params';
import { fetchAndLoadBytes, type ByteLoadError, type ByteLoadHost } from './image-canvas.byteload';

@Component({
  selector: 'editor-image-canvas',
  standalone: true,
  imports: [CropOverlayComponent],
  templateUrl: './image-canvas.component.html',
  styleUrl: './image-canvas.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageCanvasComponent
  implements AfterViewInit, OnDestroy, GpuPresentHost, Render2dHost, ByteLoadHost
{
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('wrap') wrapRef!: ElementRef<HTMLElement>;

  /** Hide the legacy zoom/before-after toolbar. The canvas-first Pro editor
   * (#1535) supplies zoom via gestures + keyboard and before/after via its
   * floating top-bar, so the toolbar would be a duplicate header there.
   * Defaults false so the classic 3-column editor keeps its toolbar. */
  readonly hideToolbar = input<boolean>(false);

  state = inject(LibraryStateService);
  canvasSvc = inject(ImageCanvasService);
  pipeline = inject(RawPipelineService);
  // Public for `GpuPresentHost` (the GPU cold-open serializes the live model).
  readonly xmpSerializer = inject(XmpSerializerService);
  private readonly injector = inject(Injector);
  private readonly cropSession = inject(CropSessionService);

  readonly loading = signal(false);
  readonly imageBitmap = signal<ImageBitmap | null>(null);
  // Recoverable byte-load error (#2407) — see image-canvas.byteload.ts.
  readonly byteLoadError = signal<ByteLoadError | null>(null);

  // GPU live-render path (epic #925, P4b-web / #1038). The GPU canvas lifecycle +
  // worker session wiring lives in `ImageCanvasGpuPresent` (see that file for the
  // full scope/invariant notes); this component owns the shared cold-open
  // bookkeeping via the `GpuPresentHost` interface so the 2D and GPU paths stay in
  // sync. Flag OFF keeps the 2D path below as the only render route.
  private readonly gpuPresent = new ImageCanvasGpuPresent(this);

  private ro?: ResizeObserver;
  private wrapW = signal<number>(800);
  private wrapH = signal<number>(600);
  private detachGestures?: () => void;
  private cleanupDecodeEffect?: () => void;
  private cleanupRerenderEffect?: () => void;
  private cleanupDrawEffect?: () => void;
  private cleanupRefineViewEffect?: () => void;
  // Public for `GpuPresentHost` (the helper's stale guards read it); component-mutated.
  currentAssetId: AssetId | null = null;

  // ── Two-phase live render (#846 → #1101) ──────────────────────────────────
  // Fast/refine scheduling lives in `image-canvas.two-phase.ts` (the full
  // phase contract is documented there); this component supplies the host
  // surface (targets, generation, `runRender`).
  private readonly twoPhase = new TwoPhaseRenderScheduler({
    currentGeneration: () => this.renderGeneration,
    fastTargetPx: () => this.fastTargetPx(),
    refineTargetPx: () => this.refineTargetPx(),
    gpuActive: () => this.gpuPresent.active(),
    runRender: (xmp, generation, sizing) => this.runRender(xmp, generation, sizing),
  });
  // Bytes + extension for the focused asset, retained so adjustment-driven
  // re-renders don't re-read from the byte cache. `decode()` slices a copy of
  // the buffer before transferring it into the worker, so the original view
  // here is never detached — repeated decodes are safe.
  private currentBytes: Uint8Array | null = null;
  private currentExt = '';
  // Public for `GpuPresentHost` (the helper drops stale session renders on it); component-bumped.
  renderGeneration = 0;
  // Native (full-resolution, oriented) image dims, from the sized decode's
  // `nativeWidth`/`nativeHeight` (2D path) or the session dims (GPU path).
  // Drives the refine-target math; null until the cold open lands.
  private nativeDims = signal<{ w: number; h: number } | null>(null);
  // Long edge of the bitmap currently painted — refine only runs when it can
  // beat this (so zoom-out never re-renders, and fit never refines).
  private paintedLongEdge = 0;
  // Aspect (w/h) of the bitmap currently painted — feeds the fit/draw geometry
  // so a cropped render (different aspect) isn't stretched into the full-frame
  // rect (#638 review). Null until the first paint → falls back to asset dims.
  private paintedAspect = signal<{ w: number; h: number } | null>(null);
  // Gate the adjustment effect until the cold-open decode has finished and
  // recorded `lastRenderedXmp`. Without this, the synchronous-bytes path sets
  // `currentBytes` before `await decode` yields, so the adjustment effect can
  // fire in the same flush with the *pre-seed* default model and a null
  // `lastRenderedXmp` — scheduling a spurious `Some(xmp)` decode that, lacking
  // crs:Temperature, skips raw-core's As-Shot WB substitution and renders at
  // the 6500K default. The gate suppresses that pre-seed run and the As-Shot
  // seed's re-fire; the first genuine edit (post cold open) flows normally.
  private coldOpenDone = false;
  // The XMP the canvas currently reflects. Cold-open's no-XMP decode records
  // its post-seed model here so the adjustment effect dedups two
  // harmless-but-redundant fires: (1) its synchronous first run on asset
  // switch, and (2) the As-Shot WB seed's model write (which round-trips to the
  // same white balance raw-core already used on cold open). A genuine edit
  // changes the serialized XMP and passes the dedup. Public (`GpuPresentHost`)
  // so the GPU cold-open shares the same dedup key as the 2D path.
  lastRenderedXmp: string | null = null;

  // ── Continuous zoom (#1100, docs/zoom.md): pixelScale = REAL px per image
  // px (0 = fit, 1 = 100%, cap 8); the geometry helpers work in CSS scale.
  private readonly dpr = (): number =>
    (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

  /** CSS-scale view of the zoom for the draw/refine geometry ('fit' | cssScale). */
  private cssZoom = computed<'fit' | number>(() => {
    const ps = this.canvasSvc.pixelScale();
    return ps === 0 ? 'fit' : ps / this.dpr();
  });

  // Pointer/wheel/keyboard gesture controller (#1100) — state machine, math,
  // and DOM wiring live in `image-canvas.zoom-gestures.ts`; this host closure
  // supplies geometry. Protected: the template binds the toolbar to it.
  protected readonly gestures = new CanvasZoomGestures({
    wrapSize: () => ({ w: this.wrapW(), h: this.wrapH() }),
    wrapRect: () => this.wrapRef?.nativeElement?.getBoundingClientRect() ?? null,
    nativeSize: () => {
      const n = this.nativeDims();
      if (n) return { w: n.w, h: n.h };
      const a = this.state.focusedAsset();
      return a?.width && a?.height ? { w: a.width, h: a.height } : null;
    },
    devicePixelRatio: () => this.dpr(),
    pixelScale: () => this.canvasSvc.pixelScale(),
    pan: () => this.canvasSvc.pan(),
    commitView: (pixelScale, pan) => this.commitView(pixelScale, pan),
    moveDivider: (clientX) => {
      const rect = this.wrapRef.nativeElement.getBoundingClientRect();
      this.canvasSvc.setSplit((clientX - rect.left) / rect.width);
    },
  });

  // Zoom badge (#1100): percent of the EFFECTIVE real scale, always visible.
  // The controller reads the pixelScale/native/wrap signals inside this
  // computed's call, so the dependency tracking is unchanged.
  zoomLabel = computed(() => this.gestures.zoomPercent());

  // Download progress view-model for the open-progress bar: non-null only
  // while a genuine network download is in flight for the FOCUSED asset
  // (stale-asset guard); null hides the bar (cached/local/decode phase).
  readonly downloadProgress = computed(() => {
    const p = this.state.openDownloadProgress();
    const a = this.state.focusedAsset();
    if (!p || !a || p.id !== a.id) return null;
    const pct =
      p.total && p.total > 0 ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : null;
    return { loaded: p.loaded, total: p.total, pct };
  });

  // BM3D deep-denoise progress view-model (#1153). Non-null only while the
  // stage is genuinely running; the percentage is raw-core's own overall
  // completion across both passes, so the bar is determinate by construction
  // (spec § 3.2 requires visible, real progress — never a simulated sweep).
  readonly deepDenoiseProgress = computed(() => {
    const p = this.pipeline.deepDenoiseProgress();
    if (!p) return null;
    return { pass: p.pass, pct: Math.round(Math.min(1, Math.max(0, p.fraction)) * 100) };
  });

  // Displayed image size + scale in CSS px (the draw transform's geometry).
  // Pure geometry lives in `image-canvas.draw2d.ts`; this computed only wires
  // the signals (zoom / asset dims / wrap dims) into it.
  // Displayed image size: derives from the painted bitmap's aspect (which
  // reflects the crop) so a cropped result isn't stretched into the full-frame
  // rect (#638 review); falls back to the asset's stored dims pre-paint.
  private effectivePx = computed(() => {
    const asset = this.state.focusedAsset();
    const { w, h } = displayDims(this.paintedAspect(), asset?.width, asset?.height);
    return computeEffectivePx(this.cssZoom(), w, h, this.wrapW(), this.wrapH());
  });

  // ── Crop tool (#638; helpers in image-canvas.crop.ts) ───────────────────────
  // While Crop is armed the canvas shows the image UNCROPPED (crop stripped from
  // the render model) + rotated by the straighten angle; `CropOverlayComponent`
  // draws the interactive rect. Exiting re-renders the cropped result.

  /** True while the crop overlay should be shown (Crop pill armed). */
  protected readonly cropActive = computed(() => this.cropSession.active());

  /** CSS transform for the live straighten preview (rotate only). */
  protected readonly cropCanvasTransform = computed<string>(() => {
    const a = this.state.focusedAsset();
    const angle = a ? this.state.adjustmentFor(a.id)().crop.angle : 0;
    return cropStraightenTransform(this.cropSession.active(), angle);
  });

  /** Serialize for the renderer, crop-stripped while cropping so the canvas
   *  shows the full frame under the overlay. Public: also satisfies
   *  `GpuPresentHost` so the GPU cold-open dedup matches the 2D path. */
  serializeForRender(model: AdjustmentModel): string {
    return this.xmpSerializer.serialize(renderModelForCrop(model, this.cropSession.active()));
  }

  /**
   * Commit a view from the gesture controller (#1100): pixelScale (0 = fit)
   * + pan. The controller already clamped the pan against the geometry.
   */
  private commitView(pixelScale: number, pan: { x: number; y: number }): void {
    if (pixelScale === 0) {
      this.canvasSvc.zoomToFit();
      return;
    }
    this.canvasSvc.setPixelScale(pixelScale);
    this.canvasSvc.pan.set(pan);
  }

  ngAfterViewInit(): void {
    this.ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        this.wrapW.set(e.contentRect.width);
        this.wrapH.set(e.contentRect.height);
      }
    });
    this.ro.observe(this.wrapRef.nativeElement);
    this.wrapW.set(this.wrapRef.nativeElement.clientWidth || 800);
    this.wrapH.set(this.wrapRef.nativeElement.clientHeight || 600);

    // Zoom/pan gestures (#1100) — attached imperatively (non-passive wheel).
    this.detachGestures = this.gestures.attach(this.wrapRef.nativeElement);

    // Watch focused asset — decode if it has bytes.
    const decodeEff = effect(
      () => {
        const a = this.state.focusedAsset();
        if (!a) {
          this.imageBitmap.set(null);
          this.canvasSvc.currentPixels.set(null);
          return;
        }
        if (a.id === this.currentAssetId) return; // same asset, skip
        this.currentAssetId = a.id;
        // New asset → invalidate any in-flight adjustment re-render and drop
        // the retained bytes. `lastRenderedXmp` is reset so the first edit on
        // the new asset always renders; the cold-open decode records the
        // post-seed XMP below so the seed-driven effect fire dedups out.
        this.renderGeneration++;
        this.clearRerenderTimers();
        // Tear down any GPU live session from the previous asset (its surface is
        // bound to that image's dims; a new asset opens a fresh session + canvas).
        this.gpuPresent.teardown();
        this.currentBytes = null;
        this.currentExt = '';
        this.lastRenderedXmp = null;
        this.coldOpenDone = false;
        this.nativeDims.set(null);
        this.paintedLongEdge = 0;
        this.paintedAspect.set(null);
        this.byteLoadError.set(null);

        const bytes = this.state.bytesFor(a.id);
        if (bytes) {
          void this.loadReal(a.id, a.filename, bytes);
          return;
        }

        // Backend-resolvable asset (Self-Hosted): the bytes aren't in the
        // in-memory cache yet. Kick off the async read; once it resolves we
        // re-enter loadReal. Guard with a stale-id check so a fast asset switch
        // doesn't decode the wrong file.
        //
        // The gate accepts EITHER the legacy `fs:<absPath>` deep-link field OR a
        // MapleAddress id. The M2 unified addressing (#1325) keys assets by
        // `slug:relPath` and no longer populates `absPath`, so gating on
        // `absPath` alone dropped every browse-opened backend asset into the
        // mock-gradient branch below — it fetched nothing and showed a
        // placeholder. A MapleAddress id always contains ':' (slug:relPath);
        // mock assets (Hosted demo: `a-film`, `f-france`, …) and UUID imports
        // never do, so they still fall through to the gradient / in-memory path.
        if (a.absPath || a.id.includes(':')) {
          fetchAndLoadBytes(this, a.id, a.filename);
          return;
        }

        // Mock asset (no source) — clear real bitmap, fall back to gradient.
        this.imageBitmap.set(null);
        this.canvasSvc.currentPixels.set(null);
      },
      { injector: this.injector },
    );
    this.cleanupDecodeEffect = () => decodeEff.destroy();

    // Re-render the live canvas whenever the focused asset's adjustment model
    // changes (#846). Reading `adjustmentFor(id)()` registers a dependency on
    // the model signal, so a Profile toggle or slider move re-fires this
    // effect; the asset-switch case is handled by the decode effect above (and
    // skipped here via the `lastRenderedXmp` dedup).
    const rerenderEff = effect(
      () => {
        const a = this.state.focusedAsset();
        if (!a) return;
        // Subscribe to the model signal — this is what makes edits reactive.
        const model = this.state.adjustmentFor(a.id)();
        // Only RAW assets with retained bytes participate (mock/gradient
        // assets and not-yet-decoded async sources have no bytes here). Gate on
        // `coldOpenDone` so the pre-seed initial run and the As-Shot WB seed's
        // re-fire don't schedule a spurious 6500K-default decode.
        if (!this.currentBytes || a.id !== this.currentAssetId || !this.coldOpenDone) return;
        // Dedup: cold open + As-Shot WB seed both land on the same XMP the
        // canvas already shows, so skip the redundant decode. A genuine edit
        // produces a different XMP and renders. Reading `cropSession.active()`
        // (via `serializeForRender`) makes entering/leaving crop re-fire this
        // effect — crop-on strips the crop (renders full frame), crop-off
        // restores it (renders the cropped result).
        const xmp = this.serializeForRender(model);
        if (xmp === this.lastRenderedXmp) return;
        this.scheduleRerender(xmp);
      },
      { injector: this.injector },
    );
    this.cleanupRerenderEffect = () => rerenderEff.destroy();

    // Re-render whenever view or decode state changes.
    const drawEff = effect(
      () => {
        const _ = this.state.focusedAsset();
        const __ = this.canvasSvc.pixelScale();
        const ___ = this.canvasSvc.pan();
        const ____ = this.canvasSvc.beforeAfterSplitX();
        const _____ = this.wrapW();
        const ______ = this.wrapH();
        const _______ = this.imageBitmap();
        // `gpuPresent.active()` is tracked via the branch read below. On the GPU
        // live path the OffscreenCanvas holds the pixels (worker-owned); we only
        // CSS-position/scale it (viewport-res, #1080). `draw()` = flag-off path.
        if (this.gpuPresent.active()) {
          this.gpuPresent.applyView();
        } else {
          this.draw();
        }
      },
      { injector: this.injector },
    );
    this.cleanupDrawEffect = () => drawEff.destroy();

    // Zooming in (or growing the viewport) raises the refine target above what
    // the canvas currently shows — schedule a refine pass for the CURRENT
    // model so the zoomed view sharpens up to `native × min(scale, 1)` without
    // requiring an edit (#1101). Debounced like the edit refine so a zoom burst
    // coalesces. GPU live path: no refine (viewport-sized #1080; CSS-upscales).
    const refineViewEff = effect(
      () => {
        const _ = this.canvasSvc.pixelScale();
        const __ = this.wrapW();
        const ___ = this.wrapH();
        if (!this.coldOpenDone || !this.currentBytes || this.gpuPresent.active()) return;
        const a = this.state.focusedAsset();
        if (!a || a.id !== this.currentAssetId) return;
        // Untracked: the rerender effect owns model-driven renders; this
        // effect only reacts to view geometry.
        const xmp = untracked(() => this.serializeForRender(this.state.adjustmentFor(a.id)()));
        this.twoPhase.scheduleRefine(xmp, this.renderGeneration);
      },
      { injector: this.injector },
    );
    this.cleanupRefineViewEffect = () => refineViewEff.destroy();
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.detachGestures?.();
    this.cleanupDecodeEffect?.();
    this.cleanupRerenderEffect?.();
    this.cleanupDrawEffect?.();
    this.cleanupRefineViewEffect?.();
    this.clearRerenderTimers();
    // Invalidate any in-flight re-render so a late decode can't touch a
    // destroyed component's signals.
    this.renderGeneration++;
    // Tear down the GPU live session (frees the worker-side GPU handle + removes
    // the GPU canvas element); no-op on the flag-off path.
    this.gpuPresent.teardown();
    this.imageBitmap()?.close();
  }

  // ── Render-target math (#1101, docs/zoom.md): pure formulas live in
  // `image-canvas.draw2d.ts`; these wrappers wire the signals into them.

  // Fast-phase target: the viewport long edge, floored at 1 (degenerate wrap).
  // Public for `Render2dHost`.
  fastTargetPx(): number {
    return this.viewportTargetLongEdge() ?? 1;
  }

  /** Refine-phase target — see `computeRefineTargetLongEdge`. */
  private refineTargetPx(): number | null {
    const native = this.nativeDims();
    if (!native) return null;
    return computeRefineTargetLongEdge({
      zoom: this.cssZoom(),
      nativeW: native.w,
      nativeH: native.h,
      wrapW: this.wrapW(),
      wrapH: this.wrapH(),
      dpr: this.dpr(),
      fastTarget: this.fastTargetPx(),
      paintedLongEdge: this.paintedLongEdge,
    });
  }

  // Public: also satisfies `ByteLoadHost` (called on a successful fetch).
  async loadReal(assetId: AssetId, filename: string, bytes: Uint8Array): Promise<void> {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    // Retain bytes + ext for adjustment-driven re-renders (no XMP on this
    // cold-open decode — raw-core substitutes the camera As-Shot WB).
    this.currentBytes = bytes;
    this.currentExt = ext;

    // GPU live-render path (#1038): persistent worker session presenting to an
    // OffscreenCanvas; any failure falls back to the 2D decode path below.
    if (this.gpuPresent.enabled && !isNonRawExtension(ext)) {
      // A successful open recorded the reply's NATIVE dims (asset + `nativeDims`
      // via `recordNativeDims`) — the session itself is viewport-sized (#1080).
      if (await this.gpuPresent.open(assetId, bytes, ext)) return;
      // GPU open failed (e.g. non-gpu bundle / no WebGPU) — fall through to 2D.
    }

    // WASM-CPU cold-open decode + paint (image-canvas.render2d.ts).
    await coldOpen2d(this, assetId, filename, ext, bytes);
  }

  /** Record the painted bitmap's long edge + aspect (`Render2dHost`). */
  recordPaintedDims(w: number, h: number): void {
    this.paintedLongEdge = Math.max(w, h);
    this.paintedAspect.set({ w, h });
  }

  /** Schedule a refine pass (`Render2dHost`). */
  scheduleRefine(xmp: string, generation: number): void {
    this.twoPhase.scheduleRefine(xmp, generation);
  }

  /** `ByteLoadHost`: re-attempt the fetch behind `byteLoadError` (Retry button). */
  retryByteLoad(): void {
    const err = this.byteLoadError();
    if (err) fetchAndLoadBytes(this, err.id, err.filename);
  }

  // ── GpuPresentHost ───────────────────────────────────────────────────────
  // The helper reaches the public signals/services above directly; the gate,
  // CSS layout, develop target (#1080) + native-dims record need methods here.

  /** Open the adjustment-effect gate once the GPU cold-open has presented. */
  markColdOpenDone(): void {
    this.coldOpenDone = true;
  }

  /** The GPU canvas's CSS layout, mirrored from the 2D canvas. */
  currentLayout(): { canvasW: number; canvasH: number; pan: { x: number; y: number } } {
    const { canvasW, canvasH } = this.effectivePx();
    return { canvasW, canvasH, pan: this.canvasSvc.pan() };
  }

  /** GPU develop target (#1080): viewport long edge in real px; `undefined` → WASM's 2048 cap. */
  viewportTargetLongEdge(): number | undefined {
    return computeViewportTargetLongEdge(this.wrapW(), this.wrapH());
  }

  /** Record the session reply's native dims (#1080) for the refine/zoom math. */
  recordNativeDims(w: number, h: number): void {
    if (w && h) this.nativeDims.set({ w, h });
  }

  /**
   * Schedule the two-phase render for the current adjustment model. Called
   * from the adjustment effect on every model tick; the scheduler fires the
   * fast phase immediately (coalesced latest-wins) and the refine phase
   * behind the trailing debounce.
   */
  private scheduleRerender(xmp: string): void {
    // Bump the generation so any render already in flight (from an earlier
    // edit) drops its result instead of painting stale pixels.
    this.renderGeneration++;
    this.twoPhase.schedule(xmp, this.renderGeneration);
  }

  private clearRerenderTimers(): void {
    this.twoPhase.clear();
  }

  /**
   * Re-render the retained RAW bytes with the given XMP at `sizing`'s target
   * and publish the result — only if `generation` is still current when the
   * render returns (renders run to completion behind a serialization gate; a
   * stale result is dropped, never painted). On the GPU live path (#1038)
   * this delegates to `gpuPresent.render()` (`sizing` is ignored there).
   */
  private async runRender(xmp: string, generation: number, sizing: RenderSizing): Promise<void> {
    const bytes = this.currentBytes;
    if (!bytes) return;

    if (this.gpuPresent.active()) {
      const a = this.state.focusedAsset();
      let params: Float32Array | undefined = undefined;
      if (a) {
        const model = this.state.adjustmentFor(a.id)();
        // #1914: only take the 19-scalar fast path when it can faithfully render
        // the model. HSL / tone / split-tone / sharpen / NR / profile edits it
        // can't carry leave `params` undefined, so `gpuPresent.render` routes
        // through the full render(xmp) path instead of silently dropping them.
        if (canUseLiveFastPath(model)) params = buildLiveParams(model);
      }
      // The helper presents to the OffscreenCanvas + stale-guards on `generation`,
      // returning whether to record the result (see its `render()` doc).
      const accepted = await this.gpuPresent.render(xmp, generation, params);
      if (accepted) this.lastRenderedXmp = xmp;
      return;
    }

    // WASM-CPU re-render + paint (image-canvas.render2d.ts).
    await runRender2d(this, xmp, generation, sizing, bytes, this.currentExt);
  }

  /**
   * Draw into the viewport-sized backing store (#1101) — the paint path lives
   * in `image-canvas.draw2d.ts` (`drawCanvas2d`); this gathers the signal
   * inputs. The signal reads stay inside the draw effect's synchronous call,
   * so its dependency set is unchanged by the extraction.
   */
  private draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const { canvasW, canvasH } = this.effectivePx();
    drawCanvas2d(canvas, {
      wrapW: this.wrapW(),
      wrapH: this.wrapH(),
      canvasW,
      canvasH,
      pan: this.canvasSvc.pan(),
      bitmap: this.imageBitmap(),
      split: this.canvasSvc.beforeAfterSplitX(),
      gradientUrl: this.state.focusedAsset()?.thumbnailGradient,
    });
  }

  // ── Gestures (#1100, spec §5.0/§5.2) — routing lives in CanvasZoomGestures ─

  /** Cmd/Ctrl+0 → fit, Cmd/Ctrl+1 → 100% (bare 0/1 stay S5 tool/rating keys). */
  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    this.gestures.onKeydown(e, !!this.state.focusedAsset());
  }

  onDividerDrag(e: PointerEvent): void {
    this.gestures.onDividerDown(e, this.wrapRef.nativeElement);
  }
}
