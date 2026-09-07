// local-adjustment.ts — hand-written TypeScript mirror of
// `raw_core::types::local_adjustment` (#280/#358/#3300).
//
// `local_adjustments` is deliberately excluded from codegen
// (`raw-core/src/types/adjustment/schema/mod.rs`, `NON_COPYABLE_FIELDS`):
// a layer stack is a nested list, not a flat slider, so the generated
// `AdjustmentModel` never carries it and this mirror is permanent — the
// same generated-fields / hand-written-type split `Crop` and `ToneCurve`
// use. The XMP wire form (`crs:GradientBasedCorrections` /
// `crs:CircularGradientBasedCorrections` / `crs:MaskGroupBasedCorrections`)
// lives in `../xmp/xmp-local-adjustments.ts`; `docs/xmp-canonical-format.md`
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
  /** Oklab hue rotation: ±100 maps to ±30°, stored as ±1 in crs:LocalHue. */
  hue?: number;
}

/** Normalized 2D point: `x` across the width, `y` down from the top edge. */
export interface MaskPoint {
  x: number;
  y: number;
}

/**
 * How a `bitmap` mask's raster was produced (#3271). The raster itself is a
 * derivative keyed by `digest` — never stored in the sidecar — so this
 * records enough to regenerate or invalidate it. Every field is opaque
 * identity data to the pipeline. Mirror of `raw_core::types::BitmapRecipe`.
 */
export interface BitmapRecipe {
  /** Which detected person the selection covers, `0`-indexed. */
  person: number;
  facialSkin: boolean;
  bodySkin: boolean;
  /** Segmentation model identifier, e.g. `apple-vision-person-instance/1`. */
  model: string;
  /**
   * 16 lowercase hex chars — the host-computed digest that names the raster
   * in the render worker's raster registry and in the on-disk cache.
   */
  digest: string;
}

export interface LinearMask {
  kind: 'linear';
  start: MaskPoint;
  end: MaskPoint;
  feather: number;
}

export interface RadialMask {
  kind: 'radial';
  center: MaskPoint;
  radii: MaskPoint;
  angle: number;
  feather: number;
  invert: boolean;
}

export interface BitmapMask {
  kind: 'bitmap';
  recipe: BitmapRecipe;
  /**
   * The registry handle the render actually samples — an in-process id
   * from `RawPipelineService.registerMaskRaster`, never persisted (the
   * sidecar carries only the recipe). `0` means unresolved, which renders
   * as weight 0 rather than silently falling back to `everywhere`.
   */
  rasterId: number;
}

export interface EverywhereMask {
  kind: 'everywhere';
}

/** The two masks with parametric on-canvas geometry (handles, feather). */
export type GeometricMask = LinearMask | RadialMask;

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
 * - `bitmap`: a host-supplied raster (#3271 — a person/skin selection
 *   today), keyed by `rasterId` in the render worker's raster registry;
 *   `recipe` records how to rebuild it.
 * - `everywhere`: weight 1 over the whole frame — the no-person-detected
 *   fallback a range refinement then narrows.
 */
export type LocalMask = LinearMask | RadialMask | BitmapMask | EverywhereMask;

/** True for the two masks the canvas overlay can draw and drag. */
export function isGeometricMask(mask: LocalMask): mask is GeometricMask {
  return mask.kind === 'linear' || mask.kind === 'radial';
}

/** One local-adjustment layer: a mask and the controls it scales. */
export interface LocalAdjustment {
  mask: LocalMask;
  adjustments: PartialAdjustments;
  range?: RangeRefinement;
}

/** Color selection multiplied into the primary mask; mirrors raw-core's Color variant. */
export interface RangeRefinement {
  kind: 'color';
  hueDeg: number;
  hueHalfWidthDeg: number;
  chromaMin: number;
  lMin: number;
  lMax: number;
  feather: number;
}

/** True when no field of `a` is set — the layer would change nothing. */
export function isEmptyPartialAdjustments(a: PartialAdjustments): boolean {
  return (Object.keys(a) as Array<keyof PartialAdjustments>).every((k) => a[k] === undefined);
}
