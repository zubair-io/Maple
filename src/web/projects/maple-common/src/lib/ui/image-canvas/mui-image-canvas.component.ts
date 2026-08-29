// MuiImageCanvas — Maple UI design-system Image Canvas organism
// (unified-component-catalog.md §4.5). Built from: Canvas Surface, Preview
// Image, Crop Overlay. Real pan (pointer-drag), zoom-to-cursor (wheel), and
// a before/after src swap, drawn to a plain 2D canvas the component owns
// end to end — this is the reusable chrome + interaction math, NOT the
// real Rust/WASM render pipeline (that lives at
// projects/maple-common/src/lib/components/image-canvas and is untouched
// here).

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MuiCanvasSurfaceComponent } from '../canvas-surface/mui-canvas-surface.component';
import { MuiPreviewImageComponent } from '../preview-image/mui-preview-image.component';
import { MuiCropOverlayComponent } from '../crop-overlay/mui-crop-overlay.component';
import type { MuiCropRect } from '../crop-overlay/mui-crop-overlay.component';
import { isPointerDragEnd, isPointerDragMove } from '../internal/pointer-drag';

export interface MuiImageTransform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const WHEEL_ZOOM_SENSITIVITY = 0.001;
const DEFAULT_TRANSFORM: MuiImageTransform = { x: 0, y: 0, scale: 1 };

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Zoom-to-point: recomputes the pan offset so the content-space point
 * under `(cursorX, cursorY)` stays under the cursor after `nextScale`
 * replaces `transform.scale` — the standard `newOffset = cursor - (cursor -
 * oldOffset) * (newScale / oldScale)` formula, applied per axis. */
function zoomToPoint(
  transform: MuiImageTransform,
  cursorX: number,
  cursorY: number,
  nextScale: number,
): MuiImageTransform {
  const ratio = nextScale / transform.scale;
  return {
    scale: nextScale,
    x: cursorX - (cursorX - transform.x) * ratio,
    y: cursorY - (cursorY - transform.y) * ratio,
  };
}

@Component({
  selector: 'mui-image-canvas',
  standalone: true,
  imports: [MuiCanvasSurfaceComponent, MuiPreviewImageComponent, MuiCropOverlayComponent],
  templateUrl: './mui-image-canvas.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block h-full w-full overflow-hidden rounded-lg bg-image-canvas' },
})
export class MuiImageCanvasComponent implements OnDestroy {
  readonly src = input.required<string>();
  readonly beforeSrc = input<string | null>(null);
  readonly showBefore = input<boolean>(false);
  readonly cropMode = input<boolean>(false);
  readonly cropRect = model<MuiCropRect>({ x: 40, y: 40, width: 220, height: 160 });

  readonly transformChanged = output<MuiImageTransform>();
  readonly cropRectChanged = output<MuiCropRect>();

  readonly activeSrc = computed(() => {
    const before = this.beforeSrc();
    return this.showBefore() && before ? before : this.src();
  });

  readonly readyImage = signal<HTMLImageElement | null>(null);
  readonly transform = signal<MuiImageTransform>(DEFAULT_TRANSFORM);
  readonly containerSize = signal<{ readonly width: number; readonly height: number }>({
    width: 0,
    height: 0,
  });
  readonly canvasOffset = signal<{ readonly left: number; readonly top: number }>({
    left: 0,
    top: 0,
  });

  readonly showCanvas = computed(() => this.readyImage() !== null);
  readonly contentAspect = computed(() => {
    const img = this.readyImage();
    return img && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : null;
  });

  private readonly canvasHostRef = viewChild<ElementRef<HTMLElement>>('canvasHost');

  private canvasEl: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private ro?: ResizeObserver;
  private loadGeneration = 0;

  private dragging = false;
  private activePointerId: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartTransform: MuiImageTransform = DEFAULT_TRANSFORM;

  constructor() {
    effect(() => {
      this.loadImage(this.activeSrc());
    });
    effect(() => {
      this.transform();
      this.readyImage();
      this.redraw();
    });
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.detachCanvasListeners();
  }

  onCanvasReady(canvas: HTMLCanvasElement): void {
    this.detachCanvasListeners();
    this.canvasEl = canvas;
    this.ctx = canvas.getContext('2d');
    this.attachCanvasListeners(canvas);
    this.updateContainerSize(canvas);

    this.ro?.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.updateContainerSize(canvas));
      this.ro.observe(canvas);
    }
  }

  onCropRectChange(rect: MuiCropRect): void {
    this.cropRectChanged.emit(rect);
  }

  /** Public so tests can drive the decode outcome synchronously instead of
   * racing a real network `Image` load (same seam as `mui-remote-image`'s
   * `handleTierLoaded`/`handleTierError`). The real `new Image()` path
   * below still wires this up for actual usage. */
  handleImageLoaded(img: HTMLImageElement, generation: number): void {
    if (generation !== this.loadGeneration) return;
    this.readyImage.set(img);
  }

  handleImageError(generation: number): void {
    if (generation !== this.loadGeneration) return;
    this.readyImage.set(null);
  }

  private loadImage(src: string): void {
    const generation = ++this.loadGeneration;
    this.readyImage.set(null);
    if (!src) return;

    const img = new Image();
    img.onload = () => this.handleImageLoaded(img, generation);
    img.onerror = () => this.handleImageError(generation);
    img.src = src;
  }

  private updateContainerSize(canvas: HTMLCanvasElement): void {
    const canvasRect = canvas.getBoundingClientRect();
    const hostRect = this.canvasHostRef()?.nativeElement.getBoundingClientRect();
    const width = Math.max(1, Math.round(canvasRect.width));
    const height = Math.max(1, Math.round(canvasRect.height));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    this.containerSize.set({ width, height });
    this.canvasOffset.set({
      left: hostRect ? canvasRect.left - hostRect.left : 0,
      top: hostRect ? canvasRect.top - hostRect.top : 0,
    });
    this.redraw();
  }

  private attachCanvasListeners(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private detachCanvasListeners(): void {
    const canvas = this.canvasEl;
    if (!canvas) return;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('wheel', this.onWheel);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.dragging = true;
    this.activePointerId = event.pointerId;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.dragStartTransform = this.transform();
    this.canvasEl?.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!isPointerDragMove(this.dragging, event, this.activePointerId)) return;
    this.panBy(event.clientX - this.dragStartX, event.clientY - this.dragStartY);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!isPointerDragEnd(event, this.activePointerId)) return;
    this.dragging = false;
    this.activePointerId = null;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const canvas = this.canvasEl;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY);
  };

  private panBy(dx: number, dy: number): void {
    const base = this.dragStartTransform;
    this.setTransform({ ...base, x: base.x + dx, y: base.y + dy });
  }

  private zoomAt(cursorX: number, cursorY: number, deltaY: number): void {
    const current = this.transform();
    const nextScale = clampScale(current.scale * (1 - deltaY * WHEEL_ZOOM_SENSITIVITY));
    this.setTransform(zoomToPoint(current, cursorX, cursorY, nextScale));
  }

  private setTransform(next: MuiImageTransform): void {
    this.transform.set(next);
    this.transformChanged.emit(next);
  }

  private redraw(): void {
    const ctx = this.ctx;
    const canvas = this.canvasEl;
    if (!ctx || !canvas) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const img = this.readyImage();
    if (!img) return;
    const { x, y, scale } = this.transform();
    ctx.setTransform(scale, 0, 0, scale, x, y);
    ctx.drawImage(img, 0, 0);
  }
}
