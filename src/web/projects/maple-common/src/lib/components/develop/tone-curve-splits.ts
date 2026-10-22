// tone-curve-splits.ts — parametric split-point clamping + active-region
// window shading for the Tone Curve editor (#5039).
//
// Pure math mirroring `raw_core::stages::tone_curves::parametric`
// (`ordered_splits`, `region_centres`, `region_windows`) plus the #5039 UI
// authoring clamps so interactive diamond handles can never cross, collapse,
// or enter degenerate edge intervals.

export type ParametricSplitHandle = 'shadow' | 'midtone' | 'highlight';

export type ParametricRegionId =
  | 'parametricShadows'
  | 'parametricDarks'
  | 'parametricLights'
  | 'parametricHighlights';

export const DEFAULT_SHADOW_SPLIT = 25;
export const DEFAULT_MIDTONE_SPLIT = 50;
export const DEFAULT_HIGHLIGHT_SPLIT = 75;
const MIN_SPLIT_UI_GAP = 5;
const AXIS_TOP = 105.92414;

export function defaultSplitValue(handle: ParametricSplitHandle): number {
  switch (handle) {
    case 'shadow':
      return DEFAULT_SHADOW_SPLIT;
    case 'midtone':
      return DEFAULT_MIDTONE_SPLIT;
    case 'highlight':
      return DEFAULT_HIGHLIGHT_SPLIT;
  }
}

/**
 * Clamp a proposed split-handle drag value against the current triplet
 * using the #5039 UI authoring bounds:
 * - shadow: `[10, min(70, midtone - 5)]`
 * - midtone: `[max(20, shadow + 5), min(80, highlight - 5)]`
 * - highlight: `[max(30, midtone + 5), 90]`
 */
export function clampParametricSplit(
  handle: ParametricSplitHandle,
  proposed: number,
  shadow: number,
  midtone: number,
  highlight: number,
): number {
  const val = Number.isFinite(proposed) ? proposed : defaultSplitValue(handle);
  switch (handle) {
    case 'shadow': {
      const hi = Math.max(10, Math.min(70, midtone - MIN_SPLIT_UI_GAP));
      return Math.round(Math.min(Math.max(val, 10), hi));
    }
    case 'midtone': {
      const lo = Math.min(80, Math.max(20, shadow + MIN_SPLIT_UI_GAP));
      const hi = Math.max(lo, Math.min(80, highlight - MIN_SPLIT_UI_GAP));
      return Math.round(Math.min(Math.max(val, lo), hi));
    }
    case 'highlight': {
      const lo = Math.min(90, Math.max(30, midtone + MIN_SPLIT_UI_GAP));
      const hi = Math.max(lo, 90);
      return Math.round(Math.min(Math.max(val, lo), hi));
    }
  }
}

/**
 * Repair an arbitrary (possibly hand-edited) split triplet into strictly
 * ordered `[0, 100]` coordinates with at least 1 axis unit gap, matching
 * `raw_core::stages::tone_curves::parametric::ordered_splits`.
 */
export function orderedSplits(
  shadow: number,
  midtone: number,
  highlight: number,
): readonly [number, number, number] {
  const minSplitGap = 1.0;
  const m = Math.min(Math.max(midtone, 2 * minSplitGap), 100 - 2 * minSplitGap);
  const s = Math.min(Math.max(shadow, minSplitGap), m - minSplitGap);
  const h = Math.min(Math.max(highlight, m + minSplitGap), 100 - minSplitGap);
  return [s, m, h] as const;
}

/**
 * The four region centres in `[0, 100]` axis units for a split triplet,
 * ordered `[shadows, darks, lights, highlights]`.
 */
export function regionCentres(
  shadow: number,
  midtone: number,
  highlight: number,
): readonly [number, number, number, number] {
  const [s, m, h] = orderedSplits(shadow, midtone, highlight);
  return [s * 0.5, (s + m) * 0.5, (m + h) * 0.5, (h + 100) * 0.5] as const;
}

function smoothstep(a: number, b: number, p: number): number {
  if (b <= a) return p >= b ? 1 : 0;
  const t = Math.min(Math.max((p - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Evaluate the four smoothstep region weights `[w_shadows, w_darks,
 * w_lights, w_highlights]` at axis coordinate `p` in `[0, 100]`, matching
 * `parametric::region_windows`.
 */
export function regionWindows(
  p: number,
  shadow: number,
  midtone: number,
  highlight: number,
): readonly [number, number, number, number] {
  const c = regionCentres(shadow, midtone, highlight);
  const s01 = smoothstep(c[0], c[1], p);
  const s12 = smoothstep(c[1], c[2], p);
  const s23 = smoothstep(c[2], c[3], p);
  const s3t = smoothstep(c[3], AXIS_TOP, p);
  return [1 - s01, s01 - s12, s12 - s23, s23 - s3t] as const;
}

export function regionIndex(region: ParametricRegionId): 0 | 1 | 2 | 3 {
  switch (region) {
    case 'parametricShadows':
      return 0;
    case 'parametricDarks':
      return 1;
    case 'parametricLights':
      return 2;
    case 'parametricHighlights':
      return 3;
  }
}

export function regionForSplitHandle(handle: ParametricSplitHandle): ParametricRegionId {
  switch (handle) {
    case 'shadow':
      return 'parametricShadows';
    case 'midtone':
      return 'parametricDarks';
    case 'highlight':
      return 'parametricHighlights';
  }
}

/**
 * Build an SVG polygon path (`d` attribute) in `plotSize × plotSize` user
 * space representing the active region's smoothstep window envelope rising
 * from the bottom axis (`y = plotSize`).
 */
export function activeRegionWindowPath(
  region: ParametricRegionId,
  shadow: number,
  midtone: number,
  highlight: number,
  plotSize: number,
  samples = 64,
): string {
  const idx = regionIndex(region);
  const count = Math.max(2, samples);
  const pts: string[] = [];
  for (let i = 0; i <= count; i++) {
    const u = i / count;
    const w = Math.max(0, Math.min(1, regionWindows(u * 100, shadow, midtone, highlight)[idx]));
    const x = (u * plotSize).toFixed(2);
    const y = (plotSize - w * plotSize * 0.35).toFixed(2);
    pts.push(`${x} ${y}`);
  }
  return `M 0 ${plotSize} L ${pts.join(' L ')} L ${plotSize} ${plotSize} Z`;
}
