// gradient-catalog.ts — CSS linear-gradient map for every wired ToolId
// and its primary sub-param. Used by LivingSliderComponent to paint the
// track with the tool's characteristic colour ramp.
//
// Stop values are pending the final design import from primitives.jsx (GRAD
// constants); these are recognisable placeholders derived from the token
// palette. The TODO below is an intentional design-handoff marker, kept until
// the import lands.
//
// TODO: replace placeholder stop colours with the exact values from
// _design-reference/lib/primitives.jsx GRAD constants (#1535 follow-up).

import type { ToolId } from '../../editor/tool-model';

/** Sub-param ids that carry their own gradient override. */
export type SubParamGradientKey = string;

/** Gradient entry: a CSS `linear-gradient(...)` value string. */
export type GradientValue = string;

/** Neutral fallback so the function is total even for an unmapped tool id. */
const DEFAULT_GRADIENT: GradientValue = 'linear-gradient(90deg, #4a443b 0%, #a8a097 100%)';

// ── Tool gradients (primary drag-bar) ─────────────────────────────────────
const TOOL_GRADIENTS: Record<ToolId, GradientValue> = {
  // Light group
  exposure: 'linear-gradient(90deg, #0b0a08 0%, #f2efe9 100%)',
  brightness: 'linear-gradient(90deg, #6e675e 0%, #f2efe9 100%)',
  contrast: 'linear-gradient(90deg, #6e675e 0%, #f2efe9 100%)',
  highlights: 'linear-gradient(90deg, #9b958c 0%, #ffffff 100%)',
  shadows: 'linear-gradient(90deg, #000000 0%, #9b958c 100%)',
  whites: 'linear-gradient(90deg, #d8d4cc 0%, #ffffff 100%)',
  blacks: 'linear-gradient(90deg, #000000 0%, #3a352f 100%)',

  // Color group
  temp: 'linear-gradient(90deg, #3b6fb0 0%, #e8a33d 100%)',
  tint: 'linear-gradient(90deg, #3fae6a 0%, #c64fb0 100%)',
  vibrance: 'linear-gradient(90deg, #6e675e 0%, #4a9fc4 100%)',
  saturation: 'linear-gradient(90deg, #6e675e 0%, #c4493a 100%)',
  hsl: 'linear-gradient(90deg, #c4493a 0%, #e8a33d 33%, #3fae6a 66%, #3b6fb0 100%)',
  // Black & white (#276) — grayscale ramp, distinct from HSL's hue-band
  // ramp above (the two are mutually exclusive views on the same 8-band
  // Oklab stage).
  bwMix: 'linear-gradient(90deg, #0b0a08 0%, #6e675e 50%, #f2efe9 100%)',

  // Effects group
  clarity: 'linear-gradient(90deg, #4a443b 0%, #a8a097 100%)',
  texture: 'linear-gradient(90deg, #4a443b 0%, #a8a097 100%)',
  dehaze: 'linear-gradient(90deg, #4a443b 0%, #a8a097 100%)',
  vignette: 'linear-gradient(90deg, #08070a 0%, #6e675e 50%, #08070a 100%)',
  grain: 'linear-gradient(90deg, #1d1b17 0%, #a8a097 100%)',
  colorGrade: 'linear-gradient(90deg, #3b6fb0 0%, #a8a097 50%, #c4493a 100%)',

  // Detail group
  sharpen: 'linear-gradient(90deg, #4a443b 0%, #f2efe9 100%)',
  noise: 'linear-gradient(90deg, #4a443b 0%, #f2efe9 100%)',
  colorNR: 'linear-gradient(90deg, #4a443b 0%, #4a9fc4 100%)',

  // Non-slider tools — these appear as group chips or special controls;
  // they get a neutral gradient as a safety fallback.
  crop: 'linear-gradient(90deg, #4a443b 0%, #a8a097 100%)',
  presets: 'linear-gradient(90deg, #4a443b 0%, #a8a097 100%)',
};

// ── Sub-param gradient overrides ──────────────────────────────────────────
// Keys are `<toolId>/<subParamId>`. Omitting an entry falls back to the
// tool's primary gradient above.
const SUB_PARAM_GRADIENTS: Record<SubParamGradientKey, GradientValue> = {
  // Vignette sub-params
  'vignette/amount': 'linear-gradient(90deg, #08070a 0%, #6e675e 50%, #08070a 100%)',
  'vignette/feather': 'linear-gradient(90deg, #08070a 0%, #a8a097 100%)',

  // Grain sub-params
  'grain/amount': 'linear-gradient(90deg, #1d1b17 0%, #a8a097 100%)',
  'grain/size': 'linear-gradient(90deg, #1d1b17 0%, #f2efe9 100%)',
  'grain/roughness': 'linear-gradient(90deg, #1d1b17 0%, #6e675e 100%)',

  // Sharpen sub-params
  'sharpen/amount': 'linear-gradient(90deg, #4a443b 0%, #f2efe9 100%)',
  'sharpen/radius': 'linear-gradient(90deg, #4a443b 0%, #a8a097 100%)',
  'sharpen/detail': 'linear-gradient(90deg, #4a443b 0%, #f2efe9 100%)',
  'sharpen/masking': 'linear-gradient(90deg, #08070a 0%, #a8a097 100%)',

  // Noise (luminance) sub-params
  'noise/luminance': 'linear-gradient(90deg, #4a443b 0%, #f2efe9 100%)',
  'noise/detail': 'linear-gradient(90deg, #4a443b 0%, #a8a097 100%)',
  'noise/contrast': 'linear-gradient(90deg, #4a443b 0%, #6e675e 100%)',

  // Color NR sub-params
  'colorNR/color': 'linear-gradient(90deg, #4a443b 0%, #4a9fc4 100%)',
  'colorNR/colorDetail': 'linear-gradient(90deg, #4a443b 0%, #3b6fb0 100%)',
  'colorNR/colorSmoothness': 'linear-gradient(90deg, #4a443b 0%, #a8a097 100%)',
};

/**
 * Return the CSS gradient string for a given tool (and optional sub-param).
 * Always returns a valid gradient — never undefined.
 */
export function gradientFor(toolId: ToolId, subParamId?: string | null): GradientValue {
  if (subParamId) {
    const key: SubParamGradientKey = `${toolId}/${subParamId}`;
    const override = SUB_PARAM_GRADIENTS[key];
    if (override) return override;
  }
  return TOOL_GRADIENTS[toolId] ?? DEFAULT_GRADIENT;
}

/**
 * All wired tool ids that have a non-fallback gradient entry.
 * Used by the completeness unit-test to ensure every ToolId is covered.
 */
export function allGradientToolIds(): readonly ToolId[] {
  return Object.keys(TOOL_GRADIENTS) as ToolId[];
}
