// Re-export GLSL sources as raw strings so the Pipeline class
// can compile them. The `?raw` import suffix is honored by
// @angular/build's Vite-based loader (and by ng-packagr when the
// library is consumed downstream).
//
// Plan 3 M2.1 — see docs/superpowers/plans/2026-04-25-plan-3-m2-webgl-shaders.md.

import vertexSource from './vertex.glsl?raw';
import whiteBalanceSource from './white-balance.frag?raw';
import sceneToneControlsSource from './scene-tone-controls.frag?raw';
import sceneVibranceSource from './scene-vibrance.frag?raw';
import sceneSaturationSource from './scene-saturation.frag?raw';
import agxViewTransformSource from './agx-view-transform.frag?raw';

export const SHADERS = {
  vertex: vertexSource,
  whiteBalance: whiteBalanceSource,
  sceneToneControls: sceneToneControlsSource,
  sceneVibrance: sceneVibranceSource,
  sceneSaturation: sceneSaturationSource,
  agxViewTransform: agxViewTransformSource,
} as const;

export type ShaderKey = keyof typeof SHADERS;
