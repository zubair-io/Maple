// ImageCanvasService — pan/zoom/before-after state signals + decoded pixel data for scopes.

import { Injectable, signal, computed } from '@angular/core';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import { MAX_PIXEL_SCALE } from './image-canvas.zoom-gestures';

@Injectable({ providedIn: 'root' })
export class ImageCanvasService {
  /**
   * Continuous zoom as REAL screen pixels per image pixel (#1100,
   * docs/zoom.md): `0` = fit (auto-computed from viewport/native),
   * `1.0` = true 100% (1 image px = 1 device px — dpr-aware, pixel-perfect
   * on retina), capped at 8.0. Replaces the stepped `ZoomLevel`.
   */
  readonly pixelScale = signal<number>(0);
  readonly pan = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly beforeAfterSplitX = signal<number | null>(null);

  /** Native, display-oriented image dimensions for geometry consumers such as
   * crop. Kept beside zoom/pan because the live renderer is the authoritative
   * producer; asset metadata may still be hydrating when its first frame lands. */
  readonly nativeDimensions = signal<{ w: number; h: number } | null>(null);

  /** Current decoded image pixels — set by ImageCanvasComponent on decode. */
  readonly currentPixels = signal<DecodedImage | null>(null);

  /**
   * Aspect of the bitmap currently painted, or `null` before the first paint.
   * A cropped render is a different aspect than the source, so this — not the
   * asset's stored full-frame dims — is what the draw transform is sized from
   * (#638). Held here rather than in the component so the white-balance pick
   * overlay (#2434) can invert the same transform the canvas painted with.
   */
  readonly paintedAspect = signal<{ w: number; h: number } | null>(null);

  readonly showBeforeAfter = computed(() => this.beforeAfterSplitX() !== null);

  // ── Momentary before/after (#2450) ─────────────────────────────────────
  // A press-and-hold peek: the whole frame shows "before" while held, then
  // the split returns to exactly what it was (latched or off). Zoom and pan
  // are separate signals, so both modes preserve them by construction.
  private readonly _peeking = signal<boolean>(false);
  private peekRestore: number | null = null;

  /** True while a momentary peek holds the whole frame at "before". */
  readonly peekingBefore = computed(() => this._peeking());

  /** The latched split toggle's own state — a peek does not count. */
  readonly latchedBeforeAfter = computed(
    () => !this._peeking() && this.beforeAfterSplitX() !== null,
  );

  beginPeekBefore(): void {
    if (this._peeking()) return;
    this.peekRestore = this.beforeAfterSplitX();
    this._peeking.set(true);
    this.beforeAfterSplitX.set(1);
  }

  endPeekBefore(): void {
    if (!this._peeking()) return;
    this._peeking.set(false);
    this.beforeAfterSplitX.set(this.peekRestore);
    this.peekRestore = null;
  }

  // ── Bounded step zoom by request (#2450) ───────────────────────────────
  // The step needs the viewport/native geometry only `CanvasZoomGestures`
  // holds, so keyboard ⌘= / ⌘- post a request here and the zoom host
  // answers it — the same bounded, centre-anchored step the toolbar and the
  // wheel use.
  readonly stepZoomRequest = signal<{ readonly seq: number; readonly direction: 1 | -1 }>({
    seq: 0,
    direction: 1,
  });

  requestStepZoom(direction: 1 | -1): void {
    this.stepZoomRequest.update((r) => ({ seq: r.seq + 1, direction }));
  }

  toggleBeforeAfter(): void {
    if (this._peeking()) return;
    if (this.beforeAfterSplitX() !== null) {
      this.beforeAfterSplitX.set(null);
    } else {
      this.beforeAfterSplitX.set(0.5);
    }
  }

  setSplit(x: number): void {
    this.beforeAfterSplitX.set(Math.max(0.02, Math.min(0.98, x)));
  }

  /** Fit: pixelScale 0 + recentered pan (docs/zoom.md Fit button). */
  zoomToFit(): void {
    this.pixelScale.set(0);
    this.pan.set({ x: 0, y: 0 });
  }

  /** True 100% (pixel-perfect) + recentered pan (docs/zoom.md 100% button). */
  zoomTo100(): void {
    this.pixelScale.set(1);
    this.pan.set({ x: 0, y: 0 });
  }

  /**
   * Set a settled pixelScale, clamped to `[0, 8]`. `0` = fit. Snap-to-fit
   * and anchoring live in `CanvasZoomGestures` (they need viewport/native
   * geometry this service deliberately doesn't hold).
   */
  setPixelScale(v: number): void {
    this.pixelScale.set(Math.min(Math.max(v, 0), MAX_PIXEL_SCALE));
  }
}
