// drag-bar.component.ts — responsive-program S5b (#625).
//
// SVG-based drag-bar primitive. 21 ticks at 5% increments, 2pt × 22pt
// accent marker. PointerEvents drive value updates (no touch/mouse fork).
// Long-press the marker → fine mode for the next drag. Double-tap to
// reset to 0. Haptics via EditorStateService.haptic().
//
// Spec: docs/design/responsive-program/s5-editor.md §3.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import { EditorStateService } from './editor-state.service';
import {
  CENTER_TICK_HEIGHT,
  CENTER_TICK_INDEX,
  MARKER_HEIGHT,
  MARKER_WIDTH,
  REGULAR_TICK_HEIGHT,
  TICK_COUNT,
  clamp,
  didCrossZero,
  didReachExtreme,
  markerX,
  tickHeight,
  tickX,
  valueDelta,
} from './drag-bar-math';

const LONG_PRESS_MS = 500;

@Component({
  selector: 'app-drag-bar',
  standalone: true,
  templateUrl: './drag-bar.component.html',
  styleUrl: './drag-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DragBarComponent {
  readonly state = inject(EditorStateService);
  readonly host = inject(ElementRef<HTMLElement>);

  readonly tickIndices = Array.from({ length: TICK_COUNT }, (_, i) => i);
  readonly centerTickIndex = CENTER_TICK_INDEX;
  readonly centerTickHeight = CENTER_TICK_HEIGHT;
  readonly regularTickHeight = REGULAR_TICK_HEIGHT;
  readonly markerWidth = MARKER_WIDTH;
  readonly markerHeight = MARKER_HEIGHT;

  /** Width of the track in CSS pixels, polled on resize and after view init. */
  private readonly _width = signal<number>(0);

  /** Internal value the marker reflects — the service derives it from
   *  the armed (tool, subParam) pair (#1108), so the marker tracks the
   *  armed sub-param's mapping on multi-param tools. */
  readonly internalValue = computed(() => this.state.armedInternalValue());

  readonly markerCx = computed(() => markerX(this.internalValue(), this._width()));

  // Per-tick geometry (re-derived on width change).
  ticksWithLayout = computed(() =>
    this.tickIndices.map((i) => ({
      i,
      x: tickX(i, this._width()),
      h: tickHeight(i),
      center: i === CENTER_TICK_INDEX,
    })),
  );

  // ── Gesture state ────────────────────────────────────────────────────────

  private dragStartValue: number | null = null;
  private dragStartClientX = 0;
  private lastValue = 0;
  private pointerId: number | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Track host resize so the marker position stays in sync. The
    // ResizeObserver holds a strong ref to the host via its callback, so
    // disconnect it explicitly when the effect tears down (route change,
    // component destroy) — relying on GC leaked the host element across
    // editor entries.
    effect((onCleanup) => {
      const el = this.host.nativeElement;
      const ro = new ResizeObserver((entries) => {
        for (const e of entries) this._width.set(e.contentRect.width);
      });
      ro.observe(el);
      this._width.set(el.getBoundingClientRect().width);
      onCleanup(() => ro.disconnect());
    });
  }

  // ── Pointer handlers ─────────────────────────────────────────────────────

  onPointerDown(ev: PointerEvent): void {
    ev.preventDefault();
    // Mirror of Apple DragBar's `allowsHitTesting(armedToolAcceptsValueEdits)`
    // gate: value-less tools (presets, #952 stubs) must not start a
    // gesture — the touch-down `commit()` would push a junk undo
    // snapshot for value writes the service then ignores.
    if (!this.state.armedToolAcceptsValueEdits()) return;
    this.pointerId = ev.pointerId;
    (ev.target as Element).setPointerCapture(ev.pointerId);
    this.dragStartValue = this.internalValue();
    this.dragStartClientX = ev.clientX;
    this.lastValue = this.dragStartValue;
    this.state.commit();
    // Commit-on-release sub-params (Noise → Deep / Prefilter, #1153) park
    // their value for the gesture instead of re-developing per pointer move;
    // for every other tool this is inert.
    this.state.beginGesture();
    this.longPressTimer = setTimeout(() => {
      this.state.fineMode.set(true);
      this.state.haptic('switch');
    }, LONG_PRESS_MS);
  }

  onPointerMove(ev: PointerEvent): void {
    if (this.pointerId !== ev.pointerId || this.dragStartValue === null) return;
    if (Math.abs(ev.movementX) > 1 && this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    const dx = ev.clientX - this.dragStartClientX;
    const sensitivity = this.state.fineMode() ? 'fine' : 'bar';
    const dv = valueDelta(dx, this._width(), sensitivity);
    const newV = clamp(this.dragStartValue + dv);
    this._emitHaptics(this.lastValue, newV);
    this.state.setArmedInternalValue(newV);
    this.lastValue = newV;
  }

  onPointerUp(ev: PointerEvent): void {
    if (this.pointerId !== ev.pointerId) return;
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.pointerId = null;
    this.dragStartValue = null;
    this.state.fineMode.set(false);
    // Release is the commit point for deferred (decode-product) sub-params.
    this.state.endGesture();
    try {
      (ev.target as Element).releasePointerCapture(ev.pointerId);
    } catch {
      /* already released */
    }
  }

  @HostListener('dblclick', ['$event'])
  onDoubleClick(_ev: MouseEvent): void {
    // Route through resetArmedTool so each tool snaps to its canonical
    // default (e.g. Color NR → 25, Sharpen → 40, Temp → 6500), not the
    // internal-zero point that drifts off-default for one-sided tools.
    this.state.resetArmedTool();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _emitHaptics(from: number, to: number): void {
    if (didReachExtreme(from, to)) this.state.haptic('extreme');
    else if (didCrossZero(from, to)) this.state.haptic('zero-cross');
  }
}
