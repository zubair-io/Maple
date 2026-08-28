// MuiDragBar — Maple UI Molecules-L1 (unified-component-catalog.md §2.1).
// Tick-marked scrub control, built from Text. A clean design-system
// re-implementation of the Pro Editor's `DragBarComponent`
// (src/lib/editor/drag-bar.component.ts) — same tick geometry and keyboard
// contract, self-contained and tokenized rather than importing that app
// component or its math module.
//
// Two interaction models, chosen via `dragMode` (#3046):
//  - 'absolute' (default): pointer-down JUMPS the value to the position
//    under the pointer — a click-to-position scrub, the shape every other
//    consumer of this component already relies on.
//  - 'relative': pointer-down does NOT move the value. The value instead
//    moves by the pointer's DELTA from the down point — the Pro Editor's
//    drag-bar contract, where a value-precise slider must never jump on
//    touch-down. Relative mode also supports a long-press-to-fine-mode
//    gesture (holding still past `longPressMs` scales the rest of the
//    drag's sensitivity by `fineModeSensitivity`) and exposes gesture
//    milestones as outputs ("haptics hooks") — `dragStart`/`dragEnd` bound
//    the gesture, `fineModeEngaged`/`crossedZero`/`reachedExtreme` mark
//    moments the Pro Editor fires real haptic feedback for. This component
//    never calls a haptics API itself — that's an app-level concern the
//    caller wires these outputs to.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { MuiTextComponent } from '../text/mui-text.component';
import {
  consumeArrowKeyDelta,
  endPointerDrag,
  formatSignedValue,
  percentInRange,
} from '../internal/pointer-drag';

export interface MuiDragBarTick {
  readonly pct: number;
  readonly emphasized: boolean;
}

export type MuiDragBarMode = 'absolute' | 'relative';

const TICK_COUNT = 21;
const CENTER_TICK_INDEX = 10;
const DEFAULT_LONG_PRESS_MS = 500;
const DEFAULT_FINE_MODE_SENSITIVITY = 0.25;

/** Did the drag carry the value to (or past) `min` or `max`? Split out of
 * `emitGestureHaptics` as its own pure predicate — one branch's worth of
 * complexity instead of two folded into one function. */
function didReachExtreme(from: number, to: number, min: number, max: number): boolean {
  return (from > min && to <= min) || (from < max && to >= max);
}

/** Did the drag carry the value across zero? Same reasoning as
 * `didReachExtreme` above. */
function didCrossZero(from: number, to: number): boolean {
  return (from < 0 && to >= 0) || (from > 0 && to <= 0) || (from === 0 && to !== 0);
}

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
  /** Overrides the accessible name without rendering the visible label
   * row `label` also triggers — for a caller that needs a distinct,
   * possibly dynamic (e.g. value-carrying) accessible name and no visible
   * label chrome of its own (the Pro Editor's drag-bar, which reads its
   * label+value from a separate value-chip overlay instead). */
  readonly ariaLabel = input<string | null>(null);
  readonly value = model<number>(0);
  readonly min = input<number>(-100);
  readonly max = input<number>(100);
  readonly step = input<number>(1);
  readonly disabled = input<boolean>(false);
  /** Passed straight through as the draggable track's own `data-testid` —
   * lets a caller's integration test find and drive the real interactive
   * element directly, rather than reconstructing it from a CSS selector. */
  readonly testId = input<string | null>(null);
  readonly dragMode = input<MuiDragBarMode>('absolute');
  readonly longPressMs = input<number>(DEFAULT_LONG_PRESS_MS);
  readonly fineModeSensitivity = input<number>(DEFAULT_FINE_MODE_SENSITIVITY);

  /** Gesture bounds — fired in both drag modes. */
  readonly dragStart = output<void>();
  readonly dragEnd = output<void>();
  /** Relative mode only: fired once when the long-press timer promotes the
   * gesture into fine mode. */
  readonly fineModeEngaged = output<void>();
  /** Relative mode only: fired on every pointer move that carries the value
   * across zero. */
  readonly crossedZero = output<void>();
  /** Relative mode only: fired on every pointer move that carries the value
   * to (or past) `min`/`max`. */
  readonly reachedExtreme = output<void>();

  @ViewChild('barEl') private barRef!: ElementRef<HTMLElement>;

  readonly ticks = buildTicks();
  readonly dragging = signal(false);
  /** Relative mode only: true while the gesture is in fine (reduced
   * sensitivity) mode — exposed read-only for host styling (e.g. a caller
   * marking the marker/ticks while scrubbing at reduced sensitivity). */
  readonly fineMode = signal(false);
  private activePointerId: number | null = null;
  private pointerDownX = 0;
  private pointerDownValue = 0;
  private barWidth = 0;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;

  // fallow-ignore-next-line unused-class-member -- read from the templateUrl view (`markerPct()`); fallow's member-usage scan doesn't follow external Angular templates.
  readonly markerPct = computed(() => percentInRange(this.value(), this.min(), this.max(), 50));

  readonly valueLabel = computed(() => formatSignedValue(this.value(), this.step(), ''));

  private clamp(v: number): number {
    return Math.min(this.max(), Math.max(this.min(), v));
  }

  private valueAtX(x: number): number {
    if (this.barWidth <= 0) return this.value();
    const lo = this.min();
    const hi = this.max();
    const pct = x / this.barWidth;
    const raw = lo + pct * (hi - lo);
    const step = this.step();
    return this.clamp(Math.round(raw / step) * step);
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
    bar.setPointerCapture(event.pointerId);
    this.dragStart.emit();

    if (this.dragMode() === 'relative') {
      // Relative mode: touch-down parks the starting value without moving
      // it — the gesture's own DELTA drives the value, not the raw pointer
      // position. A long hold before any movement promotes into fine mode
      // for the rest of the gesture.
      this.pointerDownValue = this.value();
      this.longPressTimer = setTimeout(() => {
        this.fineMode.set(true);
        this.fineModeEngaged.emit();
      }, this.longPressMs());
      return;
    }

    this.pointerDownValue = this.valueAtX(this.pointerDownX);
    this.value.set(this.pointerDownValue);
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.dragging() || event.pointerId !== this.activePointerId) return;
    if (this.barWidth <= 0) return;
    const rect = this.barRef.nativeElement.getBoundingClientRect();
    const x = event.clientX - rect.left;

    if (this.dragMode() === 'relative') {
      if (Math.abs(x - this.pointerDownX) > 1 && this.longPressTimer) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = null;
      }
      const dx = x - this.pointerDownX;
      const range = this.max() - this.min();
      const sensitivity = this.fineMode() ? this.fineModeSensitivity() : 1;
      const prev = this.value();
      const next = this.clamp(this.pointerDownValue + (dx / this.barWidth) * range * sensitivity);
      this.value.set(next);
      this.emitGestureHaptics(prev, next);
      return;
    }

    this.value.set(this.valueAtX(x));
  }

  onPointerUp(event: PointerEvent): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.fineMode.set(false);
    const wasTracking = event.pointerId === this.activePointerId;
    endPointerDrag(event, this.activePointerId, this.dragging, () => (this.activePointerId = null));
    if (wasTracking) this.dragEnd.emit();
  }

  onKeydown(event: KeyboardEvent): void {
    const delta = consumeArrowKeyDelta(event, this.step());
    if (delta === null) return;
    this.value.set(this.clamp(this.value() + delta));
  }

  /** Relative-mode gesture milestones ("haptics hooks") — reports crossing
   * zero and reaching an extreme the same way the Pro Editor's own
   * `drag-bar-math.ts` predicates did, generalized from that module's fixed
   * ±100 domain to this component's own `min`/`max`. */
  private emitGestureHaptics(from: number, to: number): void {
    if (didReachExtreme(from, to, this.min(), this.max())) {
      this.reachedExtreme.emit();
    } else if (didCrossZero(from, to)) {
      this.crossedZero.emit();
    }
  }
}
