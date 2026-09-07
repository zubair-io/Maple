// retouch-overlay.component.ts — the clone / heal brush canvas overlay
// (#3409), the repair sibling of `MaskOverlayComponent`.
//
// Renders over the live canvas while the Heal tool is armed. Every spot is
// drawn as its destination disc; the SELECTED spot additionally shows its
// source disc and a line joining the two, which is Lightroom's own reading
// of "these pixels came from there". A click on empty canvas places a spot
// with the panel's current brush; dragging the destination carries the source
// with it, dragging the source moves it alone. Each gesture is one
// `repair`-class `EditTransaction`, whose invalidation scope is `decode`.
//
// Geometry is shared with the mask tool (`MaskCanvasMap` folds the applied
// crop and straighten in); the spot-specific math is `retouch-geometry.ts`.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { RetouchSessionService } from './retouch-session.service';
import { defaultCrop } from '../../models/adjustment-model';
import type { RetouchPoint, RetouchSpot } from '../../models/retouch-spot';
import { fitFootprint, type Footprint } from '../crop-overlay/crop-geometry';
import { focusedImageDims, hostLocalPoint, observeHostSize } from '../crop-overlay/overlay-host';
import {
  type MaskCanvasMap,
  makeMaskCanvasMap,
  maskFromScreen,
} from '../mask-overlay/mask-geometry';
import {
  RETOUCH_HANDLE_NAME,
  type RetouchHandle,
  dragRetouchHandle,
  hitTestRetouchHandle,
  retouchPointToScreen,
  retouchRadiusPx,
} from './retouch-geometry';

/** Grab slack beyond the disc itself, in CSS px — matches the mask overlay. */
const HANDLE_TOLERANCE = 14;

interface DragState {
  handle: RetouchHandle;
  startSpot: RetouchSpot;
  anchor: RetouchPoint;
  /** True once the pointer actually moved: a press that never moves is a
   *  selection, not a drag, and must not open an undo boundary. */
  moved: boolean;
}

interface DiscView {
  index: number;
  x: number;
  y: number;
  r: number;
  selected: boolean;
  label: string;
}

@Component({
  selector: 'editor-retouch-overlay',
  standalone: true,
  templateUrl: './retouch-overlay.component.html',
  styleUrl: './retouch-overlay.component.scss',
  host: {
    class: 'absolute inset-0 z-[8] [touch-action:none]',
    // Always mounted by the canvas; hidden (and out of the pointer stream)
    // unless the Heal tool is armed.
    '[class.hidden]': '!session.active()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RetouchOverlayComponent implements AfterViewInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly library = inject(LibraryStateService);
  private readonly canvasSvc = inject(ImageCanvasService);
  protected readonly session = inject(RetouchSessionService);

  private readonly wrapW = signal(0);
  private readonly wrapH = signal(0);
  private ro?: ResizeObserver;
  private drag: DragState | null = null;

  private readonly imgDims = focusedImageDims(this.library);

  private readonly crop = computed(() => {
    const a = this.library.focusedAsset();
    return a ? this.library.adjustmentFor(a.id)().crop : defaultCrop();
  });

  /** Displayed (cropped) image dimensions — the extent the canvas fits. */
  private readonly displayDims = computed(() => {
    const { w, h } = this.imgDims();
    const c = this.crop();
    const cw = (c.right - c.left) * w;
    const ch = (c.bottom - c.top) * h;
    return cw > 0 && ch > 0 ? { w: cw, h: ch } : { w, h };
  });

  protected readonly footprint = computed<Footprint>(() => {
    const { w, h } = this.displayDims();
    return fitFootprint(this.wrapW(), this.wrapH(), w, h);
  });

  protected readonly map = computed<MaskCanvasMap>(() => {
    const { w, h } = this.imgDims();
    return makeMaskCanvasMap(this.footprint(), this.crop(), w, h);
  });

  /** Every spot's destination disc, in screen space. */
  protected readonly discs = computed<DiscView[]>(() => {
    const map = this.map();
    const selectedIndex = this.session.selectedIndex();
    return this.session.spots().map((spot, index) => {
      const s = retouchPointToScreen(map, spot.center);
      return {
        index,
        x: s.x,
        y: s.y,
        r: retouchRadiusPx(map, spot),
        selected: index === selectedIndex,
        label: `${spot.kind === 'clone' ? 'Clone' : 'Heal'} ${index + 1}`,
      };
    });
  });

  /** The selected spot's source disc, or null when nothing is selected. */
  protected readonly sourceDisc = computed<DiscView | null>(() => {
    const spot = this.session.selected();
    const index = this.session.selectedIndex();
    if (!spot || index === null) return null;
    const map = this.map();
    const s = retouchPointToScreen(map, spot.source);
    return {
      index,
      x: s.x,
      y: s.y,
      r: retouchRadiusPx(map, spot),
      selected: true,
      label: RETOUCH_HANDLE_NAME.source,
    };
  });

  /** The line joining the selected spot's source and destination. */
  protected readonly linkPath = computed<string>(() => {
    const spot = this.session.selected();
    if (!spot) return '';
    const map = this.map();
    const a = retouchPointToScreen(map, spot.source);
    const b = retouchPointToScreen(map, spot.center);
    return `M${a.x} ${a.y}L${b.x} ${b.y}`;
  });

  protected readonly description = computed<string>(() => {
    const count = this.session.spots().length;
    if (count === 0) return 'No repair spots — click the image to place one';
    const spot = this.session.selected();
    if (!spot) return `${count} repair spot${count === 1 ? '' : 's'}`;
    return `${spot.kind === 'clone' ? 'Clone' : 'Heal'} spot selected of ${count}`;
  });

  protected readonly cursor = signal<string>('crosshair');

  constructor() {
    // Repair editing is fit-zoom-only, like masking: the footprint maps 1:1
    // onto the painted image only at fit + zero pan.
    effect(() => {
      if (this.session.active()) this.canvasSvc.zoomToFit();
    });
  }

  ngAfterViewInit(): void {
    this.ro = observeHostSize(this.host.nativeElement, this.wrapW, this.wrapH);
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
  }

  // ── Pointer interaction ────────────────────────────────────────────────

  protected onPointerDown(ev: PointerEvent): void {
    const { px, py } = this.localPoint(ev);
    const point = maskFromScreen(this.map(), px, py);
    const hit = this.hitTest(px, py);
    if (hit) {
      this.session.select(hit.index);
      const spot = this.session.spots()[hit.index];
      this.drag = { handle: hit.handle, startSpot: spot, anchor: point, moved: false };
    } else {
      // Empty canvas: place a new spot and immediately begin dragging its
      // source, so one press-drag-release both places and aims the repair.
      const index = this.session.place(point);
      this.drag = {
        handle: 'source',
        startSpot: this.session.spots()[index],
        anchor: this.session.spots()[index].source,
        moved: false,
      };
    }
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  }

  protected onPointerMove(ev: PointerEvent): void {
    if (!this.drag) {
      this.onHover(ev);
      return;
    }
    const { px, py } = this.localPoint(ev);
    const point = maskFromScreen(this.map(), px, py);
    this.drag = { ...this.drag, moved: true };
    this.session.setShape(
      dragRetouchHandle(this.drag.startSpot, this.drag.handle, point, this.drag.anchor),
    );
    ev.preventDefault();
  }

  protected onPointerUp(ev: PointerEvent): void {
    if (!this.drag) return;
    this.drag = null;
    this.session.endGesture();
    (ev.target as Element).releasePointerCapture?.(ev.pointerId);
  }

  private onHover(ev: PointerEvent): void {
    const { px, py } = this.localPoint(ev);
    this.cursor.set(this.hitTest(px, py) === null ? 'crosshair' : 'move');
  }

  /** The topmost spot+handle under `(px, py)`; later spots win, matching the
   *  paint order (a spot placed on top of another is the one you grab). */
  private hitTest(px: number, py: number): { index: number; handle: RetouchHandle } | null {
    const map = this.map();
    const spots = this.session.spots();
    const selectedIndex = this.session.selectedIndex();
    // The selected spot is tested first, because only it draws a source disc.
    if (selectedIndex !== null && spots[selectedIndex]) {
      const handle = hitTestRetouchHandle(px, py, spots[selectedIndex], map, HANDLE_TOLERANCE);
      if (handle) return { index: selectedIndex, handle };
    }
    for (let i = spots.length - 1; i >= 0; i--) {
      if (i === selectedIndex) continue;
      const s = retouchPointToScreen(map, spots[i].center);
      const reach = Math.max(HANDLE_TOLERANCE, retouchRadiusPx(map, spots[i]));
      if (Math.hypot(px - s.x, py - s.y) <= reach) return { index: i, handle: 'destination' };
    }
    return null;
  }

  private localPoint(ev: PointerEvent): { px: number; py: number } {
    return hostLocalPoint(this.host.nativeElement, ev);
  }
}
