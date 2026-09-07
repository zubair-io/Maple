// retouch-geometry.ts — pure geometry for the clone / heal brush overlay
// (#3409). No Angular, no DOM: every function is a value transform, so the
// spec drives it directly.
//
// Screen mapping is shared with the mask tool: `MaskCanvasMap` already folds
// the applied crop and straighten into the displayed footprint, and a repair
// spot lives in exactly the same full-frame normalised space a mask does.
// What is NOT shared is the radius, which is a fraction of the image WIDTH
// and draws as a circle in pixels (`models/retouch-spot.ts`) — so its screen
// size is measured through the map rather than scaled by one axis.

import type { RetouchPoint, RetouchSpot } from '../../models/retouch-spot';
import { type MaskCanvasMap, maskToScreen } from '../mask-overlay/mask-geometry';

/** The two draggable points of a spot. */
export type RetouchHandle = 'destination' | 'source';

export const RETOUCH_HANDLE_NAME: Readonly<Record<RetouchHandle, string>> = {
  destination: 'Destination',
  source: 'Source',
};

/** Both handles, destination first (it is what a click creates). */
export function retouchHandles(spot: RetouchSpot): ReadonlyArray<{
  handle: RetouchHandle;
  point: RetouchPoint;
}> {
  return [
    { handle: 'destination', point: spot.center },
    { handle: 'source', point: spot.source },
  ];
}

/** Screen position of one point through the shared canvas map. */
export function retouchPointToScreen(
  map: MaskCanvasMap,
  point: RetouchPoint,
): { x: number; y: number } {
  return maskToScreen(map, point);
}

/**
 * The spot's disc radius in CSS px. Measured as the mapped distance from the
 * centre to `centre + radius` along x, so a straightened (rotated) map gives
 * the same length rather than a sheared one.
 */
export function retouchRadiusPx(map: MaskCanvasMap, spot: RetouchSpot): number {
  const a = maskToScreen(map, spot.center);
  const b = maskToScreen(map, { x: spot.center.x + spot.radius, y: spot.center.y });
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Which handle a press at `(px, py)` grabs, or `null`. The source wins ties
 * because it sits on top: a freshly-placed spot puts both discs close
 * together and the source is the one the user then drags away.
 */
export function hitTestRetouchHandle(
  px: number,
  py: number,
  spot: RetouchSpot,
  map: MaskCanvasMap,
  tolerance: number,
): RetouchHandle | null {
  const reach = Math.max(tolerance, retouchRadiusPx(map, spot));
  const within = (point: RetouchPoint): boolean => {
    const s = maskToScreen(map, point);
    return Math.hypot(px - s.x, py - s.y) <= reach;
  };
  if (within(spot.source)) return 'source';
  if (within(spot.center)) return 'destination';
  return null;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Move one handle to `point`, preserving the grab offset (`anchor` is where
 * the press landed, in the same normalised space). Dragging the destination
 * carries the source with it, so the sampled offset — the thing the user
 * chose — survives a reposition; dragging the source moves it alone.
 */
export function dragRetouchHandle(
  start: RetouchSpot,
  handle: RetouchHandle,
  point: RetouchPoint,
  anchor: RetouchPoint,
): RetouchSpot {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  if (handle === 'source') {
    return {
      ...start,
      source: { x: clamp01(start.source.x + dx), y: clamp01(start.source.y + dy) },
    };
  }
  return {
    ...start,
    center: { x: clamp01(start.center.x + dx), y: clamp01(start.center.y + dy) },
    source: { x: clamp01(start.source.x + dx), y: clamp01(start.source.y + dy) },
  };
}

/**
 * Where a brand-new spot samples from: one and a half radii to the right of
 * the destination, mirrored to the left when that would leave the frame.
 * Lightroom picks a source heuristically too; a deterministic offset is what
 * makes a placement reproducible and testable.
 */
export function defaultRetouchSource(center: RetouchPoint, radius: number): RetouchPoint {
  const offset = radius * 1.5;
  const x = center.x + offset <= 1 ? center.x + offset : center.x - offset;
  return { x: clamp01(x), y: center.y };
}
