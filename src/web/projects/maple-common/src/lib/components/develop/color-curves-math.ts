import {
  isIdentityToneCurve,
  type AdjustmentModel,
  type ToneCurve,
  type ToneCurvePoint,
} from '../../models/adjustment-model';
import type { ColorCurveSampleResult } from '../../raw-pipeline/raw-pipeline.sample-range.types';

export type ColorCurveId =
  | 'hueVsHue'
  | 'hueVsSat'
  | 'hueVsLuma'
  | 'lumaVsSat'
  | 'satVsSat'
  | 'satVsLuma';

export type ColorCurveField =
  | 'colorCurveHueVsHue'
  | 'colorCurveHueVsSat'
  | 'colorCurveHueVsLuma'
  | 'colorCurveLumaVsSat'
  | 'colorCurveSatVsSat'
  | 'colorCurveSatVsLuma';

export interface ColorCurveDescriptor {
  readonly id: ColorCurveId;
  readonly shortLabel: string;
  readonly title: string;
  readonly field: ColorCurveField;
  readonly isPeriodic: boolean;
}

export const COLOR_CURVES: readonly ColorCurveDescriptor[] = [
  {
    id: 'hueVsHue',
    shortLabel: 'H vs H',
    title: 'Hue vs Hue',
    field: 'colorCurveHueVsHue',
    isPeriodic: true,
  },
  {
    id: 'hueVsSat',
    shortLabel: 'H vs S',
    title: 'Hue vs Sat',
    field: 'colorCurveHueVsSat',
    isPeriodic: true,
  },
  {
    id: 'hueVsLuma',
    shortLabel: 'H vs L',
    title: 'Hue vs Luma',
    field: 'colorCurveHueVsLuma',
    isPeriodic: true,
  },
  {
    id: 'lumaVsSat',
    shortLabel: 'L vs S',
    title: 'Luma vs Sat',
    field: 'colorCurveLumaVsSat',
    isPeriodic: false,
  },
  {
    id: 'satVsSat',
    shortLabel: 'S vs S',
    title: 'Sat vs Sat',
    field: 'colorCurveSatVsSat',
    isPeriodic: false,
  },
  {
    id: 'satVsLuma',
    shortLabel: 'S vs L',
    title: 'Sat vs Luma',
    field: 'colorCurveSatVsLuma',
    isPeriodic: false,
  },
] as const;

export interface QuickHueAnchor {
  readonly id: string;
  readonly label: string;
  readonly deg: number;
  readonly color: string;
}

export const QUICK_HUE_ANCHORS: readonly QuickHueAnchor[] = [
  { id: 'red', label: 'Red', deg: 29, color: '#c4493a' },
  { id: 'yellow', label: 'Yellow', deg: 110, color: '#e3d24a' },
  { id: 'green', label: 'Green', deg: 142, color: '#3fae6a' },
  { id: 'cyan', label: 'Cyan', deg: 195, color: '#45b6c4' },
  { id: 'blue', label: 'Blue', deg: 264, color: '#3b6fb0' },
  { id: 'magenta', label: 'Magenta', deg: 328, color: '#c64fb0' },
] as const;

export const SKIN_TONE_GUARD_DEG: readonly number[] = [38, 55, 72] as const;

export function anyColorCurveModified(adj: AdjustmentModel | null): boolean {
  if (!adj) return false;
  return COLOR_CURVES.some((d) => !isIdentityToneCurve(adj[d.field]));
}

export function sampleXForCurve(
  desc: ColorCurveDescriptor,
  sample: ColorCurveSampleResult,
): number {
  if (desc.isPeriodic) return sample.uH;
  if (desc.id === 'lumaVsSat') return sample.uL;
  return sample.uC;
}

export function insertColorCurveAnchor(curve: ToneCurve, x: number, y = 0.5): ToneCurve {
  const clampedX = Math.min(1, Math.max(0, x));
  const clampedY = Math.min(1, Math.max(0, y));
  const pts: ToneCurvePoint[] = curve.points.map((p: ToneCurvePoint) => [p[0], p[1]]);
  const idx = pts.findIndex((p: ToneCurvePoint) => Math.abs(p[0] - clampedX) < 0.015);
  if (idx >= 0) {
    pts[idx] = [clampedX, clampedY];
  } else {
    pts.push([clampedX, clampedY]);
  }
  pts.sort((a: ToneCurvePoint, b: ToneCurvePoint) => a[0] - b[0]);
  return { points: pts };
}

export function lockSkinToneCurve(desc: ColorCurveDescriptor, curve: ToneCurve): ToneCurve {
  if (!desc.isPeriodic) return curve;
  const pts: ToneCurvePoint[] = curve.points.map((p: ToneCurvePoint) => [p[0], p[1]]);
  for (const deg of SKIN_TONE_GUARD_DEG) {
    const x = deg / 360;
    if (!pts.some((p: ToneCurvePoint) => Math.abs(p[0] - x) < 0.015)) {
      pts.push([x, 0.5]);
    }
  }
  pts.sort((a: ToneCurvePoint, b: ToneCurvePoint) => a[0] - b[0]);
  return { points: pts };
}

/**
 * Clamps `proposedY` to `[0, 1]`, and for `Hue vs Hue` enforces the
 * non-folding slope limit `|dy| <= 2.5 * dx` against immediate neighbors
 * (including wrap-around across x = 0 / 1) so output hue stays monotonic.
 */
export function clampColorCurveY(
  desc: ColorCurveDescriptor,
  x: number,
  proposedY: number,
  points: readonly ToneCurvePoint[],
  excludingIndex?: number,
): number {
  let lo = 0;
  let hi = 1;
  if (desc.id !== 'hueVsHue') {
    return Math.min(hi, Math.max(lo, proposedY));
  }
  const others = points
    .filter((_, i) => i !== excludingIndex)
    .slice()
    .sort((a, b) => a[0] - b[0]);
  if (others.length === 0) {
    return Math.min(hi, Math.max(lo, proposedY));
  }
  const before = others.filter((p) => p[0] < x);
  const after = others.filter((p) => p[0] > x);
  const prev = before.length > 0 ? before[before.length - 1] : others[others.length - 1];
  const next = after.length > 0 ? after[0] : others[0];
  const dxPrev = prev[0] < x ? x - prev[0] : x + 1 - prev[0];
  const dxNext = next[0] > x ? next[0] - x : next[0] + 1 - x;
  const maxDeltaPrev = 2.5 * Math.max(dxPrev, 0.01);
  const maxDeltaNext = 2.5 * Math.max(dxNext, 0.01);
  lo = Math.max(lo, prev[1] - maxDeltaPrev, next[1] - maxDeltaNext);
  hi = Math.min(hi, prev[1] + maxDeltaPrev, next[1] + maxDeltaNext);
  if (lo > hi) return 0.5 * (lo + hi);
  return Math.min(hi, Math.max(lo, proposedY));
}

export function evaluateColorCurve(
  desc: ColorCurveDescriptor,
  x: number,
  points: readonly ToneCurvePoint[],
): number {
  if (points.length === 0) return 0.5;
  const sorted = points.slice().sort((a, b) => a[0] - b[0]);
  if (sorted.length === 1) return Math.min(1, Math.max(0, sorted[0][1]));
  const u = desc.isPeriodic ? x - Math.floor(x) : Math.min(1, Math.max(0, x));
  const xs: number[] = [];
  const ys: number[] = [];
  if (desc.isPeriodic) {
    for (const shift of [-1, 0, 1]) {
      for (const p of sorted) {
        xs.push(p[0] + shift);
        ys.push(p[1]);
      }
    }
  } else {
    for (const p of sorted) {
      xs.push(p[0]);
      ys.push(p[1]);
    }
    if (u <= xs[0]) return ys[0];
    if (u >= xs[xs.length - 1]) return ys[ys.length - 1];
  }
  return evalHermite(u, xs, ys);
}

function evalHermite(x: number, xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  const deltas = new Array<number>(n - 1).fill(0);
  for (let k = 0; k < n - 1; k++) {
    const h = xs[k + 1] - xs[k];
    deltas[k] = h > 1e-6 ? (ys[k + 1] - ys[k]) / h : 0;
  }
  const m = new Array<number>(n).fill(0);
  m[0] = deltas[0];
  m[n - 1] = deltas[n - 2];
  for (let k = 1; k < n - 1; k++) {
    m[k] = deltas[k - 1] * deltas[k] <= 0 ? 0 : 0.5 * (deltas[k - 1] + deltas[k]);
  }
  let seg = 0;
  for (let k = 0; k < n - 1; k++) {
    if (x >= xs[k] && x <= xs[k + 1]) {
      seg = k;
      break;
    }
  }
  const h = xs[seg + 1] - xs[seg];
  if (h <= 1e-6) return Math.min(1, Math.max(0, ys[seg]));
  const t = (x - xs[seg]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const y = h00 * ys[seg] + h10 * h * m[seg] + h01 * ys[seg + 1] + h11 * h * m[seg + 1];
  return Math.min(1, Math.max(0, y));
}
