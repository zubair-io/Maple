// mask-overlay.component.ts — interactive local-adjustment mask overlay
// (#1541), the masking sibling of `CropOverlayComponent`.
//
// Renders over the live canvas while the Mask tool is armed. Draws the
// SELECTED layer only: a translucent red weight visualisation (a direct read
// of `w ∈ [0, 1]` through `evaluateMaskWeight`, the port of raw-core's
// evaluator, so the tint IS what the render applies) and the shape's drag
// handles — pin + axis for a linear gradient, center + two radius pins + a
// rotation pin for a radial mask. Every drag writes the layer through
// `MaskSessionService`, which re-renders the canvas live (the serialized
// sidecar carries the stack); one undo entry per gesture.
//
// Geometry: the footprint is the DISPLAYED image's fit rect (the mask tool
// forces fit on entry, so the painted image maps 1:1 onto it); the canvas
// map folds the applied crop/straighten in, so a mask on a cropped image is
// drawn where raw-core applies it. The pure math is `mask-geometry.ts`.

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
  viewChild,
} from '@angular/core';

import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { MaskSessionService } from './mask-session.service';
import type { LocalMask, MaskPoint } from '../../models/local-adjustment';
import { defaultCrop } from '../../models/adjustment-model';
import { fitFootprint, type Footprint } from '../crop-overlay/crop-geometry';
import { focusedImageDims, hostLocalPoint, observeHostSize } from '../crop-overlay/overlay-host';
import {
  MASK_HANDLE_NAME,
  type MaskCanvasMap,
  type MaskHandle,
  applyAffine,
  dragMaskHandle,
  ellipseOutline,
  evaluateMaskWeight,
  hitTestMaskHandle,
  makeMaskCanvasMap,
  maskFromScreen,
  maskHandles,
  maskToScreen,
} from './mask-geometry';

/** Grab radius for the handles, in CSS px — matches the crop overlay. */
const HANDLE_TOLERANCE = 14;
/** Raster resolution of the weight tint along the footprint's long edge. */
const TINT_LONG_EDGE = 192;
/** Tint colour (`--pro-accent`, #C4493A) and peak opacity at `w = 1`. */
const TINT_RGB = [0xc4, 0x49, 0x3a] as const;
const TINT_PEAK_ALPHA = 0.55;

interface DragState {
  handle: MaskHandle;
  startMask: LocalMask;
  anchor: MaskPoint;
}

interface HandleView {
  handle: MaskHandle;
  x: number;
  y: number;
  r: number;
  name: string;
}

@Component({
  selector: 'editor-mask-overlay',
  standalone: true,
  templateUrl: './mask-overlay.component.html',
  styleUrl: './mask-overlay.component.scss',
  host: {
    class: 'absolute inset-0 z-[8] [touch-action:none]',
    // Always mounted by the canvas; hidden (and out of the pointer stream)
    // unless the Mask tool is armed.
    '[class.hidden]': '!session.active()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MaskOverlayComponent implements AfterViewInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly library = inject(LibraryStateService);
  private readonly canvasSvc = inject(ImageCanvasService);
  protected readonly session = inject(MaskSessionService);

  private readonly tintCanvas = viewChild<ElementRef<HTMLCanvasElement>>('tint');
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

  protected readonly mask = computed<LocalMask | null>(() => this.session.selected()?.mask ?? null);

  /** SVG path for the shape: the gradient axis, or the ellipse outline plus
   *  its rotation lead. */
  protected readonly shapePath = computed<string>(() => {
    const mask = this.mask();
    if (!mask) return '';
    const map = this.map();
    if (mask.kind === 'linear') {
      const s = maskToScreen(map, mask.start);
      const e = maskToScreen(map, mask.end);
      return `M${s.x} ${s.y}L${e.x} ${e.y}`;
    }
    const outline = ellipseOutline(mask.center, mask.radii, mask.angle).map((p) =>
      maskToScreen(map, p),
    );
    const ring = outline.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('') + 'Z';
    const handles = maskHandles(mask);
    const rx = handles.find((h) => h.handle === 'radialRadiusX')?.point;
    const rot = handles.find((h) => h.handle === 'radialRotate')?.point;
    if (!rx || !rot) return ring;
    const a = maskToScreen(map, rx);
    const b = maskToScreen(map, rot);
    return `${ring}M${a.x} ${a.y}L${b.x} ${b.y}`;
  });

  protected readonly handles = computed<HandleView[]>(() => {
    const mask = this.mask();
    if (!mask) return [];
    const map = this.map();
    return maskHandles(mask).map(({ handle, point }) => {
      const s = maskToScreen(map, point);
      const big = handle === 'linearBody' || handle === 'radialCenter';
      return { handle, x: s.x, y: s.y, r: big ? 7 : 6, name: MASK_HANDLE_NAME[handle] };
    });
  });

  protected readonly description = computed<string>(() => {
    const mask = this.mask();
    if (!mask) return 'No mask selected';
    if (mask.kind === 'linear') return 'Linear gradient mask';
    return mask.invert ? 'Inverted radial mask' : 'Radial mask';
  });

  /** One reusable raster buffer for the tint — re-sized only when the
   *  footprint aspect changes, so a drag frame allocates nothing. */
  private tintBuffer: ImageData | null = null;

  constructor() {
    // Mask editing is fit-zoom-only (M3): the footprint maps 1:1 onto the
    // painted image only at fit + zero pan, so arming the tool snaps there.
    effect(() => {
      if (this.session.active()) this.canvasSvc.zoomToFit();
    });
    // Redraw the weight tint whenever the selected mask or the geometry
    // moves — but only while the tool is armed. The overlay stays mounted and
    // the selection survives disarming, so without this gate a resize, a crop
    // edit or an undo would rasterise a tint nobody can see. `active()` is
    // read first, so re-arming re-runs the effect and repaints immediately.
    effect(() => {
      if (!this.session.active()) return;
      const mask = this.mask();
      const map = this.map();
      const canvas = this.tintCanvas()?.nativeElement;
      if (!canvas) return;
      this.tintBuffer = drawWeightTint(canvas, mask, map, this.tintBuffer);
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
    const mask = this.mask();
    if (!mask) return;
    const { px, py } = this.localPoint(ev);
    const handle = hitTestMaskHandle(px, py, mask, this.map(), HANDLE_TOLERANCE);
    if (!handle) return;
    // One undo entry per gesture — opened before the first mutation lands.
    this.session.beginGesture();
    this.drag = { handle, startMask: mask, anchor: maskFromScreen(this.map(), px, py) };
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  }

  protected onPointerMove(ev: PointerEvent): void {
    if (!this.drag) return;
    const { px, py } = this.localPoint(ev);
    const point = maskFromScreen(this.map(), px, py);
    this.session.setShape(
      dragMaskHandle(this.drag.startMask, this.drag.handle, point, this.drag.anchor),
    );
    ev.preventDefault();
  }

  protected onPointerUp(ev: PointerEvent): void {
    if (!this.drag) return;
    this.drag = null;
    this.session.endGesture();
    (ev.target as Element).releasePointerCapture?.(ev.pointerId);
  }

  protected readonly cursor = signal<string>('default');

  protected onHover(ev: PointerEvent): void {
    if (this.drag) return;
    const mask = this.mask();
    const { px, py } = this.localPoint(ev);
    const handle = mask ? hitTestMaskHandle(px, py, mask, this.map(), HANDLE_TOLERANCE) : null;
    this.cursor.set(handle === null ? 'default' : handle === 'radialRotate' ? 'grab' : 'move');
  }

  private localPoint(ev: PointerEvent): { px: number; py: number } {
    return hostLocalPoint(this.host.nativeElement, ev);
  }
}

/** Raster size along the footprint's aspect, `TINT_LONG_EDGE` on the long side. */
function tintRasterSize(fp: Footprint): { width: number; height: number } {
  const aspect = fp.width > 0 && fp.height > 0 ? fp.width / fp.height : 1.5;
  return aspect >= 1
    ? { width: TINT_LONG_EDGE, height: Math.max(1, Math.round(TINT_LONG_EDGE / aspect)) }
    : { width: Math.max(1, Math.round(TINT_LONG_EDGE * aspect)), height: TINT_LONG_EDGE };
}

/** Fill `image` with the tint: each raster pixel is a crop-normalized point,
 *  mapped to full-frame coordinates through the crop map and evaluated with
 *  the same math the render pipeline runs. */
function fillTint(image: ImageData, mask: LocalMask, map: MaskCanvasMap): void {
  const { width, height, data } = image;
  for (let j = 0; j < height; j++) {
    const v = (j + 0.5) / height;
    for (let i = 0; i < width; i++) {
      const p = applyAffine(map.cropToFull, { x: (i + 0.5) / width, y: v });
      const w = Math.min(1, Math.max(0, evaluateMaskWeight(mask, p.x, p.y)));
      const base = (j * width + i) * 4;
      data[base] = TINT_RGB[0];
      data[base + 1] = TINT_RGB[1];
      data[base + 2] = TINT_RGB[2];
      data[base + 3] = Math.round(w * TINT_PEAK_ALPHA * 255);
    }
  }
}

/**
 * Rasterise the mask's weight into the tint canvas over the DISPLAYED
 * footprint, reusing `buffer` when it already has the raster's size (a drag
 * frame then allocates nothing) and resizing the canvas — which clears and
 * reallocates its backing store — only when the raster size changes.
 */
function drawWeightTint(
  canvas: HTMLCanvasElement,
  mask: LocalMask | null,
  map: MaskCanvasMap,
  buffer: ImageData | null = null,
): ImageData | null {
  const { width, height } = tintRasterSize(map.footprint);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return buffer;
  if (!mask) {
    ctx.clearRect(0, 0, width, height);
    return buffer;
  }
  const image =
    buffer && buffer.width === width && buffer.height === height
      ? buffer
      : ctx.createImageData(width, height);
  fillTint(image, mask, map);
  ctx.putImageData(image, 0, 0);
  return image;
}
