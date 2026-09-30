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
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { LibraryStateService } from '../../state/library-state.service';
import { OverlayPlacement } from '../crop-overlay/overlay-host';
import { maskFromScreen, maskToScreen } from '../mask-overlay/mask-geometry';
import { GuidedGeometrySessionService, type GuidePoint } from './guided-geometry-session.service';

@Component({
  selector: 'editor-guided-geometry-overlay',
  standalone: true,
  templateUrl: './guided-geometry-overlay.component.html',
  styleUrl: './guided-geometry-overlay.component.scss',
  host: {
    class: 'absolute inset-0 z-[9] touch-none',
    '(wheel)': '$event.preventDefault(); $event.stopPropagation()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GuidedGeometryOverlayComponent implements AfterViewInit, OnDestroy {
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly library = inject(LibraryStateService);
  protected readonly session = inject(GuidedGeometrySessionService);
  private readonly canvas = inject(ImageCanvasService);
  private readonly placement = new OverlayPlacement(() => this.host.nativeElement, {
    focusedAsset: computed(() => {
      const asset = this.library.focusedAsset();
      const dims = this.canvas.nativeDimensions();
      return asset && dims ? { ...asset, width: dims.w, height: dims.h } : asset;
    }),
    adjustmentFor: (id) => this.library.adjustmentFor(id),
  });
  protected readonly cursor = signal<GuidePoint>({ x: 0.5, y: 0.5 });
  private readonly anchor = signal<GuidePoint | null>(null);
  private pointer: { id: number; x: number; y: number } | null = null;
  protected readonly paths = computed(() =>
    this.session.lines().map((line) => this.path(line.start, line.end)),
  );
  protected readonly pendingPath = computed(() =>
    this.anchor() ? this.path(this.anchor()!, this.cursor()) : '',
  );
  protected readonly cursorPx = computed(() => maskToScreen(this.placement.map(), this.cursor()));

  ngAfterViewInit(): void {
    this.placement.observe();
    this.host.nativeElement.querySelector<SVGElement>('svg')?.focus();
  }
  ngOnDestroy(): void {
    this.placement.destroy();
  }

  private path(start: GuidePoint, end: GuidePoint): string {
    const a = maskToScreen(this.placement.map(), start);
    const b = maskToScreen(this.placement.map(), end);
    return `M${a.x} ${a.y}L${b.x} ${b.y}`;
  }

  private point(ev: PointerEvent): GuidePoint | null {
    const { px, py } = this.placement.localPoint(ev);
    const fp = this.placement.footprint();
    if (px < fp.left || px > fp.left + fp.width || py < fp.top || py > fp.top + fp.height)
      return null;
    return maskFromScreen(this.placement.map(), px, py);
  }

  onDown(ev: PointerEvent): void {
    ev.stopPropagation();
    if (ev.button !== 0 || this.session.busy() || this.session.canApply()) return;
    const p = this.point(ev);
    if (!p) return;
    ev.preventDefault();
    (ev.currentTarget as SVGElement).focus();
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    this.pointer = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    this.cursor.set(p);
    if (!this.anchor()) this.anchor.set(p);
  }

  onMove(ev: PointerEvent): void {
    ev.stopPropagation();
    const p = this.point(ev);
    if (p && this.anchor()) this.cursor.set(p);
  }

  onUp(ev: PointerEvent): void {
    ev.stopPropagation();
    if (this.pointer?.id !== ev.pointerId) return;
    const p = this.point(ev);
    const distance = Math.hypot(ev.clientX - this.pointer.x, ev.clientY - this.pointer.y);
    const anchor = this.anchor();
    this.pointer = null;
    (ev.currentTarget as Element).releasePointerCapture(ev.pointerId);
    if (p && anchor && (distance >= 8 || Math.hypot(p.x - anchor.x, p.y - anchor.y) >= 0.01)) {
      this.session.add({ start: anchor, end: p });
      this.anchor.set(null);
    }
  }

  onCancel(ev: PointerEvent): void {
    ev.stopPropagation();
    this.pointer = null;
    this.anchor.set(null);
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Tab') return;
    ev.stopPropagation();
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.session.cancel();
      return;
    }
    if (this.session.busy() || this.session.canApply()) return;
    if (this.moveCursor(ev)) return;
    if (!['Enter', ' '].includes(ev.key)) return;
    ev.preventDefault();
    const a = this.anchor();
    if (a) {
      this.session.add({ start: a, end: this.cursor() });
      this.anchor.set(null);
    } else this.anchor.set(this.cursor());
  }

  private moveCursor(ev: KeyboardEvent): boolean {
    const delta = ev.shiftKey ? 0.01 : 0.002;
    const movement: Record<string, GuidePoint> = {
      ArrowLeft: { x: -delta, y: 0 },
      ArrowRight: { x: delta, y: 0 },
      ArrowUp: { x: 0, y: -delta },
      ArrowDown: { x: 0, y: delta },
    };
    const d = movement[ev.key];
    if (!d) return false;
    ev.preventDefault();
    this.cursor.update((p) => ({
      x: Math.max(0, Math.min(1, p.x + d.x)),
      y: Math.max(0, Math.min(1, p.y + d.y)),
    }));
    return true;
  }
}
