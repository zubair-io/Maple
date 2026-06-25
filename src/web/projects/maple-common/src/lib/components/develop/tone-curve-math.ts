// tone-curve-math.ts — pure math for the tone curve widget (#1540).
// No Angular dependencies — importable by both the component and unit tests.

/** Map parametric value [-100..100] to a y-offset fraction on the curve. */
export function paramToYOffset(v: number): number {
  return (v / 100) * 0.35;
}

/** Monotone Catmull-Rom spline evaluation through 4 control points + (0,0)/(1,1) anchors. */
export function evalSpline(pts: Array<{ x: number; y: number }>, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const anchors = [{ x: 0, y: 0 }, ...pts, { x: 1, y: 1 }];
  let i = 0;
  while (i < anchors.length - 2 && anchors[i + 1].x < x) i++;
  const p0 = anchors[Math.max(0, i - 1)];
  const p1 = anchors[i];
  const p2 = anchors[i + 1];
  const p3 = anchors[Math.min(anchors.length - 1, i + 2)];
  const dx = p2.x - p1.x;
  if (dx <= 0) return p1.y;
  const t = (x - p1.x) / dx;
  const m1 = 0.5 * (p2.y - p0.y);
  const m2 = 0.5 * (p3.y - p1.y);
  const t2 = t * t;
  const t3 = t2 * t;
  const y =
    (2 * t3 - 3 * t2 + 1) * p1.y +
    (t3 - 2 * t2 + t) * m1 +
    (-2 * t3 + 3 * t2) * p2.y +
    (t3 - t2) * m2;
  return Math.max(0, Math.min(1, y));
}
