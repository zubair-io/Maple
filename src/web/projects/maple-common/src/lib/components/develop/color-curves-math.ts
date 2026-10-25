import {
  COLOR_CURVE_EDITOR,
  COLOR_CURVE_CALIBRATION,
} from '../../generated/adjustment-model.generated';
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

export const QUICK_HUE_ANCHORS: readonly QuickHueAnchor[] = COLOR_CURVE_CALIBRATION.quickHueAnchors;

const SKIN_TONE_GUARD_DEG = COLOR_CURVE_CALIBRATION.skinToneGuardDeg;

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

export function insertColorCurveAnchor(
  curve: ToneCurve,
  x: number,
  y = 0.5,
  periodic = false,
): ToneCurve {
  const position = (u: number) => (periodic ? u - Math.floor(u) : Math.min(1, Math.max(0, u)));
  const center = position(x);
  const pts: ToneCurvePoint[] = curve.points.map((p) => [p[0], p[1]]);
  const upsert = (u: number, v: number, overwrite: boolean) => {
    const px = position(u);
    const index = pts.findIndex(([other]) => {
      const distance = Math.abs(other - px);
      return (
        (periodic ? Math.min(distance, 1 - distance) : distance) < COLOR_CURVE_EDITOR.minKnotGap
      );
    });
    if (index >= 0) {
      if (overwrite) pts[index] = [px, v];
    } else if (pts.length < COLOR_CURVE_EDITOR.maxKnots) pts.push([px, v]);
  };
  upsert(center, Math.min(1, Math.max(0, y)), true);
  upsert(center - COLOR_CURVE_EDITOR.anchorSpread, 0.5, false);
  upsert(center + COLOR_CURVE_EDITOR.anchorSpread, 0.5, false);
  pts.sort((a, b) => a[0] - b[0]);
  return { points: pts };
}

export function clampColorCurveX(
  desc: ColorCurveDescriptor,
  proposed: number,
  points: readonly ToneCurvePoint[],
  index: number,
): number {
  const gap = COLOR_CURVE_EDITOR.minKnotGap;
  const min =
    index > 0
      ? points[index - 1][0] + gap
      : desc.isPeriodic && points.length > 1
        ? Math.max(0, points[points.length - 1][0] - 1 + gap)
        : 0;
  const max =
    index + 1 < points.length
      ? points[index + 1][0] - gap
      : desc.isPeriodic && points.length > 1
        ? Math.min(1, points[0][0] + 1 - gap)
        : 1;
  return min > max ? points[index][0] : Math.min(max, Math.max(min, proposed));
}

export function lockSkinToneCurve(desc: ColorCurveDescriptor, curve: ToneCurve): ToneCurve {
  if (!desc.isPeriodic) return curve;
  const pts: ToneCurvePoint[] = curve.points.map((p: ToneCurvePoint) => [p[0], p[1]]);
  for (const deg of SKIN_TONE_GUARD_DEG) {
    const x = deg / 360;
    const idx = pts.findIndex((p: ToneCurvePoint) => {
      const d = Math.abs(p[0] - x);
      return Math.min(d, 1 - d) < COLOR_CURVE_EDITOR.minKnotGap;
    });
    if (idx >= 0) {
      pts[idx] = [x, 0.5];
    } else if (pts.length < COLOR_CURVE_EDITOR.maxKnots) {
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
  const maxDeltaPrev = COLOR_CURVE_EDITOR.maxHueSlope * Math.max(dxPrev, 0.01);
  const maxDeltaNext = COLOR_CURVE_EDITOR.maxHueSlope * Math.max(dxNext, 0.01);
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
  const expanded = desc.isPeriodic
    ? [-1, 0, 1].flatMap((shift) => sorted.map(([x, y]) => [x + shift, y] as const))
    : sorted;
  const xs = expanded.map(([x]) => x);
  const ys = expanded.map(([, y]) => y);
  if (!desc.isPeriodic && u <= xs[0]) return ys[0];
  if (!desc.isPeriodic && u >= xs[xs.length - 1]) return ys[ys.length - 1];
  return evalHermite(u, xs, ys);
}

function evalHermite(x: number, xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  const hs = new Array<number>(n - 1).fill(0);
  const deltas = new Array<number>(n - 1).fill(0);
  for (let k = 0; k < n - 1; k++) {
    const h = Math.max(xs[k + 1] - xs[k], 1e-6);
    hs[k] = h;
    deltas[k] = (ys[k + 1] - ys[k]) / h;
  }
  const m = new Array<number>(n).fill(0);
  m[0] = deltas[0];
  m[n - 1] = deltas[n - 2];
  for (let k = 1; k < n - 1; k++) {
    const dl = deltas[k - 1];
    const dr = deltas[k];
    if (dl * dr > 0) {
      const hl = hs[k - 1];
      const hr = hs[k];
      const w1 = 2 * hr + hl;
      const w2 = hr + 2 * hl;
      m[k] = (w1 + w2) / (w1 / dl + w2 / dr);
    }
  }
  limitHermiteSlopes(m, deltas);
  let seg = 0;
  for (let k = 0; k < n - 1; k++) {
    if (x >= xs[k] && x <= xs[k + 1]) {
      seg = k;
      break;
    }
  }
  const h = hs[seg];
  const t = Math.min(1, Math.max(0, (x - xs[seg]) / h));
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const y = h00 * ys[seg] + h10 * h * m[seg] + h01 * ys[seg + 1] + h11 * h * m[seg + 1];
  return Math.min(1, Math.max(0, y));
}

function limitHermiteSlopes(m: number[], deltas: readonly number[]): void {
  for (let k = 0; k < deltas.length; k++) {
    const dk = deltas[k];
    if (Math.abs(dk) < 1e-7) {
      m[k] = 0;
      m[k + 1] = 0;
    } else {
      const alpha = m[k] / dk;
      const beta = m[k + 1] / dk;
      const r2 = alpha * alpha + beta * beta;
      if (r2 > 9) {
        const tau = 3 / Math.sqrt(r2);
        m[k] = tau * alpha * dk;
        m[k + 1] = tau * beta * dk;
      }
    }
  }
}

const KNOT_KEY_STEPS = new Map<string, readonly [number, number]>([
  ['ArrowLeft', [-1, 0]],
  ['ArrowRight', [1, 0]],
  ['ArrowUp', [0, 1]],
  ['ArrowDown', [0, -1]],
]);

/** Apply keyboard edits through the same spacing and hue-slope constraints as a drag. */
export function colorCurveKeyboardPoint(
  desc: ColorCurveDescriptor,
  points: readonly ToneCurvePoint[],
  index: number,
  key: string,
  coarse: boolean,
): ToneCurvePoint | undefined {
  const point = points[index];
  if (!point) return undefined;
  const delta = KNOT_KEY_STEPS.get(key);
  const endpoint = key === 'Home' ? 0 : key === 'End' ? 1 : undefined;
  if (!delta && endpoint === undefined) return undefined;
  const step = coarse ? 0.05 : 0.01;
  const x = delta?.[0]
    ? clampColorCurveX(desc, point[0] + delta[0] * step, points, index)
    : point[0];
  const y = endpoint ?? point[1] + (delta?.[1] ?? 0) * step;
  return [x, clampColorCurveY(desc, x, y, points, index)];
}
