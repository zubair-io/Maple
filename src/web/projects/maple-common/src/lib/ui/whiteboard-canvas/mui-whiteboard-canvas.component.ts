// MuiWhiteboardCanvas — the Maple UI design-system Whiteboard Canvas organism
// (unified-component-catalog.md §4.5; Built from: Canvas Surface, Toolbar,
// Input, Button). A freeform drawing surface with a pen/eraser toolbar and
// an AI-prompt bar underneath. All drawing math (stroke capture, hit-test
// erase, redraw) lives here — `mui-canvas-surface` only hands over the raw
// `<canvas>` element, it draws nothing itself.

import { ChangeDetectionStrategy, Component, model, output } from '@angular/core';
import { MuiCanvasSurfaceComponent } from '../canvas-surface/mui-canvas-surface.component';
import { MuiToolbarComponent } from '../toolbar/mui-toolbar.component';
import type { MuiToolbarEntry } from '../toolbar/mui-toolbar.component';
import { MuiInputComponent } from '../input/mui-input.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import { isPointerDragEnd, isPointerDragMove } from '../internal/pointer-drag';

export interface MuiWhiteboardPoint {
  readonly x: number;
  readonly y: number;
}

/** Only `'pen'` strokes are ever stored — the eraser removes strokes from
 * the list rather than adding a stroke of its own. */
export interface MuiWhiteboardStroke {
  readonly id: string;
  readonly tool: 'pen';
  readonly color: string;
  readonly width: number;
  readonly points: readonly MuiWhiteboardPoint[];
}

export type MuiWhiteboardTool = 'pen' | 'eraser';

const PEN_STROKE_WIDTH = 3;
const ERASER_HIT_RADIUS = 12;
const FALLBACK_STROKE_COLOR = '#c4493a';

const TOOLBAR_ENTRIES: readonly MuiToolbarEntry[] = [
  { id: 'pen', icon: 'edit', label: 'Pen' },
  { id: 'eraser', icon: 'clear-circle-fill', label: 'Eraser' },
  { divider: true },
  { id: 'clear', icon: 'trash', label: 'Clear' },
];

@Component({
  selector: 'mui-whiteboard-canvas',
  standalone: true,
  imports: [MuiCanvasSurfaceComponent, MuiToolbarComponent, MuiInputComponent, MuiButtonComponent],
  templateUrl: './mui-whiteboard-canvas.component.html',
  styleUrl: './mui-whiteboard-canvas.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiWhiteboardCanvasComponent {
  readonly tool = model<MuiWhiteboardTool>('pen');
  readonly strokes = model<readonly MuiWhiteboardStroke[]>([]);
  readonly prompt = model<string>('');

  // Note: `strokesChange` (emitted automatically by the `strokes` model())
  // already covers what a separate `strokesChanged` output would carry, so
  // no duplicate output is declared here.
  readonly promptSubmitted = output<string>();

  readonly toolbarEntries = TOOLBAR_ENTRIES;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private dragging = false;
  private activePointerId: number | null = null;
  private inProgressStroke: MuiWhiteboardStroke | null = null;
  private redrawScheduled = false;

  onCanvasReady(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }

    canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    canvas.addEventListener('pointercancel', (event) => this.onPointerUp(event));

    this.redraw();
  }

  onToolbarAction(id: string): void {
    if (id === 'pen' || id === 'eraser') {
      this.tool.set(id);
      return;
    }
    if (id === 'clear') {
      this.strokes.set([]);
      this.redraw();
    }
  }

  onPromptSubmit(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.promptSubmitted.emit(trimmed);
    this.prompt.set('');
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.canvas) return;
    const point = this.pointFromEvent(event);
    this.dragging = true;
    this.activePointerId = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);

    if (this.tool() === 'eraser') {
      this.eraseAt(point);
      return;
    }

    this.inProgressStroke = {
      id: crypto.randomUUID(),
      tool: 'pen',
      color: this.resolveStrokeColor(),
      width: PEN_STROKE_WIDTH,
      points: [point],
    };
    this.scheduleRedraw();
  }

  private onPointerMove(event: PointerEvent): void {
    if (!isPointerDragMove(this.dragging, event, this.activePointerId)) return;
    const point = this.pointFromEvent(event);

    if (this.tool() === 'eraser') {
      this.eraseAt(point);
      return;
    }

    if (!this.inProgressStroke) return;
    this.inProgressStroke = {
      ...this.inProgressStroke,
      points: [...this.inProgressStroke.points, point],
    };
    this.scheduleRedraw();
  }

  private onPointerUp(event: PointerEvent): void {
    if (!isPointerDragEnd(event, this.activePointerId)) return;
    this.dragging = false;
    this.activePointerId = null;

    const finished = this.inProgressStroke;
    this.inProgressStroke = null;
    if (finished && finished.points.length > 0) {
      this.strokes.update((list) => [...list, finished]);
    }
    this.redraw();
  }

  private eraseAt(point: MuiWhiteboardPoint): void {
    const isHit = (stroke: MuiWhiteboardStroke): boolean =>
      stroke.points.some((p) => Math.hypot(p.x - point.x, p.y - point.y) < ERASER_HIT_RADIUS);

    const current = this.strokes();
    const remaining = current.filter((stroke) => !isHit(stroke));
    if (remaining.length === current.length) return;
    this.strokes.set(remaining);
    this.redraw();
  }

  private pointFromEvent(event: PointerEvent): MuiWhiteboardPoint {
    if (!this.canvas) return { x: 0, y: 0 };
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** A canvas `strokeStyle` can't be handed a live CSS custom-property
   * string and stay themable after the fact — canvas pixels are painted
   * once and don't repaint on a theme change the way DOM/CSS does. So each
   * stroke resolves `--color-primary` to its current computed value at
   * draw time and stores that resolved string on the stroke object; this
   * keeps the *initial* paint tokenized (no hard-coded hex in the common
   * case) while remaining a value `ctx.strokeStyle` can actually consume. */
  private resolveStrokeColor(): string {
    if (!this.canvas) return FALLBACK_STROKE_COLOR;
    const resolved = getComputedStyle(this.canvas).getPropertyValue('--color-primary').trim();
    return resolved.length > 0 ? resolved : FALLBACK_STROKE_COLOR;
  }

  private scheduleRedraw(): void {
    if (this.redrawScheduled) return;
    this.redrawScheduled = true;
    requestAnimationFrame(() => {
      this.redrawScheduled = false;
      this.redraw();
    });
  }

  private redraw(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const strokesToPaint = this.inProgressStroke
      ? [...this.strokes(), this.inProgressStroke]
      : this.strokes();
    for (const stroke of strokesToPaint) this.paintStroke(ctx, stroke);
  }

  private paintStroke(ctx: CanvasRenderingContext2D, stroke: MuiWhiteboardStroke): void {
    if (stroke.points.length === 0) return;
    const [first, ...rest] = stroke.points;

    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const point of rest) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
}
