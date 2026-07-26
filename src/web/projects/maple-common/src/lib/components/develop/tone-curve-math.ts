// tone-curve-math.ts — pure math for the tone curve widget (#1540 → #367).
// No Angular dependencies — importable by both the component and unit tests.
//
// This is a line-for-line port of
// `raw_core::stages::tone_curves::evaluator` (Fritsch–Carlson monotonic
// cubic Hermite). The widget MUST draw the shape the pipeline actually
// renders, so the interpolation cannot be "something spline-ish that
// looks close" — a divergence here would be a lie about what the photo
// will look like. The port stays in the `[0, 1]` AUTHORING domain only:
// the authoring → scene-linear mapping (`REF_MAX`, the tanh soft-knee
// above 0.98) belongs to the stage and has no meaning on a curve plot.

import type { ToneCurvePoint } from '../../models/adjustment-model';

/**
 * Knots plus their monotonicity-guarded tangents, pre-computed once so
 * sampling the curve for a path string does no per-sample allocation.
 * Mirrors `evaluator::PreparedCurve`.
 */
export interface PreparedCurve {
  readonly knots: readonly ToneCurvePoint[];
  readonly tangents: readonly number[];
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Sort by `x`, clamp into the authoring domain and drop equal-x
 * neighbours (last-write-wins), then compute Fritsch–Carlson tangents.
 * Mirrors `prepare_curve`.
 */
export function prepareCurve(points: readonly ToneCurvePoint[]): PreparedCurve {
  const sorted = points
    .map(([x, y]): ToneCurvePoint => [clamp01(x), clamp01(y)])
    .sort((a, b) => a[0] - b[0]);
  // De-duplicate equal-x neighbours keeping the LATER point, matching the
  // Rust `dedup_by` whose body is `*prev = *next` (last-write-wins).
  const knots = sorted.filter((p, i) => i === sorted.length - 1 || sorted[i + 1][0] !== p[0]);
  return { knots, tangents: computeTangents(knots) };
}

function computeTangents(knots: readonly ToneCurvePoint[]): number[] {
  const n = knots.length;
  if (n < 2) return [];

  const slopes = Array.from(
    { length: n - 1 },
    (_, i) => (knots[i + 1][1] - knots[i][1]) / (knots[i + 1][0] - knots[i][0]),
  );

  // Endpoints take the one-sided slope; an interior knot whose two
  // adjacent slopes disagree in sign gets a zero tangent, which forces
  // the local extremum exactly onto the knot instead of overshooting.
  const tangents = [
    slopes[0],
    ...Array.from({ length: n - 2 }, (_, k) => {
      const i = k + 1;
      return slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) * 0.5;
    }),
    slopes[n - 2],
  ];

  // Monotonicity guard: project each (alpha, beta) pair into the circle
  // of radius 3, and zero both tangents across a flat segment.
  for (let i = 0; i < n - 1; i++) {
    const m = slopes[i];
    if (Math.abs(m) < Number.EPSILON) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const alpha = tangents[i] / m;
    const beta = tangents[i + 1] / m;
    const mag = Math.hypot(alpha, beta);
    if (mag > 3) {
      const scale = 3 / mag;
      tangents[i] = scale * alpha * m;
      tangents[i + 1] = scale * beta * m;
    }
  }
  return tangents;
}

/**
 * Evaluate the prepared curve at `x` in the authoring `[0, 1]` domain.
 * Mirrors `eval_monotonic_cubic`; an empty curve is the identity and a
 * single-knot curve is that knot's constant `y`, exactly as the stage
 * treats them.
 */
export function evalMonotonicCubic(curve: PreparedCurve, x: number): number {
  const { knots, tangents } = curve;
  const n = knots.length;
  if (n === 0) return clamp01(x);
  if (n === 1) return knots[0][1];
  if (x <= knots[0][0]) return knots[0][1];
  if (x >= knots[n - 1][0]) return knots[n - 1][1];

  let i = 0;
  while (i < n - 2 && knots[i + 1][0] <= x) i++;

  const [x0, y0] = knots[i];
  const [x1, y1] = knots[i + 1];
  const h = x1 - x0;
  const t = (x - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const y =
    (2 * t3 - 3 * t2 + 1) * y0 +
    (t3 - 2 * t2 + t) * h * tangents[i] +
    (-2 * t3 + 3 * t2) * y1 +
    (t3 - t2) * h * tangents[i + 1];
  return clamp01(y);
}

/**
 * Sample the curve into an SVG path string over a `size` × `size` box
 * with y flipped (SVG's origin is top-left, the curve's is bottom-left).
 * An identity (empty) curve returns the diagonal.
 */
export function curvePathData(
  points: readonly ToneCurvePoint[],
  size: number,
  samples = 64,
): string {
  const curve = prepareCurve(points);
  const vertices = Array.from({ length: samples + 1 }, (_, i) => {
    const x = i / samples;
    const y = evalMonotonicCubic(curve, x);
    return `${(x * size).toFixed(2)} ${((1 - y) * size).toFixed(2)}`;
  });
  return `M ${vertices.join(' L ')}`;
}
