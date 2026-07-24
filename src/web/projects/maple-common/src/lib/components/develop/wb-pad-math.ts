// wb-pad-math.ts — pure math for the WB pad widget (#1540).
// No Angular dependencies — importable by both the component and unit tests.

import { ADJUSTMENT_RANGES } from '../../generated/adjustment-model.generated';

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

/**
 * Rough log-ratio heuristic: estimate a white-balance CORRECTION from an
 * sRGB pixel sample — i.e. "what should the temp/tint sliders read so this
 * sample renders neutral?", not a description of the CCT of the light that
 * lit it.
 *
 * Direction derivation (#1568): Maple's temperature slider is
 * Lightroom-semantics — turning the slider value UP makes the RENDER
 * warmer/redder (R grows relative to B), not cooler. This is the pipeline's
 * own ground truth, pinned by the closed-form grey predictors
 * `temp_warmer_makes_r_gt_b` (temperature=7500 → R>B) and
 * `temp_cooler_makes_b_gt_r` (temperature=5500 → B>R) in
 * `src/raw-pipeline/raw-core/tests/grey_adjustments.rs:306-346`, and
 * documented in the `wb_gains` doc comment in
 * `src/raw-pipeline/raw-core/src/stages/white_balance.rs` ("gain =
 * D65/source_rec2020 ... cooling the image" at low source K).
 *
 * A sampled pixel that is RED-dominant (R > G, log(R/G) > 0) is a pixel the
 * CURRENT white balance is rendering too warm. To neutralize it we must
 * COOL the render, which (per the direction above) means the corrective
 * temperature must be LOWER than 6500 K — the negative of log(R/G), not the
 * positive. (This also happens to match plain CCT convention — redder
 * implies a warmer, lower-Kelvin light source — but the derivation that
 * actually governs the sign here is the render pipeline's own temp→R/B
 * response, not CCT physics in isolation.)
 *
 * Uses log(R/G) to derive a temperature offset from 6500 K (negated — see
 * above) and log(B/G) to derive a tint offset. This is NOT the Robertson
 * CCT method — it is a simple heuristic useful for a quick grey-point
 * picker.
 */
export function rgbToWb(r: number, g: number, b: number): { temperature: number; tint: number } {
  const R = Math.max(r, 1);
  const G = Math.max(g, 1);
  const B = Math.max(b, 1);

  // r/g and b/g ratios (neutral = 1). Negated relative to a naive reading —
  // a red-dominant sample (logRG > 0) needs a LOWER corrective temperature
  // to cool the render back to neutral. See the derivation above.
  const logRG = Math.log(R / G);
  const tempEst = Math.round(6500 - logRG * 4000);
  const tempClamped = Math.min(TEMP_MAX, Math.max(TEMP_MIN, tempEst));

  const logBG = Math.log(B / G);
  const tintEst = Math.round(-logBG * 30);
  const tintClamped = Math.min(TINT_MAX, Math.max(TINT_MIN, tintEst));

  return { temperature: tempClamped, tint: tintClamped };
}
