// MuiCurvePlot — the Maple UI design-system Curve Plot data plot
// (unified-component-catalog.md §2.6; a plot primitive). A draggable
// control-point curve (e.g. a tone curve editor): each point is 0..1
// normalized, drawn as a smoothed line with `mui-pad-2d`'s established
// pointer-capture drag convention (pointerdown hit-test → setPointerCapture
// → pointermove/pointerup on the same element, not document listeners) plus
// arrow-key nudging of whichever point was last interacted with.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { beginSizedPlotDraw, resolveColor, watchAndDraw } from '../internal/plot-canvas';

export interface MuiCurvePoint {
  readonly x: number;
  readonly y: number;
}

const HIT_RADIUS_PX = 8;
const NUDGE_STEP = 0.02;

const DEFAULT_POINTS: readonly MuiCurvePoint[] = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0.5 },
  { x: 1, y: 1 },
];

@Component({
  selector: 'mui-curve-plot',
  standalone: true,
  templateUrl: './mui-curve-plot.component.html',
  styleUrl: './mui-curve-plot.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class MuiCurvePlotComponent {
  readonly points = model<readonly MuiCurvePoint[]>(DEFAULT_POINTS);
  readonly width = input<number>(120);
  readonly height = input<number>(80);

  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  readonly activeIndex = signal<number | null>(null);
  private activePointerId: number | null = null;

  constructor() {
    watchAndDraw([this.points, this.width, this.height], () => this.draw());
  }

  private toCanvasPoint(p: MuiCurvePoint): { x: number; y: number } {
    return { x: p.x * this.width(), y: (1 - p.y) * this.height() };
  }

  private fromCanvasPoint(x: number, y: number): MuiCurvePoint {
    const w = this.width();
    const h = this.height();
    return {
      x: Math.max(0, Math.min(1, w > 0 ? x / w : 0)),
      y: Math.max(0, Math.min(1, h > 0 ? 1 - y / h : 0)),
    };
  }

  private hitTest(x: number, y: number): number | null {
    const pts = this.points();
    for (let i = 0; i < pts.length; i++) {
      const c = this.toCanvasPoint(pts[i]);
      if (Math.hypot(c.x - x, c.y - y) <= HIT_RADIUS_PX) return i;
    }
    return null;
  }

  onPointerDown(event: PointerEvent): void {
    const canvasEl = this.canvas()?.nativeElement;
    if (!canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const index = this.hitTest(event.clientX - rect.left, event.clientY - rect.top);
    if (index === null) return;
    this.activeIndex.set(index);
    this.activePointerId = event.pointerId;
    canvasEl.setPointerCapture?.(event.pointerId);
  }

  onPointerMove(event: PointerEvent): void {
    if (this.activePointerId === null || event.pointerId !== this.activePointerId) return;
    const canvasEl = this.canvas()?.nativeElement;
    const index = this.activeIndex();
    if (!canvasEl || index === null) return;
    const rect = canvasEl.getBoundingClientRect();
    this.updatePoint(
      index,
      this.fromCanvasPoint(event.clientX - rect.left, event.clientY - rect.top),
    );
  }

  onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.activePointerId) return;
    this.activePointerId = null;
  }

  onKeydown(event: KeyboardEvent): void {
    const index = this.activeIndex();
    if (index === null) return;
    const p = this.points()[index];
    let next: MuiCurvePoint | null = null;
    switch (event.key) {
      case 'ArrowUp':
        next = { ...p, y: Math.min(1, p.y + NUDGE_STEP) };
        break;
      case 'ArrowDown':
        next = { ...p, y: Math.max(0, p.y - NUDGE_STEP) };
        break;
      case 'ArrowRight':
        next = { ...p, x: Math.min(1, p.x + NUDGE_STEP) };
        break;
      case 'ArrowLeft':
        next = { ...p, x: Math.max(0, p.x - NUDGE_STEP) };
        break;
      default:
        return;
    }
    event.preventDefault();
    this.updatePoint(index, next);
  }

  private updatePoint(index: number, next: MuiCurvePoint): void {
    this.points.set(this.points().map((p, i) => (i === index ? next : p)));
  }

  private draw(): void {
    const frame = beginSizedPlotDraw(this.canvas(), this.width, this.height);
    if (!frame) return;
    const { canvasEl, ctx, w, h } = frame;

    ctx.strokeStyle = resolveColor(canvasEl, 'var(--color-border)');
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    const accent = resolveColor(canvasEl, 'var(--color-primary)');
    const sorted = [...this.points()].sort((a, b) => a.x - b.x).map((p) => this.toCanvasPoint(p));

    if (sorted.length >= 2) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sorted[0].x, sorted[0].y);
      // Midpoint-quadratic smoothing: always monotone in x, no overshoot —
      // a lightweight stand-in for a full Fritsch-Carlson monotone spline.
      for (let i = 1; i < sorted.length - 1; i++) {
        const mid = {
          x: (sorted[i].x + sorted[i + 1].x) / 2,
          y: (sorted[i].y + sorted[i + 1].y) / 2,
        };
        ctx.quadraticCurveTo(sorted[i].x, sorted[i].y, mid.x, mid.y);
      }
      const last = sorted[sorted.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }

    const active = this.activeIndex();
    ctx.fillStyle = accent;
    this.points().forEach((p, i) => {
      const c = this.toCanvasPoint(p);
      ctx.beginPath();
      ctx.arc(c.x, c.y, i === active ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}
