// MuiDragBar — Maple UI Molecules-L1 (unified-component-catalog.md §2.1).
// Tick-marked scrub control, built from Text. A clean design-system
// re-implementation of the Pro Editor's `DragBarComponent`
// (src/lib/editor/drag-bar.component.ts) — same click-to-value + relative
// drag + keyboard-arrow contract, self-contained and tokenized rather than
// importing that app component or its math module.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  input,
  model,
  signal,
} from '@angular/core';
import { MuiTextComponent } from '../text/mui-text.component';
import { arrowKeyDelta, endPointerDrag, percentInRange } from '../internal/pointer-drag';

export interface MuiDragBarTick {
  readonly pct: number;
  readonly emphasized: boolean;
}

const TICK_COUNT = 21;
const CENTER_TICK_INDEX = 10;

function buildTicks(): readonly MuiDragBarTick[] {
  return Array.from({ length: TICK_COUNT }, (_, i) => ({
    pct: (i / (TICK_COUNT - 1)) * 100,
    emphasized: i === CENTER_TICK_INDEX,
  }));
}

@Component({
  selector: 'mui-drag-bar',
  standalone: true,
  imports: [MuiTextComponent],
  templateUrl: './mui-drag-bar.component.html',
  styleUrl: './mui-drag-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiDragBarComponent {
  readonly label = input<string | null>(null);
  readonly value = model<number>(0);
  readonly min = input<number>(-100);
  readonly max = input<number>(100);
  readonly step = input<number>(1);
  readonly disabled = input<boolean>(false);

  @ViewChild('barEl') private barRef!: ElementRef<HTMLElement>;

  readonly ticks = buildTicks();
  readonly dragging = signal(false);
  private activePointerId: number | null = null;
  private pointerDownX = 0;
  private pointerDownValue = 0;
  private barWidth = 0;

  // fallow-ignore-next-line unused-class-member -- read from the templateUrl view (`markerPct()`); fallow's member-usage scan doesn't follow external Angular templates.
  readonly markerPct = computed(() => percentInRange(this.value(), this.min(), this.max(), 50));

  readonly valueLabel = computed(() => {
    const v = this.value();
    return v > 0 ? `+${v}` : `${v}`;
  });

  private clamp(v: number): number {
    return Math.min(this.max(), Math.max(this.min(), v));
  }

  private valueAtX(x: number): number {
    if (this.barWidth <= 0) return this.value();
    const lo = this.min();
    const hi = this.max();
    const pct = x / this.barWidth;
    return this.clamp(Math.round(lo + pct * (hi - lo)));
  }

  onPointerDown(event: PointerEvent): void {
    if (this.disabled() || event.button !== 0 || this.dragging()) return;
    const bar = this.barRef?.nativeElement;
    if (!bar) return;

    const rect = bar.getBoundingClientRect();
    this.barWidth = rect.width;
    this.dragging.set(true);
    this.activePointerId = event.pointerId;
    this.pointerDownX = event.clientX - rect.left;
    this.pointerDownValue = this.valueAtX(this.pointerDownX);
    this.value.set(this.pointerDownValue);
    bar.setPointerCapture(event.pointerId);
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.dragging() || event.pointerId !== this.activePointerId) return;
    if (this.barWidth <= 0) return;
    const rect = this.barRef.nativeElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    this.value.set(this.valueAtX(x));
  }

  onPointerUp(event: PointerEvent): void {
    endPointerDrag(event, this.activePointerId, this.dragging, () => (this.activePointerId = null));
  }

  onKeydown(event: KeyboardEvent): void {
    const delta = arrowKeyDelta(event.key, this.step());
    if (delta === null) return;

    event.preventDefault();
    event.stopPropagation();
    this.value.set(this.clamp(this.value() + delta));
  }
}
