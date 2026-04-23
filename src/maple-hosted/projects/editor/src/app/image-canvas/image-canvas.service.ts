// ImageCanvasService — pan/zoom/before-after state signals + decoded pixel data for scopes.

import { Injectable, signal, computed } from '@angular/core';
import type { DecodedImage } from '@maple-common';

export type ZoomLevel = 0.25 | 0.5 | 1 | 2 | 4 | 'fit';

@Injectable({ providedIn: 'root' })
export class ImageCanvasService {
  readonly zoom              = signal<ZoomLevel>('fit');
  readonly pan               = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly beforeAfterSplitX = signal<number | null>(null);

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

  resetView(): void {
    this.zoom.set('fit');
    this.pan.set({ x: 0, y: 0 });
  }

  zoomIn(): void {
    const order: ZoomLevel[] = [0.25, 0.5, 1, 2, 4];
    const cur = this.zoom();
    if (cur === 'fit') { this.zoom.set(1); return; }
    const idx = order.indexOf(cur as ZoomLevel);
    if (idx < order.length - 1) this.zoom.set(order[idx + 1]);
  }

  zoomOut(): void {
    const order: ZoomLevel[] = [0.25, 0.5, 1, 2, 4];
    const cur = this.zoom();
    if (cur === 'fit') return;
    const idx = order.indexOf(cur as ZoomLevel);
    if (idx > 0) this.zoom.set(order[idx - 1]);
    else this.zoom.set('fit');
  }

  applyPanDelta(dx: number, dy: number): void {
    this.pan.update(p => ({ x: p.x + dx, y: p.y + dy }));
  }
}
