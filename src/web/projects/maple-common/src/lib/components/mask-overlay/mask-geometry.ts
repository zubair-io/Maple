// mask-geometry.ts — pure geometry for the interactive mask overlay (#1541):
// the per-pixel weight (a port of raw-core's `mask::evaluate`, so the tint
// the overlay draws IS what the render applies), handle placement, hit-
// testing and drag semantics for the two mask shapes, and the map between
// full-frame normalized mask coordinates and the canvas footprint. The
// Apple twin is `MapleCore.MaskGeometry` / `MaskWeight` / `MaskRemap`; the
// function names and semantics match so the two platforms can't drift.
//
// Coordinate spaces:
//   • full-frame normalized — the `LocalMask` coordinates raw-core evaluates
//     ([0, 1]² over the whole oriented image, origin top-left).
//   • crop-normalized — the same over the DISPLAYED (cropped + straightened)
//     region; identical to full-frame when no crop applies. The canvas shows
//     the crop raw-core cut in the geometry tail, so a mask on a cropped
//     image must be drawn through the crop's affine map.
//   • footprint — the displayed image's on-screen rect in CSS px at fit zoom
//     (`crop-geometry.ts`'s `fitFootprint`; the mask tool forces fit).

import type { Crop } from '../../models/adjustment-model';
import {
  isGeometricMask,
  type LinearMask,
  type LocalMask,
  type MaskPoint,
  type MaskGroup,
  type MaskCombine,
  type RadialMask,
} from '../../models/local-adjustment';
import type { Footprint } from '../crop-overlay/crop-geometry';
import {
  applyAffine,
  applyProjection,
  cropToFullFrameAffine,
  IDENTITY_AFFINE,
  IDENTITY_PERSPECTIVE,
  IDENTITY_PROJECTION,
  invertAffine,
  invertProjection,
  isIdentityPerspective,
  presentationToFrameProjection,
  type MaskAffine,
  type MaskProjection,
  type PerspectiveGeometry,
} from './mask-frame';
export {
  applyAffine,
  applyProjection,
  cropToFullFrameAffine,
  invertAffine,
  perspectiveGeometryOf,
  presentationToFrameProjection,
  presentedToFullFrame,
  type MaskAffine,
  type PerspectiveGeometry,
} from './mask-frame';

// ── Weight ────────────────────────────────────────────────────────────────

const smoothstep = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

const EPSILON = 1.1920929e-7;

/** The mask weight `w ∈ [0, 1]` at full-frame normalized (`x`, `y`).
 *
 *  A `bitmap` mask's raster lives in the render worker's registry, not on
 *  the main thread, so the overlay tint treats it as unresolved — weight 0,
 *  the same "never a silent global correction" rule raw-core applies to an
 *  unresolved raster id (#3300). `everywhere` is weight 1 by definition. A
 *  `brush` mask reads 0 here too: stamping a dab series per query point is
 *  the wrong shape for a per-pixel evaluator (the render samples the
 *  registered raster instead), so the overlay tints brush through
 *  `rasterizeBrushDabs` and never calls this for it. */
export function evaluateMaskWeight(mask: LocalMask, x: number, y: number): number {
  if (mask.kind === 'group') return evaluateGroupWeight(mask, x, y);
  if (mask.kind === 'everywhere') return 1;
  if (mask.kind === 'bitmap' || mask.kind === 'brush') return 0;
  if (mask.kind === 'linear') {
    const dx = mask.end.x - mask.start.x;
    const dy = mask.end.y - mask.start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= EPSILON) return 0;
    const t = ((x - mask.start.x) * dx + (y - mask.start.y) * dy) / lenSq;
    const f = Math.min(1, Math.max(0, mask.feather));
    if (f <= EPSILON) return t < 0.5 ? 0 : 1;
    const lo = 0.5 - f * 0.5;
    const hi = 0.5 + f * 0.5;
    return smoothstep((t - lo) / (hi - lo));
  }
  const { center, radii, angle, feather, invert } = mask;
  const w = (() => {
    if (Math.abs(radii.x) <= EPSILON || Math.abs(radii.y) <= EPSILON) return 0;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const dx = x - center.x;
    const dy = y - center.y;
    const lx = cosA * dx + sinA * dy;
    const ly = -sinA * dx + cosA * dy;
    const d = Math.sqrt((lx / radii.x) ** 2 + (ly / radii.y) ** 2);
    const f = Math.min(1, Math.max(0, feather));
    if (f <= EPSILON) return d <= 1 ? 1 : 0;
    const lo = 1 - f;
    return 1 - smoothstep((d - lo) / (1 - lo));
  })();
  return invert ? 1 - w : w;
}

function combineCoverage(weight: number, value: number, combine: MaskCombine): number {
  switch (combine) {
    case 'add':
      return weight + (1 - weight) * value;
    case 'subtract':
      return weight * (1 - value);
    case 'intersect':
      return weight * value;
  }
}

function evaluateGroupWeight(mask: MaskGroup, x: number, y: number): number {
  if (!mask.components.length || !Number.isFinite(mask.opacity)) return 0;
  // An unresolved component keeps the entire group inert, even when inverted
  // — and a brush component (unconstructible through the parser or the UI,
  // but not through a hand-built model) fails closed the same way rather
  // than silently skipping a subtract it cannot evaluate.
  for (const component of mask.components)
    if (component.mask.kind === 'bitmap' || component.mask.kind === 'brush') return 0;
  let weight = 0;
  for (const component of mask.components) {
    const raw = evaluateMaskWeight(component.mask, x, y);
    const value = component.invert ? 1 - raw : raw;
    weight = combineCoverage(weight, value, component.combine);
  }
  const coverage = mask.invert ? 1 - weight : weight;
  return Math.min(1, Math.max(0, coverage)) * Math.min(1, Math.max(0, mask.opacity));
}

/** Full-frame normalized ↔ canvas px through the footprint and the crop map. */
export interface MaskCanvasMap {
  footprint: Footprint;
  cropToFull: MaskAffine;
  fullToCrop: MaskAffine;
  /** Presented → full frame: the crop's inverse, then the geometry's. */
  presentedToFrame: MaskProjection;
  /** Full frame → presented, the inverse of `presentedToFrame`. */
  frameToPresented: number[];
  /** True when a manual-geometry slider moves the presented frame. */
  hasGeometry: boolean;
  /** Full-frame width / height in pixels — normalized units are not isotropic. */
  imageAspect: number;
}

export function makeMaskCanvasMap(
  footprint: Footprint,
  crop: Crop,
  imgW: number,
  imgH: number,
  perspective: PerspectiveGeometry = IDENTITY_PERSPECTIVE,
): MaskCanvasMap {
  const cropToFull = cropToFullFrameAffine(crop, imgW, imgH);
  const imageAspect = imgW > 0 && imgH > 0 ? imgW / imgH : 1;
  const presentedToFrame = presentationToFrameProjection(crop, perspective, imgW, imgH);
  return {
    footprint,
    cropToFull,
    fullToCrop: invertAffine(cropToFull) ?? IDENTITY_AFFINE,
    presentedToFrame,
    frameToPresented: invertProjection(presentedToFrame.matrix) ?? [...IDENTITY_PROJECTION],
    hasGeometry: !isIdentityPerspective(perspective),
    imageAspect,
  };
}

export function maskToScreen(map: MaskCanvasMap, p: MaskPoint): { x: number; y: number } {
  const q = applyProjection(map.frameToPresented, p);
  return {
    x: map.footprint.left + q.x * map.footprint.width,
    y: map.footprint.top + q.y * map.footprint.height,
  };
}

/** Canvas px → full-frame normalized, clamped to the frame. */
export function maskFromScreen(map: MaskCanvasMap, px: number, py: number): MaskPoint {
  const fp = map.footprint;
  const u = fp.width > 0 ? (px - fp.left) / fp.width : 0;
  const v = fp.height > 0 ? (py - fp.top) / fp.height : 0;
  const projected = applyProjection(map.presentedToFrame, { x: u, y: v });
  const p =
    Number.isFinite(projected.x) && Number.isFinite(projected.y)
      ? projected
      : applyAffine(map.cropToFull, { x: u, y: v });
  return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
}

/**
 * Bilinear sample of a full-frame raster (row-major, frame-normalised axes)
 * at the presented point (`u`, `v`): the presented → frame projection first,
 * so a brush dab's tint follows the geometry warp instead of a circular
 * stamp approximation. Zero outside the frame or on the horizon.
 */
export function sampleRasterProjected(
  acc: Float32Array,
  frameW: number,
  frameH: number,
  map: MaskCanvasMap,
  u: number,
  v: number,
): number {
  if (frameW <= 0 || frameH <= 0 || acc.length < frameW * frameH) return 0;
  const frame = applyProjection(map.presentedToFrame, { x: u, y: v });
  if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y)) return 0;
  if (frame.x < 0 || frame.x > 1 || frame.y < 0 || frame.y > 1) return 0;
  const gx = frame.x * (frameW - 1);
  const gy = frame.y * (frameH - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(frameW - 1, x0 + 1);
  const y1 = Math.min(frameH - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const top = acc[y0 * frameW + x0] * (1 - fx) + acc[y0 * frameW + x1] * fx;
  const bottom = acc[y1 * frameW + x0] * (1 - fx) + acc[y1 * frameW + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

// ── Handles ───────────────────────────────────────────────────────────────

export type MaskHandle =
  | 'linearStart'
  | 'linearEnd'
  | 'linearBody'
  | 'radialCenter'
  | 'radialRadiusX'
  | 'radialRadiusY'
  | 'radialRotate';

export const MASK_HANDLE_NAME: Readonly<Record<MaskHandle, string>> = {
  linearStart: 'gradient start',
  linearEnd: 'gradient end',
  linearBody: 'gradient',
  radialCenter: 'center',
  radialRadiusX: 'horizontal radius',
  radialRadiusY: 'vertical radius',
  radialRotate: 'rotation',
};

/** Smallest half-axis a radius handle can drag to, in normalized units. */
export const MIN_RADIUS = 0.01;
/** Where the rotation pin sits along the local x axis, as a multiple of `rx`. */
export const ROTATE_HANDLE_FACTOR = 1.3;

export function defaultLinearMask(): LinearMask {
  return { kind: 'linear', start: { x: 0.5, y: 0.15 }, end: { x: 0.5, y: 0.55 }, feather: 0.5 };
}

/** A centered radial mask; `imageAspect` (w/h) pre-corrects the radii so it
 *  reads as a circle on screen (the evaluator itself is aspect-agnostic). */
export function defaultRadialMask(imageAspect: number): RadialMask {
  const aspect = Number.isFinite(imageAspect) && imageAspect > 0 ? imageAspect : 1;
  return {
    kind: 'radial',
    center: { x: 0.5, y: 0.5 },
    radii: { x: 0.25, y: 0.25 * aspect },
    angle: 0,
    feather: 0.5,
    invert: false,
  };
}

/** Every handle of `mask` with its full-frame normalized position — none
 *  for a bitmap or everywhere mask, which has no on-canvas geometry. */
export function maskHandles(
  mask: LocalMask,
): ReadonlyArray<{ handle: MaskHandle; point: MaskPoint }> {
  if (!isGeometricMask(mask)) return [];
  if (mask.kind === 'linear') {
    return [
      { handle: 'linearStart', point: mask.start },
      { handle: 'linearEnd', point: mask.end },
      {
        handle: 'linearBody',
        point: { x: (mask.start.x + mask.end.x) / 2, y: (mask.start.y + mask.end.y) / 2 },
      },
    ];
  }
  const { center: c, radii, angle } = mask;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  return [
    { handle: 'radialCenter', point: c },
    { handle: 'radialRadiusX', point: { x: c.x + radii.x * cosA, y: c.y + radii.x * sinA } },
    { handle: 'radialRadiusY', point: { x: c.x - radii.y * sinA, y: c.y + radii.y * cosA } },
    {
      handle: 'radialRotate',
      point: {
        x: c.x + radii.x * ROTATE_HANDLE_FACTOR * cosA,
        y: c.y + radii.x * ROTATE_HANDLE_FACTOR * sinA,
      },
    },
  ];
}

/** Points along the ellipse boundary (full-frame normalized). */
export function ellipseOutline(
  center: MaskPoint,
  radii: MaskPoint,
  angle: number,
  samples = 72,
): MaskPoint[] {
  const n = Math.max(samples, 3);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  return Array.from({ length: n }, (_, i) => {
    const phi = (i / n) * 2 * Math.PI;
    const lx = radii.x * Math.cos(phi);
    const ly = radii.y * Math.sin(phi);
    return { x: center.x + lx * cosA - ly * sinA, y: center.y + lx * sinA + ly * cosA };
  });
}

const HIT_PRECEDENCE: readonly MaskHandle[] = [
  'linearStart',
  'linearEnd',
  'radialRotate',
  'radialRadiusX',
  'radialRadiusY',
  'radialCenter',
  'linearBody',
];

/** The handle under (`px`, `py`) within `tolerance` px, or null. Endpoints
 *  win over the body/center so a tiny gradient stays resizable. */
export function hitTestMaskHandle(
  px: number,
  py: number,
  mask: LocalMask,
  map: MaskCanvasMap,
  tolerance: number,
): MaskHandle | null {
  const handles = maskHandles(mask);
  return (
    HIT_PRECEDENCE.find((handle) => {
      const entry = handles.find((h) => h.handle === handle);
      if (!entry) return false;
      const s = maskToScreen(map, entry.point);
      return Math.hypot(s.x - px, s.y - py) <= tolerance;
    }) ?? null
  );
}

/** `startMask` with `handle` dragged to `point`; `anchor` is where the drag
 *  began (for the translating handles). */
export function dragMaskHandle(
  startMask: LocalMask,
  handle: MaskHandle,
  point: MaskPoint,
  anchor: MaskPoint,
): LocalMask {
  if (!isGeometricMask(startMask)) return startMask;
  if (startMask.kind === 'linear') {
    switch (handle) {
      case 'linearStart':
        return { ...startMask, start: point };
      case 'linearEnd':
        return { ...startMask, end: point };
      case 'linearBody': {
        // Translate both endpoints by the pointer delta, clamped so neither
        // leaves the normalized frame (the `LocalMask` contract) — the
        // gradient stops at the edge rather than sliding off it.
        const { start, end } = startMask;
        const dx = clampDelta(
          point.x - anchor.x,
          Math.min(start.x, end.x),
          Math.max(start.x, end.x),
        );
        const dy = clampDelta(
          point.y - anchor.y,
          Math.min(start.y, end.y),
          Math.max(start.y, end.y),
        );
        return {
          ...startMask,
          start: { x: start.x + dx, y: start.y + dy },
          end: { x: end.x + dx, y: end.y + dy },
        };
      }
      default:
        return startMask;
    }
  }
  const { center: c, radii, angle } = startMask;
  switch (handle) {
    case 'radialCenter':
      return { ...startMask, center: point };
    case 'radialRadiusX': {
      const along = (point.x - c.x) * Math.cos(angle) + (point.y - c.y) * Math.sin(angle);
      return { ...startMask, radii: { x: Math.max(MIN_RADIUS, Math.abs(along)), y: radii.y } };
    }
    case 'radialRadiusY': {
      const along = -(point.x - c.x) * Math.sin(angle) + (point.y - c.y) * Math.cos(angle);
      return { ...startMask, radii: { x: radii.x, y: Math.max(MIN_RADIUS, Math.abs(along)) } };
    }
    case 'radialRotate':
      return { ...startMask, angle: Math.atan2(point.y - c.y, point.x - c.x) };
    default:
      return startMask;
  }
}

/** The largest move toward `delta` that keeps the span `[lo, hi]` inside [0, 1]. */
function clampDelta(delta: number, lo: number, hi: number): number {
  return Math.min(1 - hi, Math.max(-lo, delta));
}

/** `mask` at `feather` (clamped); a bitmap or everywhere mask has no feather. */
export function withMaskFeather(mask: LocalMask, feather: number): LocalMask {
  return isGeometricMask(mask) ? { ...mask, feather: Math.min(1, Math.max(0, feather)) } : mask;
}
