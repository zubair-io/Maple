// Shared pan-down-to-dismiss drag math for the Maple UI bottom-sheet shells
// (BottomSheetComponent, mui-sheet-shell — unified-component-catalog.md §5;
// mui-sheet-shell is the design-system generalization of the phone-tier
// BottomSheetComponent, same drag-area/grab-handle/dismiss-threshold
// contract). Not part of the public API surface (see ../public-api.ts).

import type { WritableSignal } from '@angular/core';

/** True when a `pointerdown` on the drag area should be ignored — a
 * secondary mouse button, not the primary pointer/touch that starts a
 * drag. */
export function shouldIgnoreSheetPointerDown(event: PointerEvent): boolean {
  return event.button !== 0 && event.pointerType === 'mouse';
}

/** Clamps a drag's vertical offset to pan-down-only: these sheets dismiss
 * by dragging down, so an upward drag is a no-op or the sheet held closed.
 * Used by {@link updateSheetDragOffset}. */
function clampPanDown(dy: number): number {
  return dy > 0 ? dy : 0;
}

/** Shared `pointerdown` body once the caller has resolved its own
 * `pointerId`/`dragStartY` (and, for BottomSheetComponent, its extra
 * velocity-sample fields): flips into the dragging state and captures the
 * pointer on the listener-bound element (`.drag-area`), not the raw event
 * target — `event.target` may be a nested node (e.g. the grab handle) and
 * `setPointerCapture` on that node won't deliver subsequent move/up events
 * to this handler reliably. */
export function beginSheetDrag(
  event: PointerEvent,
  isDragging: WritableSignal<boolean>,
  dragOffsetPx: WritableSignal<number>,
): void {
  isDragging.set(true);
  dragOffsetPx.set(0);
  (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
}

/** Shared `pointermove` body: applies the pan-down-clamped offset only if
 * `event` is the pointer the host is currently tracking. Returns whether it
 * applied, so BottomSheetComponent can additionally update its
 * velocity-sample fields when (and only when) it does. */
export function updateSheetDragOffset(
  event: PointerEvent,
  activePointerId: number | null,
  dragStartY: number,
  dragOffsetPx: WritableSignal<number>,
): boolean {
  if (activePointerId !== event.pointerId) return false;
  dragOffsetPx.set(clampPanDown(event.clientY - dragStartY));
  return true;
}

/** True once a pan-down drag has crossed the dismiss distance — `dy` (the
 * pan-down offset) at least `fraction` of the sheet's own height. `false`
 * for a not-yet-measured (zero-height) sheet. */
export function isDistanceDismissed(dy: number, sheetHeight: number, fraction: number): boolean {
  return sheetHeight > 0 && dy >= sheetHeight * fraction;
}

/** Below this elapsed time (ms), a velocity reading isn't trusted — no real
 * drag produces same-millisecond pointer samples, so a `dt` this small is a
 * measurement artifact (e.g. two synthetic events constructed back-to-back
 * in a test, which share one `performance.now()`-derived `timeStamp`), not
 * a genuine flick. */
const MIN_VELOCITY_SAMPLE_MS = 8;

/** True once a pan-down flick's release velocity crosses `threshold`
 * (px/s) — a fast short flick dismisses even short of the distance
 * threshold above. `dy`/`dt` are the release-relative delta over whichever
 * sample window the caller measured (BottomSheetComponent / mui-sheet-shell
 * both use the last ~100ms, falling back to the whole drag when it was
 * shorter than that). `dt` below {@link MIN_VELOCITY_SAMPLE_MS} never
 * dismisses — see its doc comment. */
export function isVelocityDismissed(dy: number, dt: number, threshold: number): boolean {
  if (dt < MIN_VELOCITY_SAMPLE_MS) return false;
  const pxPerSecond = (dy / dt) * 1000;
  return pxPerSecond >= threshold;
}
