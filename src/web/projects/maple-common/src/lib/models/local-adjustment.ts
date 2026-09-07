// local-adjustment.ts — hand-written TypeScript mirror of
// `raw_core::types::local_adjustment` (#280/#358).
//
// `local_adjustments` is deliberately excluded from codegen
// (`raw-core/src/types/adjustment/schema/mod.rs`, `NON_COPYABLE_FIELDS`):
// a layer stack is a nested list, not a flat slider, so the generated
// `AdjustmentModel` never carries it and this mirror is permanent — the
// same generated-fields / hand-written-type split `Crop` and `ToneCurve`
// use. The XMP wire form (`crs:GradientBasedCorrections` /
// `crs:CircularGradientBasedCorrections`) lives in
// `../xmp/xmp-local-adjustments.ts`; `docs/xmp-canonical-format.md`
// § "Local adjustments" is the contract.
//
// Coordinates are normalized to `[0, 1]` on each axis, origin top-left,
// independent of pixel dimensions — the same convention `Crop` uses — so
// one sidecar renders identically against full-res and downsampled buffers.

/**
 * The subset of develop controls a mask can apply locally. Mirror of
 * `raw_core::types::PartialAdjustments`: an absent field is a true no-op
 * ("do not apply this control here"), which is NOT the same as `0` —
 * `saturation`/`vibrance` at `0` still round-trip the pixel through Oklab,
 * and `temperature`/`tint` being present at all engages a CAT16 matrix.
 */
export interface PartialAdjustments {
  exposure?: number;
  contrast?: number;
  highlights?: number;
  shadows?: number;
  whites?: number;
  blacks?: number;
  saturation?: number;
  vibrance?: number;
  temperature?: number;
  tint?: number;
  /**
   * Oklab hue rotation, −100…100 → ±30° (#3269, `crs:LocalHue`). Applied
   * after `blacks` and before `saturation`, reusing saturation's soft-knee
   * gamut handling.
   */
  hue?: number;
}

/** Normalized 2D point: `x` across the width, `y` down from the top edge. */
export interface MaskPoint {
  x: number;
  y: number;
}

/**
 * Mask shape — the per-pixel weight `w ∈ [0, 1]` a layer is scaled by.
 * Mirror of `raw_core::types::Mask`.
 *
 * - `linear`: a straight gradient. `start`'s side of the perpendicular
 *   bisector sees `w = 0`, `end`'s side `w = 1`; `feather` is the
 *   smoothstep width as a fraction of the gradient length.
 * - `radial`: an ellipse with half-axes `radii`, rotated by `angle`
 *   radians about `center`. Inside `w = 1`, outside `w = 0`; `feather` is
 *   a fraction of the radius. `invert` flips the sense (Lightroom's
 *   "Invert" toggle).
 */
export type LocalMask =
  | { kind: 'linear'; start: MaskPoint; end: MaskPoint; feather: number }
  | {
      kind: 'radial';
      center: MaskPoint;
      radii: MaskPoint;
      angle: number;
      feather: number;
      invert: boolean;
    };

/**
 * An optional colour-range gate multiplied into the mask weight (#3270) — an
 * Oklab hue band with chroma and lightness gates, so "the skin in this
 * gradient" is one layer rather than a hand-painted mask. Mirror of
 * `raw_core::types::RangeRefinement`; one variant today, discriminated the
 * same way `LocalMask` is so a second shape slots in beside it.
 */
export type RangeRefinement = {
  kind: 'color';
  hueDeg: number;
  hueHalfWidthDeg: number;
  chromaMin: number;
  lMin: number;
  lMax: number;
  feather: number;
};

/**
 * The skin preset (`raw_core::types::SKIN_TONE_RANGE`, spec §5.2) — also
 * what a `papp:Range*` attribute missing from a sidecar falls back to, so
 * the reader and the preset cannot drift apart.
 */
export const SKIN_TONE_RANGE: RangeRefinement = {
  kind: 'color',
  hueDeg: 55,
  hueHalfWidthDeg: 25,
  chromaMin: 0.02,
  lMin: 0.15,
  lMax: 0.95,
  feather: 0.3,
};

/**
 * One local-adjustment layer: a mask, an optional colour-range refinement,
 * and the controls they scale. An absent `range` means the primary mask
 * alone.
 */
export interface LocalAdjustment {
  mask: LocalMask;
  range?: RangeRefinement;
  adjustments: PartialAdjustments;
}

/** True when no field of `a` is set — the layer would change nothing. */
export function isEmptyPartialAdjustments(a: PartialAdjustments): boolean {
  return (Object.keys(a) as Array<keyof PartialAdjustments>).every((k) => a[k] === undefined);
}
