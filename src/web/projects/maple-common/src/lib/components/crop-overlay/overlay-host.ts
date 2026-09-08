// overlay-host.ts — the bits every canvas overlay needs (#1541): the host's
// live size, the focused asset's dimensions, pointer → host-local
// coordinates, and (#3409) the placement those three imply — the applied
// crop, the fit footprint and the full-frame ↔ screen map. Shared by
// `CropOverlayComponent`, `MaskOverlayComponent` and
// `RetouchOverlayComponent` so the overlays can't drift on how they measure
// the canvas wrap or where they think the image is.

import { computed, signal, type Signal, type WritableSignal } from '@angular/core';
import type { LibraryStateService } from '../../state/library-state.service';
import { defaultCrop, type Crop } from '../../models/adjustment-model';
import { fitFootprint, type Footprint } from './crop-geometry';
import { makeMaskCanvasMap, type MaskCanvasMap } from '../mask-overlay/mask-geometry';

/** Seed `wrapW`/`wrapH` from `el` and keep them in step with its content box.
 *  The caller disconnects the returned observer on destroy. */
export function observeHostSize(
  el: HTMLElement,
  wrapW: WritableSignal<number>,
  wrapH: WritableSignal<number>,
): ResizeObserver {
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      wrapW.set(e.contentRect.width);
      wrapH.set(e.contentRect.height);
    }
  });
  ro.observe(el);
  wrapW.set(el.clientWidth);
  wrapH.set(el.clientHeight);
  return ro;
}

/** Focused asset's native (display-oriented) dimensions. Falls back to a
 *  3:2 frame before the decode publishes real dims. */
export function focusedImageDims(
  library: Pick<LibraryStateService, 'focusedAsset'>,
): Signal<{ w: number; h: number }> {
  return computed(() => {
    const a = library.focusedAsset();
    return { w: a?.width ?? 6240, h: a?.height ?? 4160 };
  });
}

/** A pointer event's position in `el`'s own coordinate space (CSS px). */
export function hostLocalPoint(el: HTMLElement, ev: PointerEvent): { px: number; py: number } {
  const r = el.getBoundingClientRect();
  return { px: ev.clientX - r.left, py: ev.clientY - r.top };
}

/** The library surface a canvas overlay reads to place itself. */
type OverlayLibrary = Pick<LibraryStateService, 'focusedAsset' | 'adjustmentFor'>;

/**
 * A canvas overlay's placement over the painted image: the host's live size,
 * the focused asset's applied crop, the fit footprint of the DISPLAYED
 * (cropped) image, and the map that turns a full-frame normalised point into
 * a position inside that footprint.
 *
 * Owns the `ResizeObserver` too, so a component's whole geometry story is
 * `observe()` in `ngAfterViewInit` and `destroy()` in `ngOnDestroy`. Every
 * member is a signal, so the component exposes them to its template
 * directly rather than re-wrapping them.
 *
 * Constructed as a field initializer: `computed()` needs no injection
 * context (only `effect()` does), so this is safe outside one.
 */
export class OverlayPlacement {
  readonly wrapW = signal(0);
  readonly wrapH = signal(0);

  /** The focused asset's applied crop, or the identity when there is none. */
  readonly crop: Signal<Crop>;
  /** The fit rect of the displayed image inside the host, in CSS px. */
  readonly footprint: Signal<Footprint>;
  /** Full-frame normalised ↔ screen, with the crop and straighten folded in. */
  readonly map: Signal<MaskCanvasMap>;

  private ro?: ResizeObserver;

  constructor(
    private readonly hostEl: () => HTMLElement,
    library: OverlayLibrary,
  ) {
    const imgDims = focusedImageDims(library);
    this.crop = computed(() => {
      const a = library.focusedAsset();
      return a ? library.adjustmentFor(a.id)().crop : defaultCrop();
    });
    // Displayed (cropped) image dimensions — the extent the canvas fits.
    const displayDims = computed(() => {
      const { w, h } = imgDims();
      const c = this.crop();
      const cw = (c.right - c.left) * w;
      const ch = (c.bottom - c.top) * h;
      return cw > 0 && ch > 0 ? { w: cw, h: ch } : { w, h };
    });
    this.footprint = computed(() => {
      const { w, h } = displayDims();
      return fitFootprint(this.wrapW(), this.wrapH(), w, h);
    });
    this.map = computed(() => {
      const { w, h } = imgDims();
      return makeMaskCanvasMap(this.footprint(), this.crop(), w, h);
    });
  }

  /** Start tracking the host's size. Call from `ngAfterViewInit`. */
  observe(): void {
    this.ro = observeHostSize(this.hostEl(), this.wrapW, this.wrapH);
  }

  /** Stop tracking it. Call from `ngOnDestroy`. */
  destroy(): void {
    this.ro?.disconnect();
  }

  /** A pointer event's position in the host's own coordinate space (CSS px). */
  localPoint(ev: PointerEvent): { px: number; py: number } {
    return hostLocalPoint(this.hostEl(), ev);
  }
}

/** The session surface a canvas overlay's drag lifecycle drives. */
interface GestureSession {
  endGesture(): void;
}

/**
 * One canvas overlay drag, from press to release. `T` is whatever the
 * overlay needs to remember for the duration — which handle was grabbed, the
 * shape as it was when the press landed, where in the image the press was —
 * and is the only part that differs between overlays; the lifecycle around
 * it (take the pointer, stop the canvas panning, close the session's gesture
 * on release so the undo boundary lands exactly once) is the same for all of
 * them and lives here.
 */
export class OverlayDrag<T> {
  private state: T | null = null;

  /** The in-flight drag, or null when the pointer is not down. */
  get active(): T | null {
    return this.state;
  }

  /**
   * Take the pointer: capture it on the event's target so the gesture
   * survives the pointer leaving the element, and stop the canvas seeing it
   * as a pan.
   */
  begin(ev: PointerEvent, state: T): void {
    this.state = state;
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  }

  /**
   * End it: close the session's gesture — which is the undo boundary — and
   * give the pointer back. A no-op when no drag was in flight, so a stray
   * `pointerup` or `pointercancel` cannot close a boundary that was never
   * opened.
   */
  end(ev: PointerEvent, session: GestureSession): void {
    if (!this.state) return;
    this.state = null;
    session.endGesture();
    (ev.target as Element).releasePointerCapture?.(ev.pointerId);
  }
}
