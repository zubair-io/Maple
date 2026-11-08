// ImageCanvasZoomHost — wires `CanvasZoomGestures` (gesture recognition over
// the shared Rust zoom model, `image-canvas.zoom-gestures.ts`) into the
// component: the CSS-scale zoom view, the zoom badge, and the divider/keyboard
// entry points the template and `@HostListener` call through. Kept apart from
// `ImageCanvasComponent` for its file-size budget (#2683, #2311).

import { computed, effect, untracked, type ElementRef, type Signal } from '@angular/core';
import { CanvasZoomGestures } from './image-canvas.zoom-gestures';
import { canvasZoomModule, loadCanvasZoomWasm } from './image-canvas.zoom-wasm';
import type { LibraryStateService } from '../../state/library-state.service';
import type { ImageCanvasService } from './image-canvas.service';

/** The slice of `ImageCanvasComponent` the zoom host reaches back into. */
export interface ZoomHostHost {
  readonly canvasSvc: ImageCanvasService;
  readonly state: LibraryStateService;
  readonly wrapRef: ElementRef<HTMLElement>;
  readonly wrapW: Signal<number>;
  readonly wrapH: Signal<number>;
  /** The extent the draw sizes the photo by; the model must size by the same one. */
  readonly imageExtent: Signal<{ w: number; h: number } | null>;
}

export class ImageCanvasZoomHost {
  // pixelScale = REAL px per image px (0 = fit, 1 = 100%, cap 8 or fit/fill if larger, docs/zoom.md);
  // the draw/refine geometry works in CSS scale.
  readonly dpr = (): number => (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

  /** CSS-scale view of the zoom for the draw/refine geometry ('fit' | cssScale). */
  readonly cssZoom = computed<'fit' | number>(() => {
    const ps = this.host.canvasSvc.pixelScale();
    return ps === 0 ? 'fit' : ps / this.dpr();
  });

  readonly gestures: CanvasZoomGestures;

  /** Zoom badge: percent of the EFFECTIVE real scale, always visible. */
  readonly zoomLabel: Signal<string>;

  /** The badge's accessible name: the stop a click moves to. */
  readonly zoomBadgeAction: Signal<string>;

  private readonly nativeSize = (): { w: number; h: number } | null => this.host.imageExtent();

  constructor(private readonly host: ZoomHostHost) {
    void loadCanvasZoomWasm();
    this.gestures = new CanvasZoomGestures({
      wrapSize: () => ({ w: this.host.wrapW(), h: this.host.wrapH() }),
      wrapRect: () => this.host.wrapRef?.nativeElement?.getBoundingClientRect() ?? null,
      nativeSize: () => this.nativeSize(),
      devicePixelRatio: () => this.dpr(),
      pixelScale: () => this.host.canvasSvc.pixelScale(),
      pan: () => this.host.canvasSvc.pan(),
      commitView: (pixelScale, pan) => {
        this.host.canvasSvc.pixelScale.set(pixelScale);
        this.host.canvasSvc.pan.set(pan);
      },
      moveDivider: (clientX) => {
        const rect = this.host.wrapRef.nativeElement.getBoundingClientRect();
        this.host.canvasSvc.setSplit((clientX - rect.left) / rect.width);
      },
    });
    this.zoomLabel = computed(() => this.gestures.zoomPercent());
    this.zoomBadgeAction = computed(() => {
      const next = this.gestures.nextBadgeStop();
      const stops = canvasZoomModule()?.glue.CanvasZoomStop;
      if (next === stops?.Fill) return 'Zoom to fill';
      if (next === stops?.ActualSize) return 'Zoom to 100%';
      return 'Zoom to fit';
    });
    // Fill follows the viewport and the pan stays legal when the wrap
    // resizes or the native size lands (the model's reclamp rule).
    effect(() => {
      this.host.wrapW();
      this.host.wrapH();
      this.nativeSize();
      if (!canvasZoomModule()) return;
      untracked(() => this.gestures.reclamp());
    });
    effect(() => this.host.canvasSvc.pointerEditsAtZoom.set(this.gestures.pointerEditsAtZoom()));
    // Keyboard ⌘= / ⌘- (#2450): the shell's command router posts a bounded
    // step request; only this host has the geometry to answer it. `seq`
    // guards against re-running for a request already answered.
    let answered = 0;
    effect(() => {
      const request = this.host.canvasSvc.stepZoomRequest();
      if (request.seq === 0 || request.seq === answered) return;
      answered = request.seq;
      untracked(() => this.gestures.stepZoom(request.direction));
    });
  }

  /** Cmd/Ctrl+0 → fit, Cmd/Ctrl+1 → 100% (bare 0/1 stay S5 tool/rating keys). */
  onKeydown(e: KeyboardEvent): void {
    this.gestures.onKeydown(e, !!this.host.state.focusedAsset());
  }

  onDividerDrag(e: PointerEvent): void {
    this.gestures.onDividerDown(e, this.host.wrapRef.nativeElement);
  }
}
