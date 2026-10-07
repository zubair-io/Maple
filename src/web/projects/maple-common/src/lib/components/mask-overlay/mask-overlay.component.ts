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
//
// A brush layer (#360) has no handles: pointer-down starts a stroke, and the
// tint is the dab series stamped through `rasterizeBrushDabs` (the port of
// raw-core's rasterizer, so again the tint IS what the render applies). One
// undo entry per stroke.

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
import {
  isGeometricMask,
  type BrushDab,
  type BrushMask,
  type LocalMask,
  type MaskPoint,
} from '../../models/local-adjustment';
import type { Footprint } from '../crop-overlay/crop-geometry';
import { OverlayDrag, OverlayPlacement } from '../crop-overlay/overlay-host';
import {
  MASK_HANDLE_NAME,
  type MaskCanvasMap,
  type MaskHandle,
  applyAffine,
  dragMaskHandle,
  ellipseOutline,
  evaluateMaskWeight,
  hitTestMaskHandle,
  maskFromScreen,
  maskHandles,
  maskToScreen,
} from './mask-geometry';
import {
  StrokeSmoother,
  applyPressure,
  interpolateDabs,
  mapDabsToCrop,
  rasterizeBrushDabs,
} from './mask-brush';

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

interface StrokeState {
  smoother: StrokeSmoother;
  last: MaskPoint;
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
  private readonly drag = new OverlayDrag<DragState>();
  private readonly stroke = new OverlayDrag<StrokeState>();

  /** Host size, applied crop, fit footprint and the full-frame ↔ screen map
   *  — shared with every other canvas overlay (`overlay-host.ts`). */
  private readonly placement = new OverlayPlacement(() => this.host.nativeElement, this.library);
  protected readonly footprint = this.placement.footprint;
  protected readonly map = this.placement.map;

  protected readonly mask = this.session.selectedMask;

  /** SVG path for the shape: the gradient axis, or the ellipse outline plus
   *  its rotation lead. */
  protected readonly shapePath = computed<string>(() => {
    const mask = this.mask();
    // A bitmap or everywhere mask has no parametric outline to draw (#3300).
    if (!mask || !isGeometricMask(mask)) return '';
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
    if (mask.kind === 'bitmap') return 'Person skin mask';
    if (mask.kind === 'everywhere') return 'Whole-image mask';
    if (mask.kind === 'brush') return 'Brush mask';
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
      const mask = this.session.selected()?.mask ?? null;
      const map = this.map();
      const canvas = this.tintCanvas()?.nativeElement;
      if (!canvas) return;
      this.tintBuffer = drawWeightTint(canvas, mask, map, this.tintBuffer);
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
    const mask = this.mask();
    if (!mask) return;
    const { px, py } = this.localPoint(ev);
    if (mask.kind === 'brush') {
      // One undo entry per stroke — opened before the first dab lands.
      this.session.beginGesture();
      const smoother = new StrokeSmoother();
      const at = smoother.reset(maskFromScreen(this.map(), px, py));
      this.stroke.begin(ev, { smoother, last: at });
      this.stampStrokeSegment(mask, at, at, ev.pressure);
      return;
    }
    const handle = hitTestMaskHandle(px, py, mask, this.map(), HANDLE_TOLERANCE);
    if (!handle) return;
    // One undo entry per gesture — opened before the first mutation lands.
    this.session.beginGesture();
    this.drag.begin(ev, {
      handle,
      startMask: mask,
      anchor: maskFromScreen(this.map(), px, py),
    });
  }

  protected onPointerMove(ev: PointerEvent): void {
    const stroking = this.stroke.active;
    if (stroking) {
      const mask = this.mask();
      if (mask?.kind !== 'brush') return;
      const { px, py } = this.localPoint(ev);
      const at = stroking.smoother.next(maskFromScreen(this.map(), px, py));
      this.stampStrokeSegment(mask, stroking.last, at, ev.pressure);
      stroking.last = at;
      ev.preventDefault();
      return;
    }
    const drag = this.drag.active;
    if (!drag) return;
    const { px, py } = this.localPoint(ev);
    const point = maskFromScreen(this.map(), px, py);
    this.session.setShape(dragMaskHandle(drag.startMask, drag.handle, point, drag.anchor));
    ev.preventDefault();
  }

  /** Lay the pointer segment's dabs onto the stroke (a tap stamps one). */
  private stampStrokeSegment(
    mask: BrushMask,
    from: MaskPoint,
    to: MaskPoint,
    pressure: number,
  ): void {
    const a = this.library.focusedAsset();
    const aspect = a?.width && a?.height ? a.width / a.height : 1;
    const { radius, weight } = applyPressure(
      this.session.brush.size(),
      this.session.brush.flow(),
      pressure,
    );
    const dabs = interpolateDabs(from, to, aspect, {
      radius,
      feather: this.session.brush.feather(),
      weight,
      erase: this.session.brush.erase(),
    });
    if (dabs.length === 0) return;
    this.session.setShape({ ...mask, dabs: [...mask.dabs, ...dabs] });
  }

  protected onPointerUp(ev: PointerEvent): void {
    this.stroke.end(ev, this.session);
    this.drag.end(ev, this.session);
  }

  protected readonly cursor = signal<string>('default');

  protected onHover(ev: PointerEvent): void {
    if (this.drag.active || this.stroke.active) return;
    const mask = this.mask();
    if (mask?.kind === 'brush') {
      this.cursor.set('crosshair');
      return;
    }
    const { px, py } = this.localPoint(ev);
    const handle = mask ? hitTestMaskHandle(px, py, mask, this.map(), HANDLE_TOLERANCE) : null;
    this.cursor.set(handle === null ? 'default' : handle === 'radialRotate' ? 'grab' : 'move');
  }

  private localPoint(ev: PointerEvent): { px: number; py: number } {
    return this.placement.localPoint(ev);
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
 *  the same math the render pipeline runs. A brush layer stamps its dab
 *  series instead — per-pixel evaluation would re-stamp the stroke per query
 *  point, so the weight comes from the rasterizer both here and in the
 *  render. */
function fillTint(image: ImageData, mask: LocalMask, map: MaskCanvasMap): void {
  if (mask.kind === 'brush') {
    fillBrushTint(image, mask.dabs, map);
    return;
  }
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

/** Tint a brush layer: map the dab series into crop space and stamp it at
 *  tint resolution. The radius is a fraction of the FULL-frame width while
 *  the grid spans the crop, so radii scale by the full/crop width ratio —
 *  the x-axis length of the crop→full map (exact for axis-aligned crops and
 *  straighten rotations, which preserve axis length). */
function fillBrushTint(image: ImageData, dabs: readonly BrushDab[], map: MaskCanvasMap): void {
  const { data } = image;
  const cropWidth = Math.hypot(map.cropToFull.a, map.cropToFull.b);
  const grid = rasterizeBrushDabs(
    mapDabsToCrop(dabs, map.fullToCrop, cropWidth > 1e-9 ? 1 / cropWidth : 1),
    image.width,
    image.height,
  );
  for (let i = 0; i < grid.length; i++) {
    const base = i * 4;
    data[base] = TINT_RGB[0];
    data[base + 1] = TINT_RGB[1];
    data[base + 2] = TINT_RGB[2];
    data[base + 3] = Math.round((grid[i] / 255) * TINT_PEAK_ALPHA * 255);
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
