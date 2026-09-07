// retouch-spot.ts — hand-written TypeScript mirror of
// `raw_core::types::retouch` (#3409), the clone / heal repair spot list.
//
// Permanently outside codegen for the same reason `local-adjustment.ts` is:
// it is a nested list, not a flat slider, so it has no `ADJUSTMENT_SCHEMA`
// entry to generate from. Keep this file in lockstep with the Rust module —
// a divergence is a silent rendering difference, not a compile error.

/** How a spot's source pixels combine with its destination. */
export type RetouchKind = 'heal' | 'clone';

/** A point in normalised image coordinates, `[0, 1]`, origin top-left. */
export interface RetouchPoint {
  x: number;
  y: number;
}

/**
 * One repair spot. The list applies front to back, so a later spot can
 * source from an earlier spot's result.
 *
 * `radius` is a fraction of the image WIDTH and the disc is a circle in
 * PIXEL space — unlike a mask, whose "circular" radial shape is an ellipse
 * on a non-square frame. A clone patch copied through an elliptical stencil
 * would not be the shape the user drew.
 *
 * `feather` is a fraction of `radius` (0 = hard edge, 1 = the whole disc is
 * transition) and `opacity` scales the composite. Both are `[0, 1]`.
 */
export interface RetouchSpot {
  kind: RetouchKind;
  /** Destination disc centre. */
  center: RetouchPoint;
  /** Source disc centre. */
  source: RetouchPoint;
  radius: number;
  feather: number;
  opacity: number;
}

/** 2 % of the frame width — Lightroom's own default spot size. */
export const RETOUCH_DEFAULT_RADIUS = 0.02;
/** Half the radius. */
export const RETOUCH_DEFAULT_FEATHER = 0.5;

/** A spot with the default feather and opacity. */
export function makeRetouchSpot(
  kind: RetouchKind,
  center: RetouchPoint,
  source: RetouchPoint,
  radius = RETOUCH_DEFAULT_RADIUS,
): RetouchSpot {
  return {
    kind,
    center,
    source,
    radius,
    feather: RETOUCH_DEFAULT_FEATHER,
    opacity: 1,
  };
}

/**
 * Mirrors `RetouchSpot::is_effective`: whether this spot can change a pixel.
 * A degenerate spot renders as nothing, so the UI dims it rather than
 * pretending an edit landed.
 */
export function isEffectiveRetouchSpot(s: RetouchSpot): boolean {
  const finite = [
    s.center.x,
    s.center.y,
    s.source.x,
    s.source.y,
    s.radius,
    s.feather,
    s.opacity,
  ].every((v) => Number.isFinite(v));
  const moved = s.source.x !== s.center.x || s.source.y !== s.center.y;
  return finite && s.radius > 0 && s.opacity > 0 && moved;
}

/** Deep structural equality — spots are plain data, compared by value. */
export function isSameRetouchSpot(a: RetouchSpot, b: RetouchSpot): boolean {
  return (
    a.kind === b.kind &&
    a.center.x === b.center.x &&
    a.center.y === b.center.y &&
    a.source.x === b.source.x &&
    a.source.y === b.source.y &&
    a.radius === b.radius &&
    a.feather === b.feather &&
    a.opacity === b.opacity
  );
}
