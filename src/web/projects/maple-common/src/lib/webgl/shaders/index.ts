// Re-export GLSL sources as raw strings so the Pipeline class can
// compile them. Each shader source lives in a sibling .ts file
// (template-literal-shipped) — see vertex.ts for the rationale.
//
// Plan 3 M2.1 — see docs/superpowers/plans/2026-04-25-plan-3-m2-webgl-shaders.md.

import { VERTEX_SHADER_SOURCE } from './vertex';
import { WHITE_BALANCE_FRAGMENT_SOURCE } from './white-balance';
import { SCENE_TONE_CONTROLS_FRAGMENT_SOURCE } from './scene-tone-controls';
import { SCENE_VIBRANCE_FRAGMENT_SOURCE } from './scene-vibrance';
import { SCENE_SATURATION_FRAGMENT_SOURCE } from './scene-saturation';
import { AGX_VIEW_TRANSFORM_FRAGMENT_SOURCE } from './agx-view-transform';

export const SHADERS = {
  vertex: VERTEX_SHADER_SOURCE,
  whiteBalance: WHITE_BALANCE_FRAGMENT_SOURCE,
  sceneToneControls: SCENE_TONE_CONTROLS_FRAGMENT_SOURCE,
  sceneVibrance: SCENE_VIBRANCE_FRAGMENT_SOURCE,
  sceneSaturation: SCENE_SATURATION_FRAGMENT_SOURCE,
  agxViewTransform: AGX_VIEW_TRANSFORM_FRAGMENT_SOURCE,
} as const;

export type ShaderKey = keyof typeof SHADERS;
