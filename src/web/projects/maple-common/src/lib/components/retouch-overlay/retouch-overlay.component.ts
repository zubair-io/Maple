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
import type { RetouchPoint, RetouchSpot } from '../../models/retouch-spot';
import { OverlayDrag, OverlayPlacement } from '../crop-overlay/overlay-host';
import { maskFromScreen } from '../mask-overlay/mask-geometry';
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

  private readonly drag = new OverlayDrag<DragState>();

  /** Host size, applied crop, fit footprint and the full-frame ↔ screen map
   *  — shared with every other canvas overlay (`overlay-host.ts`). */
  private readonly placement = new OverlayPlacement(() => this.host.nativeElement, this.library);
  protected readonly map = this.placement.map;

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
    this.placement.observe();
  }

  ngOnDestroy(): void {
    this.placement.destroy();
  }

  // ── Pointer interaction ────────────────────────────────────────────────

  protected onPointerDown(ev: PointerEvent): void {
    const point = this.imagePoint(ev);
    const hit = this.hitTest(point);
    if (hit) {
      this.session.select(hit.index);
      this.drag.begin(ev, {
        handle: hit.handle,
        startSpot: this.session.spots()[hit.index],
        anchor: point,
      });
      return;
    }
    // Empty canvas: place a new spot and immediately begin dragging its
    // source, so one press-drag-release both places and aims the repair.
    const placed = this.session.spots()[this.session.place(point)];
    this.drag.begin(ev, { handle: 'source', startSpot: placed, anchor: placed.source });
  }

  protected onPointerMove(ev: PointerEvent): void {
    const drag = this.drag.active;
    if (!drag) {
      this.onHover(ev);
      return;
    }
    this.session.setShape(
      dragRetouchHandle(drag.startSpot, drag.handle, this.imagePoint(ev), drag.anchor),
    );
    ev.preventDefault();
  }

  protected onPointerUp(ev: PointerEvent): void {
    this.drag.end(ev, this.session);
  }

  private onHover(ev: PointerEvent): void {
    this.cursor.set(this.hitTest(this.imagePoint(ev)) === null ? 'crosshair' : 'move');
  }

  /**
   * The topmost spot and handle under the normalised point `p`, or null.
   * The selected spot is tested first because only it draws a source disc;
   * the rest are tested back to front, so a spot placed on top of another is
   * the one you grab.
   */
  private hitTest(p: RetouchPoint): { index: number; handle: RetouchHandle } | null {
    const map = this.map();
    const spots = this.session.spots();
    const selectedIndex = this.session.selectedIndex();
    const screen = retouchPointToScreen(map, p);
    const selected = selectedIndex === null ? undefined : spots[selectedIndex];
    if (selected && selectedIndex !== null) {
      const handle = hitTestRetouchHandle(screen.x, screen.y, selected, map, HANDLE_TOLERANCE);
      if (handle) return { index: selectedIndex, handle };
    }
    for (let i = spots.length - 1; i >= 0; i--) {
      if (i === selectedIndex) continue;
      const centre = retouchPointToScreen(map, spots[i].center);
      const reach = Math.max(HANDLE_TOLERANCE, retouchRadiusPx(map, spots[i]));
      if (Math.hypot(screen.x - centre.x, screen.y - centre.y) <= reach) {
        return { index: i, handle: 'destination' };
      }
    }
    return null;
  }

  /** The pointer's position in full-frame normalised coordinates. */
  private imagePoint(ev: PointerEvent): RetouchPoint {
    const { px, py } = this.placement.localPoint(ev);
    return maskFromScreen(this.placement.map(), px, py);
  }
}
