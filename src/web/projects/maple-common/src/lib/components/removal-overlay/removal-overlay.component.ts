import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { MAPLE_UI_COLORS } from '../../generated/ui-tokens';
import { RemovalMask } from '../../raw-pipeline/pkg/raw_wasm';
import { RemovalEditorSession } from '../../removal/removal-editor-session.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { observeHostSize } from '../crop-overlay/overlay-host';
import { imageDataToBitmap } from '../../raw-pipeline/image-utils';

@Component({
  selector: 'editor-removal-overlay',
  standalone: true,
  templateUrl: './removal-overlay.component.html',
  styleUrl: './removal-overlay.component.scss',
  host: {
    class: 'absolute inset-0 z-[9] [touch-action:none] cursor-crosshair',
    '[class.hidden]': '!session.active()',
    '(pointerdown)': 'down($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'up($event)',
    '(pointercancel)': 'cancelPointer($event)',
    '(lostpointercapture)': 'cancelPointer($event)',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemovalOverlayComponent implements AfterViewInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly canvasState = inject(ImageCanvasService);
  protected readonly session = inject(RemovalEditorSession);
  @ViewChild('overlay') private surface?: ElementRef<HTMLCanvasElement>;
  private readonly width = signal(0);
  private readonly height = signal(0);
  private readonly ready = signal(false);
  private readonly pathPoints = signal<readonly (readonly [number, number])[]>([]);
  protected readonly path = computed(() =>
    this.pathPoints()
      .map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`)
      .join(' '),
  );
  private readonly footprint = computed(() => {
    const layout = this.canvasState.displayLayout();
    if (!layout) return { left: 0, top: 0, width: 0, height: 0 };
    return {
      left: (this.width() - layout.canvasW) / 2 + layout.pan.x,
      top: (this.height() - layout.canvasH) / 2 + layout.pan.y,
      width: layout.canvasW,
      height: layout.canvasH,
    };
  });
  private resize?: ResizeObserver;
  private pointer?: number;
  private points: (readonly [number, number])[] = [];
  private paintEpoch = 0;

  constructor() {
    effect(() => {
      if (!this.session.active() || !this.ready()) {
        this.paintEpoch++;
        return;
      }
      const selection = this.session.selection(),
        protection = this.session.protection();
      const people = this.session.people();
      const preview = this.session.preview(),
        compare = this.session.compare();
      const rect = this.footprint(),
        dimensions = this.canvasState.cropInputDimensions();
      const epoch = ++this.paintEpoch;
      if (!dimensions) return;
      void this.draw(
        epoch,
        rect,
        [dimensions.w, dimensions.h],
        selection,
        protection,
        compare ? null : preview,
        preview !== null,
        people,
      ).catch((error) => {
        if (
          epoch === this.paintEpoch &&
          !(error instanceof DOMException && error.name === 'AbortError')
        )
          this.session.message.set(error instanceof Error ? error.message : String(error));
      });
    });
  }
  ngAfterViewInit(): void {
    this.resize = observeHostSize(this.host.nativeElement, this.width, this.height);
    this.ready.set(true);
  }
  ngOnDestroy(): void {
    this.paintEpoch++;
    this.resize?.disconnect();
  }
  protected down(event: PointerEvent): void {
    if (event.button !== 0 || this.session.phase() !== 'ready' || !this.session.canPaint()) return;
    if (this.footprint().width <= 0 || !this.canvasState.cropInputDimensions()) return;
    this.pointer = event.pointerId;
    this.points = [];
    this.host.nativeElement.setPointerCapture(event.pointerId);
    this.append(event);
    event.preventDefault();
    event.stopPropagation();
  }
  protected move(event: PointerEvent): void {
    if (event.pointerId !== this.pointer) return;
    for (const sample of event.getCoalescedEvents?.() ?? [event]) this.append(sample);
    event.preventDefault();
    event.stopPropagation();
  }
  protected up(event: PointerEvent): void {
    if (event.pointerId !== this.pointer) return;
    this.append(event);
    const points = this.points.slice(),
      dimensions = this.canvasState.cropInputDimensions();
    this.endPointer(event);
    if (dimensions) void this.session.paint(points, [dimensions.w, dimensions.h]);
    event.preventDefault();
    event.stopPropagation();
  }
  protected cancelPointer(event: PointerEvent): void {
    this.endPointer(event);
  }
  private endPointer(event: PointerEvent): void {
    if (event.pointerId !== this.pointer) return;
    if (this.host.nativeElement.hasPointerCapture(event.pointerId))
      this.host.nativeElement.releasePointerCapture(event.pointerId);
    this.pointer = undefined;
    this.points = [];
    this.pathPoints.set([]);
  }
  private append(event: PointerEvent): void {
    const bounds = this.host.nativeElement.getBoundingClientRect(),
      rect = this.footprint();
    const x = event.clientX - bounds.left,
      y = event.clientY - bounds.top;
    this.points.push([(x - rect.left) / rect.width, (y - rect.top) / rect.height]);
    this.pathPoints.update((points) => [...points, [x, y] as const]);
  }
  private async draw(
    epoch: number,
    rect: { left: number; top: number; width: number; height: number },
    dimensions: readonly [number, number],
    selection: Uint8Array,
    protection: Uint8Array,
    preview: import('../../raw-pipeline/raw-pipeline.types').DecodedImage | null,
    reviewing: boolean,
    people: ReturnType<RemovalEditorSession['people']>,
  ): Promise<void> {
    const surface = this.surface?.nativeElement,
      ctx = surface?.getContext('2d');
    if (!surface || !ctx) return;
    surface.width = this.width();
    surface.height = this.height();
    ctx.clearRect(0, 0, surface.width, surface.height);
    if (reviewing) {
      if (!preview) return;
      const bitmap = await imageDataToBitmap(preview);
      try {
        if (epoch === this.paintEpoch)
          ctx.drawImage(bitmap, rect.left, rect.top, rect.width, rect.height);
      } finally {
        bitmap.close();
      }
      return;
    }
    if (
      (!selection.length && !protection.length && !people.length) ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      return;
    const w = Math.min(400, Math.max(1, Math.round(rect.width))),
      h = Math.max(1, Math.round((w * rect.height) / rect.width));
    const points = Array.from(
      { length: w * h },
      (_, i) => [((i % w) + 0.5) / w, (Math.floor(i / w) + 0.5) / h] as const,
    );
    const mapped = await this.session.mapOverlay(points, dimensions);
    if (epoch !== this.paintEpoch) return;
    const read = (bytes: Uint8Array) => {
      if (!bytes.length) return null;
      const mask = new RemovalMask(bytes),
        geometry = mask.geometry();
      return { geometry, pixels: mask.take_pixels() };
    };
    const selected = read(selection),
      kept = read(protection);
    const hit = (mask: ReturnType<typeof read>, point: readonly [number, number]) => {
      if (!mask) return false;
      const [sw, sh, x, y, width, height] = mask.geometry;
      const px = Math.floor(point[0] * sw) - x,
        py = Math.floor(point[1] * sh) - y;
      return (
        px >= 0 && py >= 0 && px < width && py < height && mask.pixels[py * width + px] === 255
      );
    };
    const boxes = people.map(() => ({ left: w, top: h, right: -1, bottom: -1 }));
    const source = this.session.photo;
    const image = new ImageData(w, h);
    const tintColor = (hex: string) =>
      [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    const keptTint = [...tintColor(MAPLE_UI_COLORS.successText), 100];
    const selectedTint = [...tintColor(MAPLE_UI_COLORS.primary), 100];
    mapped.forEach((point, index) => {
      if (!point) return;
      if (source)
        people.forEach((person, candidate) => {
          const [x1, y1, x2, y2] = person.detection.bounds;
          const sx = point[0] * source.width,
            sy = point[1] * source.height;
          if (sx < x1 || sx >= x2 || sy < y1 || sy >= y2) return;
          const x = index % w,
            y = Math.floor(index / w),
            box = boxes[candidate];
          box.left = Math.min(box.left, x);
          box.top = Math.min(box.top, y);
          box.right = Math.max(box.right, x);
          box.bottom = Math.max(box.bottom, y);
        });
      if (hit(kept, point)) image.data.set(keptTint, index * 4);
      else if (hit(selected, point)) image.data.set(selectedTint, index * 4);
    });
    const tint = await createImageBitmap(image);
    try {
      if (epoch === this.paintEpoch)
        ctx.drawImage(tint, rect.left, rect.top, rect.width, rect.height);
    } finally {
      tint.close();
    }
    if (epoch !== this.paintEpoch) return;
    ctx.font = '12px system-ui';
    ctx.lineWidth = 1;
    boxes.forEach((box, index) => {
      if (box.right < box.left) return;
      const x = rect.left + (box.left / w) * rect.width;
      const y = rect.top + (box.top / h) * rect.height;
      const color = people[index].keep ? MAPLE_UI_COLORS.successText : MAPLE_UI_COLORS.primary;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.strokeRect(
        x,
        y,
        ((box.right - box.left + 1) / w) * rect.width,
        ((box.bottom - box.top + 1) / h) * rect.height,
      );
      ctx.fillText(String(index + 1), x + 3, y + 14);
    });
  }
}
