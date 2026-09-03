// wb-pad-math.ts — pure math for the WB pad widget (#1540).
// No Angular dependencies — importable by both the component and unit tests.

import { ADJUSTMENT_RANGES } from '../../generated/adjustment-tables.generated';

const TEMP_MIN = ADJUSTMENT_RANGES.temperature[0];
const TEMP_MAX = ADJUSTMENT_RANGES.temperature[1];
const TINT_MIN = ADJUSTMENT_RANGES.tint[0];
const TINT_MAX = ADJUSTMENT_RANGES.tint[1];

/** Map pad X [0..1] → temperature K. */
export function xToTemp(x: number): number {
  return Math.round(TEMP_MIN + x * (TEMP_MAX - TEMP_MIN));
}

/** Map temperature K → pad X [0..1]. Clamped so out-of-range values stay on the pad. */
export function tempToX(temp: number): number {
  return Math.max(0, Math.min(1, (temp - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)));
}

/** Map pad Y [0..1] (0 = bottom = green, 1 = top = magenta) → tint. */
export function yToTint(y: number): number {
  return Math.round(TINT_MIN + y * (TINT_MAX - TINT_MIN));
}

/** Map tint → pad Y [0..1]. Clamped so out-of-range values stay on the pad. */
export function tintToY(tint: number): number {
  return Math.max(0, Math.min(1, (tint - TINT_MIN) / (TINT_MAX - TINT_MIN)));
}
