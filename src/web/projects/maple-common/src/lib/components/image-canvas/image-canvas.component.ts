// ImageCanvasComponent — center column; zoom + pan + before/after divider.
// Uses real decoded pixels via RawPipelineService for imported assets.
// Falls back to gradient placeholders for mock assets.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { imageDataToBitmap } from '../../raw-pipeline/image-utils';
import { ImageCanvasService } from './image-canvas.service';
import { AssetId } from '../../models/asset';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { isNonRawExtension } from '../../state/raw-extensions';
import { ImageCanvasGpuPresent, type GpuPresentHost } from './image-canvas.gpu-present';

@Component({
  selector: 'editor-image-canvas',
  standalone: true,
  templateUrl: './image-canvas.component.html',
  styleUrl: './image-canvas.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageCanvasComponent implements AfterViewInit, OnDestroy, GpuPresentHost {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('wrap') wrapRef!: ElementRef<HTMLElement>;

  state = inject(LibraryStateService);
  canvasSvc = inject(ImageCanvasService);
  pipeline = inject(RawPipelineService);
  // Public for `GpuPresentHost` (the GPU cold-open serializes the live model).
  readonly xmpSerializer = inject(XmpSerializerService);
  private readonly injector = inject(Injector);

  readonly loading = signal(false);
  readonly imageBitmap = signal<ImageBitmap | null>(null);

  // GPU live-render path (epic #925, P4b-web / #1038). The GPU canvas lifecycle +
  // worker session wiring lives in `ImageCanvasGpuPresent` (see that file for the
  // full scope/invariant notes); this component owns the shared cold-open
  // bookkeeping via the `GpuPresentHost` interface so the 2D and GPU paths stay in
  // sync. Flag OFF keeps the 2D path below as the only render route.
  private readonly gpuPresent = new ImageCanvasGpuPresent(this);

  private ro?: ResizeObserver;
  private wrapW = signal<number>(800);
  private wrapH = signal<number>(600);
  private dragging = false;
  private dragLast = { x: 0, y: 0 };
  private dividerDragging = false;
  private cleanupDecodeEffect?: () => void;
  private cleanupRerenderEffect?: () => void;
  private cleanupDrawEffect?: () => void;
  private cleanupRefineViewEffect?: () => void;
  // Public for `GpuPresentHost` (the helper's stale guards read it); component-mutated.
  currentAssetId: AssetId | null = null;

  // ── Two-phase live render (#846 → #1101) ──────────────────────────────────
  // Every render goes through the same WASM paths raw-core / maple-cli use, so
  // every edit (Profile toggle, sliders) is correctness-complete by
  // construction (web == the Rust reference). Two phases per spec §5.1:
  //
  //  - FAST phase: on every adjustment tick, immediately render at viewport
  //    resolution (element size × devicePixelRatio) through the sized decode
  //    (`decodeSized` → `render_bytes_sized`, Preview demosaic). Fast renders
  //    are coalesced latest-wins: at most one decode sits in the worker and at
  //    most one tick waits behind it; superseded results are dropped via the
  //    generation counter (a WASM render can't be interrupted mid-flight, so
  //    "cancel" = drop the stale result).
  //  - REFINE phase: the existing 150 ms trailing debounce, now at
  //    `nativeLongEdge × min(realZoomScale, 1)` floored at the fast target
  //    (CanvasMath's formula, docs/zoom.md). At fit the refine target equals
  //    the fast target by construction, so refine is skipped — fit renders
  //    only the viewport-sized image. Zoomed in, refine sharpens up to native.
  //
  // On the GPU live path (#1038) the persistent session renders full-res with
  // resident buffers (upload-once; per-tick = uniforms + dispatch), so ticks
  // route straight to the session (immediate, coalesced) and there is nothing
  // to refine. This closes the "fast phase intentionally deferred" follow-up
  // recorded here under #846.
  private static readonly REFINE_DEBOUNCE_MS = 150;
  // Bytes + extension for the focused asset, retained so adjustment-driven
  // re-renders don't re-read from the byte cache. `decode()` slices a copy of
  // the buffer before transferring it into the worker, so the original view
  // here is never detached — repeated decodes are safe.
  private currentBytes: Uint8Array | null = null;
  private currentExt = '';
  // Public for `GpuPresentHost` (the helper drops stale session renders on it); component-bumped.
  renderGeneration = 0;
  private refineTimer: ReturnType<typeof setTimeout> | null = null;
  // Fast-phase coalescing (latest-wins): the newest tick waiting to render,
  // and whether a fast render is currently in flight draining it.
  private pendingFast: { xmp: string; generation: number } | null = null;
  private fastInFlight = false;
  // Native (full-resolution, oriented) image dims, from the sized decode's
  // `nativeWidth`/`nativeHeight` (2D path) or the session dims (GPU path).
  // Drives the refine-target math; null until the cold open lands.
  private nativeDims = signal<{ w: number; h: number } | null>(null);
  // Long edge of the bitmap currently painted — refine only runs when it can
  // beat this (so zoom-out never re-renders, and fit never refines).
  private paintedLongEdge = 0;
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

  zoomLabel = computed(() => {
    const z = this.canvasSvc.zoom();
    return z === 'fit' ? 'Fit' : `${Math.round((z as number) * 100)}%`;
  });

  /**
   * Download progress view-model for the open-progress bar. Resolves to a
   * value only while a genuine network download is in flight for the asset
   * that's currently focused — a stale-asset guard so a fast A→B switch can't
   * paint A's progress on B. `null` (cached/local/instant opens, or decode
   * phase) hides the bar entirely.
   */
  readonly downloadProgress = computed(() => {
    const p = this.state.openDownloadProgress();
    const a = this.state.focusedAsset();
    if (!p || !a || p.id !== a.id) return null;
    const pct =
      p.total && p.total > 0 ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : null;
    return { loaded: p.loaded, total: p.total, pct };
  });

  /** Displayed image size + scale in CSS px (the draw transform's geometry). */
  private effectivePx = computed(() => {
    const z = this.canvasSvc.zoom();
    const asset = this.state.focusedAsset();
    const W = this.wrapW();
    const H = this.wrapH();
    const aw = asset?.width ?? 6240;
    const ah = asset?.height ?? 4160;
    if (z === 'fit') {
      const scale = Math.min(W / aw, H / ah, 1);
      return { scale, canvasW: Math.round(aw * scale), canvasH: Math.round(ah * scale) };
    }
    const scale = z as number;
    return { scale, canvasW: Math.round(aw * scale), canvasH: Math.round(ah * scale) };
  });

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

        const bytes = this.state.bytesFor(a.id);
        if (bytes) {
          void this.loadReal(a.id, a.filename, bytes);
          return;
        }

        // Self-Hosted FS-walk path (and any other async source): the bytes
        // aren't in the in-memory cache yet. Kick off the async read; once
        // it resolves we re-enter loadReal. Guard with a stale-id check so
        // a fast asset switch doesn't decode the wrong file.
        if (a.absPath) {
          const requestedId = a.id;
          this.imageBitmap.set(null);
          this.canvasSvc.currentPixels.set(null);
          this.state
            .bytesForAsset(requestedId)
            .then((fetched) => {
              if (this.currentAssetId !== requestedId) return; // user moved on
              void this.loadReal(requestedId, a.filename, fetched);
            })
            .catch((err) => {
              console.error('[image-canvas] bytesForAsset failed:', err);
            });
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
        // produces a different XMP and renders.
        const xmp = this.xmpSerializer.serialize(model);
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
        const __ = this.canvasSvc.zoom();
        const ___ = this.canvasSvc.pan();
        const ____ = this.canvasSvc.beforeAfterSplitX();
        const _____ = this.wrapW();
        const ______ = this.wrapH();
        const _______ = this.imageBitmap();
        const ________ = this.gpuPresent.active();
        // On the GPU live path the OffscreenCanvas holds the pixels (worker-owned);
        // we only CSS-position/scale it here (the surface is image-res). The 2D
        // `draw()` is for the flag-off / mock / before-after path.
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
    // requiring an edit (#1101). Debounced like the edit refine so a zoom
    // burst coalesces. The GPU path presents full-res and never needs this.
    const refineViewEff = effect(
      () => {
        const _ = this.canvasSvc.zoom();
        const __ = this.wrapW();
        const ___ = this.wrapH();
        if (!this.coldOpenDone || !this.currentBytes || this.gpuPresent.active()) return;
        const a = this.state.focusedAsset();
        if (!a || a.id !== this.currentAssetId) return;
        // Untracked: the rerender effect owns model-driven renders; this
        // effect only reacts to view geometry.
        const xmp = untracked(() => this.xmpSerializer.serialize(this.state.adjustmentFor(a.id)()));
        this.scheduleRefine(xmp, this.renderGeneration);
      },
      { injector: this.injector },
    );
    this.cleanupRefineViewEffect = () => refineViewEff.destroy();
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
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

  // ── Render-target math (#1101, docs/zoom.md) ──────────────────────────────

  /** Fast-phase target: the viewport long edge in real pixels (CSS × dpr). */
  private fastTargetPx(): number {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.max(1, Math.ceil(Math.max(this.wrapW(), this.wrapH()) * dpr));
  }

  /**
   * Real screen pixels per image pixel at the current zoom (docs/zoom.md's
   * `pixelScale` semantics). The stepped zoom levels are CSS scales, so the
   * real scale is `z × dpr`; fit derives from the viewport/native ratio.
   */
  private effectiveRealScale(): number {
    const native = this.nativeDims();
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const z = this.canvasSvc.zoom();
    if (z !== 'fit') return (z as number) * dpr;
    if (!native) return 1;
    return Math.min((this.wrapW() * dpr) / native.w, (this.wrapH() * dpr) / native.h);
  }

  /**
   * Refine-phase target long edge: `native × min(realScale, 1)`, floored at
   * the fast target and capped at native (`CanvasMath.refinedTargetSize`'s
   * formula). Returns `null` when the refine pass cannot beat the bitmap
   * already painted — at fit the fitted long edge never exceeds the viewport
   * long edge, so refine is skipped there by construction.
   */
  private refineTargetPx(): number | null {
    const native = this.nativeDims();
    if (!native) return null;
    const nativeLong = Math.max(native.w, native.h);
    const scale = Math.min(this.effectiveRealScale(), 1);
    const target = Math.min(nativeLong, Math.ceil(nativeLong * scale));
    const fast = Math.min(this.fastTargetPx(), nativeLong);
    const t = Math.max(target, fast);
    return t > this.paintedLongEdge ? t : null;
  }

  private async loadReal(assetId: AssetId, filename: string, bytes: Uint8Array): Promise<void> {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    // Retain bytes + ext for adjustment-driven re-renders (no XMP on this
    // cold-open decode — raw-core substitutes the camera As-Shot WB).
    this.currentBytes = bytes;
    this.currentExt = ext;

    // GPU live-render path (#1038): a RAW asset with the flag on renders through a
    // persistent worker session presenting to an OffscreenCanvas. Falls back to the
    // 2D decode path below on any failure (incl. a gpu-off WASM bundle). Non-RAW
    // images + the flag-off default always take the 2D path.
    if (this.gpuPresent.enabled && !isNonRawExtension(ext)) {
      const ok = await this.gpuPresent.open(assetId, bytes, ext);
      if (ok) {
        // The session is full-res; record native dims for the zoom math.
        const a = this.state.focusedAsset();
        if (a && a.id === assetId && a.width && a.height) {
          this.nativeDims.set({ w: a.width, h: a.height });
        }
        return;
      }
      // GPU open failed (e.g. non-gpu bundle / no WebGPU) — fall through to 2D.
    }

    this.loading.set(true);
    // Bracket the whole click → pixels path. `maple:open` is the outer
    // measure; `maple:decode` (service) and `maple:wasm` (worker) are nested
    // sub-intervals. View in DevTools → Performance → User Timings.
    performance.mark(`maple:open:${assetId}:start`);
    try {
      // Viewport-sized cold open (#1101): decode at the fast-phase target so
      // first pixels land at viewport resolution (Preview demosaic). The
      // refine pass below sharpens when the view is zoomed past fit.
      const decoded = await this.pipeline.decodeSized(bytes, ext, this.fastTargetPx());

      // Update dimensions on the asset — the NATIVE dims (the sized reply
      // carries them), not the viewport-sized buffer's.
      const nativeW = decoded.nativeWidth ?? decoded.width;
      const nativeH = decoded.nativeHeight ?? decoded.height;
      this.state.updateAssetDimensions(assetId, nativeW, nativeH);
      if (assetId === this.currentAssetId) {
        this.nativeDims.set({ w: nativeW, h: nativeH });
      }

      // Seed WB sliders from the camera's "As Shot" metadata on the first
      // render — purely cosmetic sync with what Rust actually used, doesn't
      // overwrite user edits (the state method guards on "still default").
      this.state.seedAsShotWhiteBalance(assetId, decoded.asShotTemperature, decoded.asShotTint);

      // Open the cold-open gate and record what this no-XMP render reflects.
      // The seed's signal write re-fires the adjustment effect on the next
      // flush; that run serializes the same model and dedups against
      // `lastRenderedXmp`, so we don't re-decode an image we just painted. A
      // genuine subsequent edit changes the XMP and renders. Guard on
      // still-current asset so a fast A→B switch doesn't stamp A's XMP onto B.
      if (assetId === this.currentAssetId) {
        this.coldOpenDone = true;
        // Record the XMP this cold-open render reflects. The no-XMP decode is
        // equivalent to the post-seed default model (As-Shot WB, default
        // sliders), so serializing the current model after the seed yields the
        // XMP the canvas now shows.
        const liveXmp = this.xmpSerializer.serialize(this.state.adjustmentFor(assetId)());
        if (liveXmp === this.lastRenderedXmp) {
          // Already what the canvas shows (re-entrant cold open) — nothing to do.
        } else if (this.lastRenderedXmp === null) {
          // Normal cold open: no edit landed during the in-flight decode, so
          // the live model is just the seeded baseline. Record it; the
          // gate-driven effect re-fire (and the As-Shot seed re-fire) dedup
          // against it. If an edit *did* land mid-decode, the model already
          // diverged from the seeded baseline — but we can't distinguish that
          // from the baseline here, so the rare mid-cold-open edit is folded
          // into this baseline and self-corrects on the user's next edit.
          this.lastRenderedXmp = liveXmp;
        }
      }

      // Publish pixels for scopes.
      this.canvasSvc.currentPixels.set(decoded);

      const bitmap = await imageDataToBitmap(decoded);
      // Close any previous bitmap to free GPU memory.
      this.imageBitmap()?.close();
      this.imageBitmap.set(bitmap);
      this.paintedLongEdge = Math.max(decoded.width, decoded.height);
      performance.mark(`maple:open:${assetId}:paint`);
      performance.measure(
        `maple:open`,
        `maple:open:${assetId}:start`,
        `maple:open:${assetId}:paint`,
      );

      // A cold open while zoomed past fit needs the refine pass right away
      // (no edit will come to trigger it).
      if (assetId === this.currentAssetId && this.lastRenderedXmp !== null) {
        this.scheduleRefine(this.lastRenderedXmp, this.renderGeneration);
      }
    } catch (e) {
      console.error('Decode failed for', filename, e);
      this.imageBitmap.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  // ── GpuPresentHost ───────────────────────────────────────────────────────
  // The GPU present helper reaches `state`/`canvasSvc`/`loading`/`imageBitmap`/
  // `xmpSerializer` directly (all public above); only the cold-open gate and the
  // CSS layout (composed from the private `effectivePx`) need a method here.

  /** Open the adjustment-effect gate once the GPU cold-open has presented. */
  markColdOpenDone(): void {
    this.coldOpenDone = true;
  }

  /** The GPU canvas's CSS layout, mirrored from the 2D canvas. */
  currentLayout(): { canvasW: number; canvasH: number; pan: { x: number; y: number } } {
    const { canvasW, canvasH } = this.effectivePx();
    return { canvasW, canvasH, pan: this.canvasSvc.pan() };
  }

  /**
   * Schedule the two-phase render for the current adjustment model: the fast
   * phase immediately (coalesced latest-wins) and the refine phase behind the
   * trailing debounce. Called from the adjustment effect on every model tick.
   */
  private scheduleRerender(xmp: string): void {
    // Bump the generation so any render already in flight (from an earlier
    // edit) drops its result instead of painting stale pixels.
    this.renderGeneration++;
    const generation = this.renderGeneration;
    this.enqueueFastRender(xmp, generation);
    this.scheduleRefine(xmp, generation);
  }

  /**
   * Fast phase: latest-wins coalescing. The newest tick replaces any waiting
   * one; a single drain loop keeps exactly one render in the worker at a time
   * (the service's decode gate serializes further down too).
   */
  private enqueueFastRender(xmp: string, generation: number): void {
    this.pendingFast = { xmp, generation };
    if (!this.fastInFlight) void this.drainFastRenders();
  }

  private async drainFastRenders(): Promise<void> {
    this.fastInFlight = true;
    try {
      while (this.pendingFast) {
        const { xmp, generation } = this.pendingFast;
        this.pendingFast = null;
        if (generation !== this.renderGeneration) continue; // superseded tick
        await this.runRender(xmp, generation, {
          maxLongEdge: this.fastTargetPx(),
          qualityPreview: true,
        });
      }
    } finally {
      this.fastInFlight = false;
    }
  }

  /**
   * Refine phase (2D path only — the GPU session presents full-res already):
   * trailing-edge debounce, target recomputed at fire time so a zoom that
   * settled meanwhile is honoured; a `null` target (fit, or nothing to gain
   * over the painted bitmap) skips the pass entirely.
   */
  private scheduleRefine(xmp: string, generation: number): void {
    if (this.refineTimer) clearTimeout(this.refineTimer);
    if (this.gpuPresent.active()) {
      this.refineTimer = null;
      return;
    }
    this.refineTimer = setTimeout(() => {
      this.refineTimer = null;
      if (generation !== this.renderGeneration) return;
      const target = this.refineTargetPx();
      if (target === null) return;
      void this.runRender(xmp, generation, { maxLongEdge: target, qualityPreview: false });
    }, ImageCanvasComponent.REFINE_DEBOUNCE_MS);
  }

  private clearRerenderTimers(): void {
    if (this.refineTimer) {
      clearTimeout(this.refineTimer);
      this.refineTimer = null;
    }
    this.pendingFast = null;
  }

  /**
   * Re-render the retained RAW bytes with the given XMP at `sizing`'s target
   * and publish the result — but only if `generation` is still current when
   * the render returns. A render runs to completion behind a serialization
   * gate (the service's decode gate, or the worker's session-render queue), so
   * a newer edit can't interrupt an in-flight render; the generation guard
   * instead drops the stale result so it never overwrites a fresher frame. On
   * the GPU live path (#1038) this delegates to `gpuPresent.render()`
   * (zero-readback present, no bitmap, full-res — `sizing` is ignored there).
   */
  private async runRender(
    xmp: string,
    generation: number,
    sizing: { maxLongEdge: number; qualityPreview: boolean },
  ): Promise<void> {
    const bytes = this.currentBytes;
    const ext = this.currentExt;
    if (!bytes) return;

    if (this.gpuPresent.active()) {
      // The helper presents to the OffscreenCanvas + stale-guards on `generation`,
      // returning whether to record the result (see its `render()` doc).
      const accepted = await this.gpuPresent.render(xmp, generation);
      if (accepted) this.lastRenderedXmp = xmp;
      return;
    }

    try {
      const decoded = await this.pipeline.decodeSized(
        bytes,
        ext,
        sizing.maxLongEdge,
        xmp,
        sizing.qualityPreview,
      );
      // Stale guard: a newer edit (or asset switch) bumped the generation
      // while this decode was in flight — drop it.
      if (generation !== this.renderGeneration) return;

      this.canvasSvc.currentPixels.set(decoded);
      const bitmap = await imageDataToBitmap(decoded);
      // Re-check after the async bitmap step.
      if (generation !== this.renderGeneration) {
        bitmap.close();
        return;
      }
      this.imageBitmap()?.close();
      this.imageBitmap.set(bitmap);
      this.paintedLongEdge = Math.max(decoded.width, decoded.height);
      this.lastRenderedXmp = xmp;
    } catch (e) {
      console.error('[image-canvas] adjustment re-render failed:', e);
    }
  }

  /**
   * Draw into the viewport-sized backing store (#1101): the canvas element
   * fills the wrap and its backing store is `viewport × dpr`; zoom/pan are a
   * draw transform (the destination rect), never the canvas size. The bitmap
   * may be ANY resolution (fast = viewport-sized, refine = up to native) —
   * `drawImage` maps it onto the same destination rect either way.
   */
  private draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const bw = Math.max(1, Math.round(this.wrapW() * dpr));
    const bh = Math.max(1, Math.round(this.wrapH() * dpr));
    // Only touch the backing store when the viewport actually changed —
    // assigning width/height clears + reallocates.
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, bw, bh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Destination rect in real (backing-store) pixels: the displayed image
    // size centered in the viewport, offset by the pan.
    const { canvasW, canvasH } = this.effectivePx();
    const pan = this.canvasSvc.pan();
    const dw = canvasW * dpr;
    const dh = canvasH * dpr;
    const dx = (this.wrapW() / 2 + pan.x) * dpr - dw / 2;
    const dy = (this.wrapH() / 2 + pan.y) * dpr - dh / 2;

    const asset = this.state.focusedAsset();
    const bitmap = this.imageBitmap();
    const split = this.canvasSvc.beforeAfterSplitX();

    if (bitmap) {
      // Real decoded pixels.
      if (split !== null) {
        // Split at a fraction of the VIEWPORT (matches the divider overlay,
        // which is positioned at % of the wrap).
        const splitPx = Math.round(bw * split);
        // "Before" half.
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, splitPx, bh);
        ctx.clip();
        ctx.drawImage(bitmap, dx, dy, dw, dh);
        ctx.restore();
        // "After" half — same image for now (adjustments wired in P6).
        ctx.save();
        ctx.beginPath();
        ctx.rect(splitPx, 0, bw - splitPx, bh);
        ctx.clip();
        ctx.drawImage(bitmap, dx, dy, dw, dh);
        // Slight brightness bump to indicate "after processed".
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(splitPx, 0, bw - splitPx, bh);
        ctx.restore();
      } else {
        ctx.drawImage(bitmap, dx, dy, dw, dh);
      }
    } else {
      // Gradient placeholder for mock assets — fills the would-be image rect.
      if (split !== null) {
        const splitPx = Math.round(bw * split);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, splitPx, bh);
        ctx.clip();
        this.drawGradient(ctx, asset?.thumbnailGradient, dx, dy, dw, dh, 0);
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.rect(splitPx, 0, bw - splitPx, bh);
        ctx.clip();
        this.drawGradient(ctx, asset?.thumbnailGradient, dx, dy, dw, dh, 15);
        ctx.restore();
      } else {
        this.drawGradient(ctx, asset?.thumbnailGradient, dx, dy, dw, dh, 0);
      }
    }
  }

  private drawGradient(
    ctx: CanvasRenderingContext2D,
    gradientUrl: string | undefined,
    x: number,
    y: number,
    w: number,
    h: number,
    lightenBy: number,
  ): void {
    if (w <= 0 || h <= 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    if (gradientUrl) {
      const img = new Image();
      img.onload = () => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.drawImage(img, x, y, w, h);
        if (lightenBy > 0) {
          ctx.fillStyle = `rgba(255,255,255,${lightenBy / 100})`;
          ctx.fillRect(x, y, w, h);
        }
        ctx.restore();
      };
      img.src = gradientUrl;
    } else {
      const grd = ctx.createLinearGradient(x, y, x + w, y + h);
      grd.addColorStop(0, '#3a4050');
      grd.addColorStop(1, '#181c22');
      ctx.fillStyle = grd;
      ctx.fillRect(x, y, w, h);
    }

    if (lightenBy > 0) {
      ctx.fillStyle = `rgba(255,255,255,${lightenBy / 100})`;
      ctx.fillRect(x, y, w, h);
    }

    ctx.restore();
  }

  onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.deltaY < 0) this.canvasSvc.zoomIn();
    else this.canvasSvc.zoomOut();
  }

  onMouseDown(e: MouseEvent): void {
    if (e.button === 0 || e.button === 1) {
      this.dragging = true;
      this.dragLast = { x: e.clientX, y: e.clientY };
    }
  }

  onMouseMove(e: MouseEvent): void {
    if (this.dragging) {
      const dx = e.clientX - this.dragLast.x;
      const dy = e.clientY - this.dragLast.y;
      this.dragLast = { x: e.clientX, y: e.clientY };
      this.canvasSvc.applyPanDelta(dx, dy);
    }
    if (this.dividerDragging) {
      const rect = this.wrapRef.nativeElement.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      this.canvasSvc.setSplit(frac);
    }
  }

  onMouseUp(): void {
    this.dragging = false;
    this.dividerDragging = false;
  }

  onDividerDrag(e: MouseEvent): void {
    e.stopPropagation();
    this.dividerDragging = true;
    this.dragLast = { x: e.clientX, y: e.clientY };
  }
}
