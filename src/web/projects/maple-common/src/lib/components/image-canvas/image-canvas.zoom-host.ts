// ImageCanvasZoomHost — wires `CanvasZoomGestures` (the pointer/wheel/keyboard
// state machine in `image-canvas.zoom-gestures.ts`) into the component: the
// CSS-scale zoom view, the zoom-percent badge, and the divider/keyboard
// entry points the template and `@HostListener` call through. Extracted from
// `ImageCanvasComponent` to keep it under the file-size budget — pure
// relocation, no behavior change (#2683 headroom fix, tools/check-budget-
// headroom.sh's #2311).

import { computed, effect, type ElementRef, type Signal } from '@angular/core';
import { CanvasZoomGestures } from './image-canvas.zoom-gestures';
import type { LibraryStateService } from '../../state/library-state.service';
import type { ImageCanvasService } from './image-canvas.service';

/** The slice of `ImageCanvasComponent` the zoom host reaches back into. */
export interface ZoomHostHost {
  readonly canvasSvc: ImageCanvasService;
  readonly state: LibraryStateService;
  readonly wrapRef: ElementRef<HTMLElement>;
  readonly wrapW: Signal<number>;
  readonly wrapH: Signal<number>;
}

export class ImageCanvasZoomHost {
  // ── Continuous zoom (#1100, docs/zoom.md): pixelScale = REAL px per image
  // px (0 = fit, 1 = 100%, cap 8); the geometry helpers work in CSS scale.
  readonly dpr = (): number => (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

  /** CSS-scale view of the zoom for the draw/refine geometry ('fit' | cssScale). */
  readonly cssZoom = computed<'fit' | number>(() => {
    const ps = this.host.canvasSvc.pixelScale();
    return ps === 0 ? 'fit' : ps / this.dpr();
  });

  // Pointer/wheel/keyboard gesture controller (#1100) — state machine, math,
  // and DOM wiring live in `image-canvas.zoom-gestures.ts`; this host closure
  // supplies geometry. The component's template binds the toolbar to it.
  readonly gestures: CanvasZoomGestures;

  // Zoom badge (#1100): percent of the EFFECTIVE real scale, always visible.
  readonly zoomLabel: Signal<string>;

  constructor(private readonly host: ZoomHostHost) {
    this.gestures = new CanvasZoomGestures({
      wrapSize: () => ({ w: this.host.wrapW(), h: this.host.wrapH() }),
      wrapRect: () => this.host.wrapRef?.nativeElement?.getBoundingClientRect() ?? null,
      nativeSize: () => {
        const n = this.host.canvasSvc.nativeDimensions();
        if (n) return { w: n.w, h: n.h };
        const a = this.host.state.focusedAsset();
        return a?.width && a?.height ? { w: a.width, h: a.height } : null;
      },
      devicePixelRatio: () => this.dpr(),
      pixelScale: () => this.host.canvasSvc.pixelScale(),
      pan: () => this.host.canvasSvc.pan(),
      commitView: (pixelScale, pan) => this.commitView(pixelScale, pan),
      moveDivider: (clientX) => {
        const rect = this.host.wrapRef.nativeElement.getBoundingClientRect();
        this.host.canvasSvc.setSplit((clientX - rect.left) / rect.width);
      },
    });
    this.zoomLabel = computed(() => this.gestures.zoomPercent());
    // Keyboard ⌘= / ⌘- (#2450): the shell's command router posts a bounded
    // step request; only this host has the geometry to answer it. `seq`
    // guards against re-running for a request already answered.
    let answered = 0;
    effect(() => {
      const request = this.host.canvasSvc.stepZoomRequest();
      if (request.seq === 0 || request.seq === answered) return;
      answered = request.seq;
      this.gestures.stepZoom(request.direction);
    });
  }

  /**
   * Commit a view from the gesture controller (#1100): pixelScale (0 = fit)
   * + pan. The controller already clamped the pan against the geometry.
   */
  private commitView(pixelScale: number, pan: { x: number; y: number }): void {
    if (pixelScale === 0) {
      this.host.canvasSvc.zoomToFit();
      return;
    }
    this.host.canvasSvc.setPixelScale(pixelScale);
    this.host.canvasSvc.pan.set(pan);
  }

  /** Cmd/Ctrl+0 → fit, Cmd/Ctrl+1 → 100% (bare 0/1 stay S5 tool/rating keys). */
  onKeydown(e: KeyboardEvent): void {
    this.gestures.onKeydown(e, !!this.host.state.focusedAsset());
  }

  onDividerDrag(e: PointerEvent): void {
    this.gestures.onDividerDown(e, this.host.wrapRef.nativeElement);
  }
}
