// crop-overlay.component.ts — interactive crop / straighten overlay (#638).
//
// Renders over the live canvas while the Crop tool is armed. The displayed
// image is shown UNCROPPED (the canvas strips the crop for the live render) and
// rotated by the straighten angle (a CSS transform on the canvas element); this
// overlay draws the axis-aligned crop rectangle, the rule-of-thirds grid, the
// darkened mask outside the crop, and the eight drag handles — matching the
// renderer's "rotate the frame, then cut an axis-aligned rect" model (spec
// § 3.12).
//
// Crop-rect edits are pure overlay math: dragging a handle mutates
// `model.crop` via `LibraryStateService.updateAdjustment`, which the canvas
// (rendering uncropped while armed) does NOT re-decode for — so a drag costs
// zero pipeline work. The cropped result renders once, when the tool disarms.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';

import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { CropSessionService } from './crop-session.service';
import { resolveAspect } from './crop-aspect';
import type { Crop } from '../../models/adjustment-model';
import { defaultCrop } from '../../models/adjustment-model';
import {
  type CropHandle,
  type Footprint,
  cropRectToPx,
  fitFootprint,
  hitTestHandle,
  moveCrop,
  pxToNormalized,
  resizeCrop,
} from './crop-geometry';

/** Grab radius for the handles, in CSS px. */
const HANDLE_TOLERANCE = 14;

interface DragState {
  handle: CropHandle;
  /** Crop at gesture start (for the `move` delta). */
  startCrop: Crop;
  /** Pointer at gesture start, normalized (for the `move` delta). */
  startNx: number;
  startNy: number;
}

@Component({
  selector: 'editor-crop-overlay',
  standalone: true,
  templateUrl: './crop-overlay.component.html',
  styleUrl: './crop-overlay.component.scss',
  host: { class: 'absolute inset-0 z-[8] [touch-action:none]' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CropOverlayComponent implements AfterViewInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly library = inject(LibraryStateService);
  private readonly editor = inject(EditorStateService);
  private readonly canvasSvc = inject(ImageCanvasService);
  private readonly crop = inject(CropSessionService);

  private readonly wrapW = signal(0);
  private readonly wrapH = signal(0);
  private ro?: ResizeObserver;
  private drag: DragState | null = null;

  /** Focused asset's native (display-oriented) dimensions. Falls back to a
   *  3:2 frame before the decode publishes real dims. */
  private readonly imgDims = computed(() => {
    const a = this.library.focusedAsset();
    return { w: a?.width ?? 6240, h: a?.height ?? 4160 };
  });

  /** The live crop rect from the focused asset's model. */
  private readonly model = computed(() => {
    const a = this.library.focusedAsset();
    return a ? this.library.adjustmentFor(a.id)() : null;
  });

  protected readonly cropRect = computed<Crop>(() => this.model()?.crop ?? defaultCrop());

  protected readonly footprint = computed<Footprint>(() => {
    const { w, h } = this.imgDims();
    return fitFootprint(this.wrapW(), this.wrapH(), w, h);
  });

  /** Screen-space crop rectangle (CSS px). */
  protected readonly rect = computed(() => cropRectToPx(this.cropRect(), this.footprint()));

  /** The four dark mask rectangles surrounding the crop box. */
  protected readonly maskRects = computed(() => {
    const r = this.rect();
    const W = this.wrapW();
    const H = this.wrapH();
    return [
      { x: 0, y: 0, w: W, h: Math.max(0, r.y) }, // top
      { x: 0, y: r.y + r.height, w: W, h: Math.max(0, H - (r.y + r.height)) }, // bottom
      { x: 0, y: r.y, w: Math.max(0, r.x), h: r.height }, // left
      { x: r.x + r.width, y: r.y, w: Math.max(0, W - (r.x + r.width)), h: r.height }, // right
    ];
  });

  /** Rule-of-thirds grid line endpoints inside the crop box. */
  protected readonly gridLines = computed(() => {
    const r = this.rect();
    const v1 = r.x + r.width / 3;
    const v2 = r.x + (2 * r.width) / 3;
    const h1 = r.y + r.height / 3;
    const h2 = r.y + (2 * r.height) / 3;
    return [
      { x1: v1, y1: r.y, x2: v1, y2: r.y + r.height },
      { x1: v2, y1: r.y, x2: v2, y2: r.y + r.height },
      { x1: r.x, y1: h1, x2: r.x + r.width, y2: h1 },
      { x1: r.x, y1: h2, x2: r.x + r.width, y2: h2 },
    ];
  });

  /** Corner handle anchor points (drawn as small L-brackets in the template). */
  protected readonly corners = computed(() => {
    const r = this.rect();
    return [
      { id: 'tl', x: r.x, y: r.y },
      { id: 'tr', x: r.x + r.width, y: r.y },
      { id: 'bl', x: r.x, y: r.y + r.height },
      { id: 'br', x: r.x + r.width, y: r.y + r.height },
    ];
  });

  ngAfterViewInit(): void {
    const el = this.host.nativeElement;
    this.ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        this.wrapW.set(e.contentRect.width);
        this.wrapH.set(e.contentRect.height);
      }
    });
    this.ro.observe(el);
    this.wrapW.set(el.clientWidth);
    this.wrapH.set(el.clientHeight);
    // Crop edits assume fit + zero pan so the footprint maps 1:1 onto the
    // painted image; entering crop snaps the view there (matches Lightroom).
    this.canvasSvc.zoomToFit();
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
  }

  // ── Pointer interaction ────────────────────────────────────────────────────

  protected onPointerDown(ev: PointerEvent): void {
    const { px, py } = this.localPoint(ev);
    const handle = hitTestHandle(px, py, this.rect(), HANDLE_TOLERANCE);
    if (!handle) return;
    const start = pxToNormalized(px, py, this.footprint());
    // One transaction per gesture (#2432) — opened before the first
    // mutation, closed in `onPointerUp`.
    this.editor.commit('crop', 'Crop');
    this.drag = {
      handle,
      startCrop: { ...this.cropRect() },
      startNx: start.nx,
      startNy: start.ny,
    };
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  }

  protected onPointerMove(ev: PointerEvent): void {
    if (!this.drag) return;
    const a = this.library.focusedAsset();
    if (!a) return;
    const { px, py } = this.localPoint(ev);
    const { nx, ny } = pxToNormalized(px, py, this.footprint());
    const { w, h } = this.imgDims();

    let next: Crop;
    if (this.drag.handle === 'move') {
      next = moveCrop(this.drag.startCrop, nx - this.drag.startNx, ny - this.drag.startNy);
    } else {
      next = resizeCrop(this.cropRect(), this.drag.handle, nx, ny, {
        aspect: resolveAspect(this.crop.aspectPreset(), w, h),
        imgW: w,
        imgH: h,
      });
    }
    this.library.updateAdjustment(a.id, { crop: next });
    ev.preventDefault();
  }

  protected onPointerUp(ev: PointerEvent): void {
    if (!this.drag) return;
    this.drag = null;
    (ev.target as Element).releasePointerCapture?.(ev.pointerId);
    this.editor.endEdit();
  }

  /** Cursor hint for the current pointer position (set on plain hover). */
  protected cursor = signal<string>('default');

  protected onHover(ev: PointerEvent): void {
    if (this.drag) return;
    const { px, py } = this.localPoint(ev);
    const handle = hitTestHandle(px, py, this.rect(), HANDLE_TOLERANCE);
    this.cursor.set(cursorFor(handle));
  }

  private localPoint(ev: PointerEvent): { px: number; py: number } {
    const r = this.host.nativeElement.getBoundingClientRect();
    return { px: ev.clientX - r.left, py: ev.clientY - r.top };
  }
}

function cursorFor(handle: CropHandle | null): string {
  switch (handle) {
    case 'tl':
    case 'br':
      return 'nwse-resize';
    case 'tr':
    case 'bl':
      return 'nesw-resize';
    case 't':
    case 'b':
      return 'ns-resize';
    case 'l':
    case 'r':
      return 'ew-resize';
    case 'move':
      return 'move';
    default:
      return 'default';
  }
}
