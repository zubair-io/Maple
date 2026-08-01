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

  readonly showBeforeAfter = computed(() => this.beforeAfterSplitX() !== null);

  toggleBeforeAfter(): void {
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

  applyPanDelta(dx: number, dy: number): void {
    this.pan.update((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
}
