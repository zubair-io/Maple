// mask-range.ts — the colour-range refinement's UI surface (#362): the five
// continuous controls the panel shows, raw-core's default coordinates the
// enable toggle arms, and the two pure transforms the session applies (a
// slider write, an eyedropper seed).
//
// No Angular, no DOM — the same shape `mask-geometry.ts` has, so the panel
// and its spec exercise the transforms without a fixture.

import type { MaskRangeSeed } from '../../raw-pipeline/raw-pipeline.sample-range.types';
import type { RangeRefinement } from '../../models/local-adjustment';

/** One of the five range sliders. Hue itself is seeded by the eyedropper. */
export type RangeFieldId = Exclude<keyof RangeRefinement, 'kind' | 'hueDeg'>;

export interface RangeControl {
  id: RangeFieldId;
  label: string;
  min: number;
  max: number;
  step: number;
}

/**
 * Slider domains. Oklab chroma of a saturated colour tops out near 0.3; the
 * lightness window and the feather are unit fractions; the half-width is
 * degrees (90° covers a third of the wheel on each side).
 */
export const RANGE_CONTROLS: readonly RangeControl[] = [
  { id: 'hueHalfWidthDeg', label: 'Hue width', min: 1, max: 90, step: 1 },
  { id: 'chromaMin', label: 'Chroma min', min: 0, max: 0.3, step: 0.005 },
  { id: 'lMin', label: 'L min', min: 0, max: 1, step: 0.01 },
  { id: 'lMax', label: 'L max', min: 0, max: 1, step: 0.01 },
  { id: 'feather', label: 'Feather', min: 0, max: 1, step: 0.01 },
];

/**
 * raw-core's default Color coordinates (`SKIN_TONE_RANGE`) — what the enable
 * toggle arms before the eyedropper re-centres it, and the same defaults the
 * XMP readers fill missing coordinates with.
 */
export function defaultRangeRefinement(): RangeRefinement {
  return {
    kind: 'color',
    hueDeg: 55,
    hueHalfWidthDeg: 25,
    chromaMin: 0.02,
    lMin: 0.15,
    lMax: 0.95,
    feather: 0.3,
  };
}

/** `range` with one slider moved; every other coordinate is untouched. */
export function withRangeField(
  range: RangeRefinement,
  field: RangeFieldId,
  value: number,
): RangeRefinement {
  return { ...range, [field]: value };
}

/**
 * `range` re-centred on an eyedropper sample. The band width and the feather
 * are the user's own settings, so a pick never moves them — it answers
 * "which colour", not "how wide".
 */
export function seededRange(range: RangeRefinement, seed: MaskRangeSeed): RangeRefinement {
  return {
    ...range,
    hueDeg: seed.hueDeg,
    chromaMin: seed.chromaMin,
    lMin: seed.lMin,
    lMax: seed.lMax,
  };
}

/** The band centre as people read a hue wheel: `[0, 360)`, not atan2's
 *  `(-180, 180]` the wire carries. */
export function displayHue(hueDeg: number): number {
  const wrapped = hueDeg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}
