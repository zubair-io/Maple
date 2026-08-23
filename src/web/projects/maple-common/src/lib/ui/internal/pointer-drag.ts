// Shared pointer-capture drag helpers for the Maple UI molecules that
// implement the "pointerdown hit-test → setPointerCapture →
// pointermove/pointerup on the same element" convention (mui-color-wheel,
// mui-pad-2d, mui-drag-bar, mui-living-slider — unified-component-catalog.md
// §2.1). Not part of the public API surface (see ../public-api.ts).

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
