// drag-bar-math.ts — responsive-program S5b (#625).
//
// Pure value↔pixel math for the drag-bar primitive. Mirror of Apple's
// `DragBarMath` in `src/apple/Packages/MapleCore/Sources/MapleCore/
// Editor/DragBarMath.swift`. Same scale, same sensitivities, same
// haptic predicates — kept identical so a drag of 50pt on a 250pt-wide
// bar moves the marker the same distance on both platforms.
//
// Spec: docs/design/responsive-program/s5-editor.md §3.

export type DragSensitivity = 'bar' | 'canvas' | 'fine';

const SENSITIVITY: Record<DragSensitivity, number> = {
  bar: 1.0,
  canvas: 0.5,
  fine: 0.25,
};

export const VALUE_MIN = -100;
export const VALUE_MAX = 100;

export const TICK_COUNT = 21;
export const CENTER_TICK_INDEX = 10;
export const CENTER_TICK_HEIGHT = 14;
export const REGULAR_TICK_HEIGHT = 6;
export const MARKER_WIDTH = 2;
export const MARKER_HEIGHT = 22;

export function clamp(v: number): number {
  if (v < VALUE_MIN) return VALUE_MIN;
  if (v > VALUE_MAX) return VALUE_MAX;
  return v;
}

export function markerX(value: number, barWidth: number): number {
  const pct = 0.5 + clamp(value) / 200;
  return barWidth * pct;
}

export function valueAtPointerX(x: number, barWidth: number): number {
  if (barWidth <= 0) return 0;
  const pct = x / barWidth;
  return clamp((pct - 0.5) * 200);
}

export function valueDelta(deltaX: number, barWidth: number, sensitivity: DragSensitivity): number {
  if (barWidth <= 0) return 0;
  return (deltaX / barWidth) * 200 * SENSITIVITY[sensitivity];
}

export function tickX(index: number, barWidth: number): number {
  if (index < 0 || index >= TICK_COUNT) {
    throw new Error(`tick index out of range: ${index}`);
  }
  return (barWidth * index) / (TICK_COUNT - 1);
}

export function tickHeight(index: number): number {
  return index === CENTER_TICK_INDEX ? CENTER_TICK_HEIGHT : REGULAR_TICK_HEIGHT;
}

export function didCrossZero(from: number, to: number): boolean {
  return (from < 0 && to >= 0) || (from > 0 && to <= 0) || (from === 0 && to !== 0);
}

export function didReachExtreme(from: number, to: number): boolean {
  return (from > VALUE_MIN && to <= VALUE_MIN) || (from < VALUE_MAX && to >= VALUE_MAX);
}
