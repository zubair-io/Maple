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
} from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { imageDataToBitmap } from '../../raw-pipeline/image-utils';
import { ImageCanvasService } from './image-canvas.service';
import { AssetId } from '../../models/asset';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';

@Component({
  selector: 'editor-image-canvas',
  standalone: true,
  templateUrl: './image-canvas.component.html',
  styleUrl: './image-canvas.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageCanvasComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('wrap') wrapRef!: ElementRef<HTMLElement>;

  state = inject(LibraryStateService);
  canvasSvc = inject(ImageCanvasService);
  pipeline = inject(RawPipelineService);
  private readonly xmpSerializer = inject(XmpSerializerService);
  private readonly injector = inject(Injector);

  readonly loading = signal(false);
  readonly imageBitmap = signal<ImageBitmap | null>(null);

  private ro?: ResizeObserver;
  private wrapW = signal<number>(800);
  private wrapH = signal<number>(600);
  private dragging = false;
  private dragLast = { x: 0, y: 0 };
  private dividerDragging = false;
  private cleanupDecodeEffect?: () => void;
  private cleanupRerenderEffect?: () => void;
  private cleanupDrawEffect?: () => void;
  private currentAssetId: AssetId | null = null;

  // ── Re-render the live canvas on adjustment change (#846) ────────────────
  // The live canvas re-renders through the same WASM `render_bytes` path that
  // raw-core / maple-cli use, so every edit (Profile toggle, sliders) is
  // correctness-complete by construction (web == the Rust reference).
  //
  // To avoid storming the single-threaded decode worker on a slider drag, edits
  // drive a trailing-edge debounce: the actual full-resolution decode fires
  // ~150ms after edits settle. `render_bytes` runs to completion behind the
  // service's decode-serialization gate (it can't be interrupted mid-flight),
  // so a monotonic generation counter "cancels" a superseded decode by dropping
  // its stale result rather than letting it overwrite a newer bitmap.
  //
  // A reduced-resolution fast phase (half-res Preview decode for immediate
  // slider feedback) is intentionally deferred: the live WASM re-decode is the
  // correctness-first path, and slider drags won't hit the 16ms budget until
  // the separate scene-linear GPU migration lands (#321 Phase 2). A half-res
  // fast pass would need a new reduced-res sRGB WASM export, which is perf work
  // out of scope per #846. Tracked there as the two-phase / 16ms follow-up.
  private static readonly REFINE_DEBOUNCE_MS = 150;
  // Bytes + extension for the focused asset, retained so adjustment-driven
  // re-renders don't re-read from the byte cache. `decode()` slices a copy of
  // the buffer before transferring it into the worker, so the original view
  // here is never detached — repeated decodes are safe.
  private currentBytes: Uint8Array | null = null;
  private currentExt = '';
  private renderGeneration = 0;
  private refineTimer: ReturnType<typeof setTimeout> | null = null;
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
  // changes the serialized XMP and passes the dedup.
  private lastRenderedXmp: string | null = null;

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
        this.currentBytes = null;
        this.currentExt = '';
        this.lastRenderedXmp = null;
        this.coldOpenDone = false;

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
        this.draw();
      },
      { injector: this.injector },
    );
    this.cleanupDrawEffect = () => drawEff.destroy();
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.cleanupDecodeEffect?.();
    this.cleanupRerenderEffect?.();
    this.cleanupDrawEffect?.();
    this.clearRerenderTimers();
    // Invalidate any in-flight re-render so a late decode can't touch a
    // destroyed component's signals.
    this.renderGeneration++;
    this.imageBitmap()?.close();
  }

  private async loadReal(assetId: AssetId, filename: string, bytes: Uint8Array): Promise<void> {
    this.loading.set(true);
    // Bracket the whole click → pixels path. `maple:open` is the outer
    // measure; `maple:decode` (service) and `maple:wasm` (worker) are nested
    // sub-intervals. View in DevTools → Performance → User Timings.
    performance.mark(`maple:open:${assetId}:start`);
    try {
      const ext = filename.split('.').pop()?.toLowerCase() ?? '';
      // Retain bytes + ext for adjustment-driven re-renders (no XMP on this
      // cold-open decode — raw-core substitutes the camera As-Shot WB).
      this.currentBytes = bytes;
      this.currentExt = ext;
      const decoded = await this.pipeline.decode(bytes, ext);

      // Update dimensions on the asset.
      this.state.updateAssetDimensions(assetId, decoded.width, decoded.height);

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
      performance.mark(`maple:open:${assetId}:paint`);
      performance.measure(
        `maple:open`,
        `maple:open:${assetId}:start`,
        `maple:open:${assetId}:paint`,
      );
    } catch (e) {
      console.error('Decode failed for', filename, e);
      this.imageBitmap.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Schedule a debounced re-render for the current adjustment model. Called
   * from the adjustment effect on every model change; trailing-edge debounced
   * so a slider drag doesn't enqueue a full-res decode per tick — exactly one
   * full-res decode fires once edits settle.
   */
  private scheduleRerender(xmp: string): void {
    // Bump the generation so any decode already in flight (from an earlier
    // edit) drops its result instead of painting stale pixels.
    this.renderGeneration++;
    const generation = this.renderGeneration;
    if (this.refineTimer) clearTimeout(this.refineTimer);
    this.refineTimer = setTimeout(() => {
      this.refineTimer = null;
      void this.runRender(xmp, generation);
    }, ImageCanvasComponent.REFINE_DEBOUNCE_MS);
  }

  private clearRerenderTimers(): void {
    if (this.refineTimer) {
      clearTimeout(this.refineTimer);
      this.refineTimer = null;
    }
  }

  /**
   * Decode the retained RAW bytes with the given XMP and publish the result —
   * but only if `generation` is still current when the decode returns. A
   * `render_bytes` call runs to completion behind the service's serialization
   * gate, so a newer edit can't interrupt an in-flight decode; the generation
   * guard instead drops the stale result so it never overwrites a fresher
   * bitmap.
   */
  private async runRender(xmp: string, generation: number): Promise<void> {
    const bytes = this.currentBytes;
    const ext = this.currentExt;
    if (!bytes) return;
    try {
      const decoded = await this.pipeline.decode(bytes, ext, xmp);
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
      this.lastRenderedXmp = xmp;
    } catch (e) {
      console.error('[image-canvas] adjustment re-render failed:', e);
    }
  }

  private draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const { canvasW, canvasH } = this.effectivePx();
    canvas.width = canvasW;
    canvas.height = canvasH;

    const pan = this.canvasSvc.pan();
    canvas.style.transform = `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const asset = this.state.focusedAsset();
    const bitmap = this.imageBitmap();
    const split = this.canvasSvc.beforeAfterSplitX();

    if (bitmap) {
      // Real decoded pixels.
      if (split !== null) {
        const splitPx = Math.round(canvasW * split);
        // "Before" half.
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, splitPx, canvasH);
        ctx.clip();
        ctx.drawImage(bitmap, 0, 0, canvasW, canvasH);
        ctx.restore();
        // "After" half — same image for now (adjustments wired in P6).
        ctx.save();
        ctx.beginPath();
        ctx.rect(splitPx, 0, canvasW - splitPx, canvasH);
        ctx.clip();
        ctx.drawImage(bitmap, 0, 0, canvasW, canvasH);
        // Slight brightness bump to indicate "after processed".
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(splitPx, 0, canvasW - splitPx, canvasH);
        ctx.restore();
      } else {
        ctx.drawImage(bitmap, 0, 0, canvasW, canvasH);
      }
    } else {
      // Gradient placeholder for mock assets.
      if (split !== null) {
        const splitPx = Math.round(canvasW * split);
        this.drawGradient(ctx, asset?.thumbnailGradient, 0, 0, splitPx, canvasH, 0);
        this.drawGradient(
          ctx,
          asset?.thumbnailGradient,
          splitPx,
          0,
          canvasW - splitPx,
          canvasH,
          15,
        );
      } else {
        this.drawGradient(ctx, asset?.thumbnailGradient, 0, 0, canvasW, canvasH, 0);
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
