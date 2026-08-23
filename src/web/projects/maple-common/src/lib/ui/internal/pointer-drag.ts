// Shared pointer-capture drag helpers for the Maple UI molecules that
// implement the "pointerdown hit-test → setPointerCapture →
// pointermove/pointerup on the same element" convention (mui-color-wheel,
// mui-pad-2d, mui-drag-bar, mui-living-slider — unified-component-catalog.md
// §2.1). Not part of the public API surface (see ../public-api.ts).

import { Directive, type WritableSignal, signal } from '@angular/core';

/** True while a drag started by `event`'s pointer is still the one the host
 * is tracking — the guard every `pointermove` handler needs before applying
 * the moved value. */
export function isPointerDragMove(
  dragging: boolean,
  event: PointerEvent,
  activePointerId: number | null,
): boolean {
  return dragging && event.pointerId === activePointerId;
}

/** True when `event` ends the drag the host is currently tracking — the
 * guard every `pointerup`/`pointercancel` handler needs before clearing
 * drag state. */
export function isPointerDragEnd(event: PointerEvent, activePointerId: number | null): boolean {
  return event.pointerId === activePointerId;
}

/** Standard `pointerup` handler body shared by every pointer-capture-drag
 * molecule (mui-color-wheel, mui-pad-2d, mui-drag-bar, mui-living-slider):
 * ends the drag — via the `dragging` signal — only if `event` is the
 * pointer the host is currently tracking, then clears the tracked pointer
 * id through `clearActivePointerId` (a plain class field on every caller,
 * not a signal, hence the callback rather than a `WritableSignal`). */
export function endPointerDrag(
  event: PointerEvent,
  activePointerId: number | null,
  dragging: WritableSignal<boolean>,
  clearActivePointerId: () => void,
): void {
  if (!isPointerDragEnd(event, activePointerId)) return;
  dragging.set(false);
  clearActivePointerId();
}

/** Converts an arrow-key press into a signed step delta along the control's
 * axis (`ArrowLeft`/`ArrowDown` decrease, `ArrowRight`/`ArrowUp` increase);
 * `null` for any other key, so the caller can early-return. */
export function arrowKeyDelta(key: string, step: number): number | null {
  if (key === 'ArrowLeft' || key === 'ArrowDown') return -step;
  if (key === 'ArrowRight' || key === 'ArrowUp') return step;
  return null;
}

/** Maps a value's position within `[min, max]` to a `[0, 100]` percentage —
 * the shared `thumbPct`/`markerPct`/`trackPct` calc for the scrub controls.
 * `fallbackPct` covers the degenerate `min === max` case each control
 * defaults differently (a centered thumb vs. an empty track). */
export function percentInRange(
  value: number,
  min: number,
  max: number,
  fallbackPct: number,
): number {
  if (max === min) return fallbackPct;
  return ((value - min) / (max - min)) * 100;
}

/** Formats a scrub control's numeric value with an explicit `+` sign for
 * positive values and an optional unit suffix — the shared `valueLabel`
 * readout for mui-living-slider and mui-slider. Decimal precision scales
 * with the control's step size (sub-0.1 steps show 2 decimals, sub-1 steps
 * show 1, whole steps show none). */
export function formatSignedValue(value: number, step: number, unit: string): string {
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const formatted = value.toFixed(decimals);
  const signed = value > 0 ? `+${formatted}` : formatted;
  return unit ? `${signed} ${unit}` : signed;
}

/** Full "pointerdown hit-test → setPointerCapture → pointermove/pointerup
 * on the same element" wiring for a draggable 1- or 2-D puck whose value
 * comes straight from the pointer position (mui-color-wheel, mui-pad-2d —
 * both hit-test their own root element, capture, and derive `T` from the
 * event the same way; mui-drag-bar/mui-living-slider don't fit this exact
 * shape since their `onPointerMove` reads a `barWidth`/track ref computed
 * once up front rather than re-hit-testing an element each move). An
 * `@Directive()` abstract base (Angular's supported pattern for sharing
 * component behavior without a template — same shape as
 * `DestructiveConfirmDialogBase`), not a fourth free-function copy each
 * subclass re-wires by hand: `onPointerDown`/`onPointerMove`/`onPointerUp`
 * were already byte-identical modulo the drag element and the value math.
 * Each subclass supplies `dragElement()` (its own `ViewChild`'s
 * `nativeElement`), `disabledInput()`, and `valueFromEvent()`; `value` stays
 * each subclass's own `model()` (different per-control defaults) but must
 * be assigned before this base's constructor runs — model()/signal() field
 * initializers run in declaration order across the whole prototype chain,
 * and this base never reads `value` until a pointer event fires. */
@Directive()
export abstract class PointerCaptureDragBase<T> {
  readonly dragging = signal(false);
  protected activePointerId: number | null = null;

  protected abstract readonly value: WritableSignal<T>;

  protected abstract disabledInput(): boolean;
  protected abstract dragElement(): HTMLElement | undefined;
  protected abstract valueFromEvent(event: PointerEvent): T;

  onPointerDown(event: PointerEvent): void {
    if (this.disabledInput() || event.button !== 0) return;
    const el = this.dragElement();
    if (!el) return;
    this.dragging.set(true);
    this.activePointerId = event.pointerId;
    el.setPointerCapture(event.pointerId);
    this.value.set(this.valueFromEvent(event));
  }

  onPointerMove(event: PointerEvent): void {
    if (!isPointerDragMove(this.dragging(), event, this.activePointerId)) return;
    this.value.set(this.valueFromEvent(event));
  }

  onPointerUp(event: PointerEvent): void {
    endPointerDrag(event, this.activePointerId, this.dragging, () => (this.activePointerId = null));
  }
}
