// WbPickOverlayComponent — the click target for the white-balance eyedropper
// (#2434). Rendered over the canvas only while `WbPickService` is armed, so
// the canvas's own pan/zoom gestures are untouched the rest of the time.
//
// It sits `inset-0` inside the canvas wrap, so its own bounding rect IS the
// viewport rect the draw transform is centred in; `normalisedImagePoint`
// inverts that transform to the point the sampler takes. A click on the
// letterbox (outside the painted image) cancels rather than sampling a pixel
// that isn't there.

import { ChangeDetectionStrategy, Component, ElementRef, inject } from '@angular/core';
import { ImageCanvasService } from './image-canvas.service';
import { WbPickService } from './wb-pick.service';
import { normalisedImagePoint } from './image-canvas.wb-pick';
import { computeEffectivePx } from './image-canvas.draw2d';
import { displayDims } from './image-canvas.crop';
import { LibraryStateService } from '../../state/library-state.service';

@Component({
  selector: 'editor-wb-pick-overlay',
  standalone: true,
  templateUrl: './wb-pick-overlay.component.html',
  // The host fills the canvas wrap so its own rect IS the viewport rect the
  // draw transform centres in; it stays click-through until the pick arms.
  host: { class: 'absolute inset-0 pointer-events-none' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WbPickOverlayComponent {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly canvasSvc = inject(ImageCanvasService);
  private readonly state = inject(LibraryStateService);
  protected readonly pick = inject(WbPickService);

  /** Sample the clicked point, or cancel when the click misses the image. */
  protected onClick(e: MouseEvent): void {
    const point = this.pointFor(e);
    if (!point) {
      this.pick.cancel();
      return;
    }
    this.pick.resolve(point);
  }

  /** Escape leaves pick mode without sampling. */
  protected onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    this.pick.cancel();
  }

  /**
   * The normalised image point under the pointer, derived from the SAME
   * geometry `ImageCanvasComponent` paints with: the overlay fills the wrap,
   * so its rect supplies the viewport, and the displayed image size comes
   * from the zoom and the asset's display-oriented dims.
   */
  private pointFor(e: MouseEvent) {
    const rect = (this.host.nativeElement as HTMLElement).getBoundingClientRect();
    const asset = this.state.focusedAsset();
    // Same inputs as `ImageCanvasComponent`'s own `effectivePx`: the PAINTED
    // aspect first (a cropped render is a different aspect than the source),
    // the asset's stored dims before the first paint.
    const { w, h } = displayDims(this.canvasSvc.paintedAspect(), asset?.width, asset?.height);
    const scale = this.canvasSvc.pixelScale();
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const { canvasW, canvasH } = computeEffectivePx(
      scale === 0 ? 'fit' : scale / dpr,
      w,
      h,
      rect.width,
      rect.height,
    );
    return normalisedImagePoint(e.clientX - rect.left, e.clientY - rect.top, {
      wrapW: rect.width,
      wrapH: rect.height,
      canvasW,
      canvasH,
      pan: this.canvasSvc.pan(),
    });
  }
}
