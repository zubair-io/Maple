// tone-curve-edit.ts — point-list editing rules for the curve widget (#367).
//
// Pure functions over `ToneCurvePoint[]`; no Angular, no DOM. Every one
// returns a NEW array, so a caller can hand the result straight to
// `LibraryStateService.updateAdjustment` without aliasing the model.
//
// The invariant they enforce is that the authored list is always a
// well-formed curve for `raw_core::stages::tone_curves`: sorted by `x`,
// inside the `[0, 1]` authoring domain, and never two knots at the same
// `x` — the stage's `prepare_curve` de-duplicates equal-x neighbours, so
// allowing that state would draw a knot the render silently ignores.
//
// Identity is the EMPTY list on all three platforms, which is what keeps
// an unedited sidecar byte-clean (#365). "Reset" therefore means empty,
// not the two corner anchors: `[(0,0), (1,1)]` renders identically but
// would serialize a `papp:SceneLinearToneCurve` block into a file the
// user never drew on.

import type { ToneCurvePoint } from '../../models/adjustment-model';

/** Closest approach, in authoring-domain units, that two knots may have. */
export const MIN_X_GAP = 1 / 256;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const byX = (a: ToneCurvePoint, b: ToneCurvePoint): number => a[0] - b[0];

/**
 * The list to edit against. An identity (empty) curve materialises as
 * the two corner anchors, so a user's first click produces a curve WITH
 * endpoints rather than a lone knot — which the stage evaluates as a
 * constant output, flattening the image to one tone.
 */
export function materializeCurve(points: readonly ToneCurvePoint[]): ToneCurvePoint[] {
  if (points.length === 0) {
    return [
      [0, 0],
      [1, 1],
    ];
  }
  return points.map(([x, y]): ToneCurvePoint => [x, y]).sort(byX);
}

/**
 * Insert a knot at `(x, y)`. Returns the list unchanged when the
 * position would collide with an existing knot's `x`.
 */
export function insertPoint(
  points: readonly ToneCurvePoint[],
  x: number,
  y: number,
): ToneCurvePoint[] {
  const list = materializeCurve(points);
  const px = clamp01(x);
  if (list.some((p) => Math.abs(p[0] - px) < MIN_X_GAP)) return list;
  return [...list, [px, clamp01(y)] as ToneCurvePoint].sort(byX);
}

/**
 * Move knot `index` to `(x, y)`. The two endpoints are pinned to their
 * `x` (0 and 1) and move only vertically: dragging a corner inward would
 * leave the curve undefined over part of its own domain, where the stage
 * clamps to the terminal knot's `y` and produces a flat shoulder the
 * user never drew. Interior knots stay strictly between their
 * neighbours.
 */
export function movePoint(
  points: readonly ToneCurvePoint[],
  index: number,
  x: number,
  y: number,
): ToneCurvePoint[] {
  const list = materializeCurve(points);
  if (index < 0 || index >= list.length) return list;
  const isFirst = index === 0;
  const isLast = index === list.length - 1;
  const lower = isFirst ? 0 : list[index - 1][0] + MIN_X_GAP;
  const upper = isLast ? 1 : list[index + 1][0] - MIN_X_GAP;
  const nextX = isFirst ? 0 : isLast ? 1 : Math.min(Math.max(clamp01(x), lower), upper);
  return list.map((p, i): ToneCurvePoint => (i === index ? [nextX, clamp01(y)] : p));
}

/**
 * Delete knot `index`. Endpoints are not deletable. Deleting back down
 * to the bare corner anchors returns the EMPTY list — the canonical
 * identity — so a user who removes every knot they added leaves the
 * sidecar as clean as they found it.
 */
export function removePoint(points: readonly ToneCurvePoint[], index: number): ToneCurvePoint[] {
  const list = materializeCurve(points);
  if (index <= 0 || index >= list.length - 1) return list;
  const next = list.filter((_, i) => i !== index);
  return isBareIdentity(next) ? [] : next;
}

/** True for the two-corner-anchor list that renders as the identity. */
export function isBareIdentity(points: readonly ToneCurvePoint[]): boolean {
  return (
    points.length === 2 &&
    points[0][0] === 0 &&
    points[0][1] === 0 &&
    points[1][0] === 1 &&
    points[1][1] === 1
  );
}

/**
 * Index of the knot within `radius` (authoring units) of `(x, y)`, or
 * `-1`. Ties break toward the closest; a drag that starts on a knot
 * moves it, and one that starts on empty canvas adds a new one.
 */
export function hitTest(
  points: readonly ToneCurvePoint[],
  x: number,
  y: number,
  radius: number,
): number {
  const list = materializeCurve(points);
  const scored = list.map((p, i) => ({ i, d: Math.hypot(p[0] - x, p[1] - y) }));
  const best = scored.reduce((a, b) => (b.d < a.d ? b : a), { i: -1, d: Infinity });
  return best.d <= radius ? best.i : -1;
}
