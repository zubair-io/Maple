// mask-frame.ts — the map between the presented (cropped + geometry-warped)
// image and the full frame masks are evaluated in (#5950): the crop's affine
// inverse, and the projective composition with the manual geometry's inverse
// that raw-core's preview samples through. Split out of `mask-geometry.ts`
// for the file-size budget; that module re-exports every name here.

import type { Crop } from '../../models/adjustment-model';
import { isCropRectValid, isIdentityCrop } from '../../models/adjustment-model';
import type { MaskPoint } from '../../models/local-adjustment';

// ── Affine map (crop-normalized ↔ full-frame normalized) ──────────────────

/** `p = M p' + o`, `M = [[a, c], [b, d]]` (CSS matrix member convention). */
export interface MaskAffine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export const IDENTITY_AFFINE: MaskAffine = Object.freeze({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });

export const applyAffine = (m: MaskAffine, p: MaskPoint): MaskPoint => ({
  x: m.a * p.x + m.c * p.y + m.tx,
  y: m.b * p.x + m.d * p.y + m.ty,
});

export function invertAffine(m: MaskAffine): MaskAffine | null {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return null;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, tx: -(a * m.tx + c * m.ty), ty: -(b * m.tx + d * m.ty) };
}

/**
 * The map from the cropped output's normalized coordinates to the full
 * frame's, for `crop` on an image `imgW × imgH` px — identity when the crop
 * doesn't apply. Derived by pushing the crop-space origin and unit vectors
 * through the renderer's geometry ("rotate the frame clockwise about its
 * center by the straighten angle, then cut the axis-aligned rect"), so the
 * pixel-space rotation — anisotropic in normalized space on a non-square
 * image — is captured exactly.
 */
export function cropToFullFrameAffine(crop: Crop, imgW: number, imgH: number): MaskAffine {
  if (isIdentityCrop(crop) || !isCropRectValid(crop) || !(imgW > 0) || !(imgH > 0)) {
    return IDENTITY_AFFINE;
  }
  const cw = crop.right - crop.left;
  const ch = crop.bottom - crop.top;
  const theta = (crop.angle * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const map = (u: number, v: number): MaskPoint => {
    const rx = (crop.left + u * cw) * imgW - imgW / 2;
    const ry = (crop.top + v * ch) * imgH - imgH / 2;
    return {
      x: (cosT * rx + sinT * ry + imgW / 2) / imgW,
      y: (-sinT * rx + cosT * ry + imgH / 2) / imgH,
    };
  };
  const origin = map(0, 0);
  const unitX = map(1, 0);
  const unitY = map(0, 1);
  return {
    a: unitX.x - origin.x,
    b: unitX.y - origin.y,
    c: unitY.x - origin.x,
    d: unitY.y - origin.y,
    tx: origin.x,
    ty: origin.y,
  };
}

// ── Projective map (presented ↔ full-frame, crop + manual geometry) ──────

/** The seven manual-geometry sliders raw-core composes into one homography. */
export interface PerspectiveGeometry {
  vertical: number;
  horizontal: number;
  rotate: number;
  scale: number;
  aspect: number;
  x: number;
  y: number;
}

export const IDENTITY_PERSPECTIVE: PerspectiveGeometry = Object.freeze({
  vertical: 0,
  horizontal: 0,
  rotate: 0,
  scale: 100,
  aspect: 0,
  x: 0,
  y: 0,
});

/** The manual geometry a develop model carries, in slider order. */
export function perspectiveGeometryOf(model: {
  perspectiveVertical: number;
  perspectiveHorizontal: number;
  perspectiveRotate: number;
  perspectiveScale: number;
  perspectiveAspect: number;
  perspectiveX: number;
  perspectiveY: number;
}): PerspectiveGeometry {
  return {
    vertical: model.perspectiveVertical,
    horizontal: model.perspectiveHorizontal,
    rotate: model.perspectiveRotate,
    scale: model.perspectiveScale,
    aspect: model.perspectiveAspect,
    x: model.perspectiveX,
    y: model.perspectiveY,
  };
}

export function isIdentityPerspective(p: PerspectiveGeometry): boolean {
  return (
    p.vertical === 0 &&
    p.horizontal === 0 &&
    p.rotate === 0 &&
    p.scale === 100 &&
    p.aspect === 0 &&
    p.x === 0 &&
    p.y === 0
  );
}

type Matrix3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY_PROJECTION: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function multiply3(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Array<number>(9).fill(0) as Matrix3;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return out;
}

/** Apply a row-major projective map; a point on the horizon maps to NaN. */
export function applyProjection(m: readonly number[], p: MaskPoint): MaskPoint {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return { x: NaN, y: NaN };
  return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
}

/** The inverse projective map via the adjugate, or null when singular. */
export function invertProjection(m: readonly number[]): number[] | null {
  const c0 = m[4] * m[8] - m[5] * m[7];
  const c1 = m[5] * m[6] - m[3] * m[8];
  const c2 = m[3] * m[7] - m[4] * m[6];
  const det = m[0] * c0 + m[1] * c1 + m[2] * c2;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    c0,
    m[2] * m[7] - m[1] * m[8],
    m[1] * m[5] - m[2] * m[4],
    c1,
    m[0] * m[8] - m[2] * m[6],
    m[2] * m[3] - m[0] * m[5],
    c2,
    m[1] * m[6] - m[0] * m[7],
    m[0] * m[4] - m[1] * m[3],
  ].map((v) => v / det);
}

function perspectiveMatrix(p: PerspectiveGeometry, aspectRatio: number): Matrix3 {
  const kh = (0.5 * p.horizontal) / 100;
  const kv = (0.5 * p.vertical) / 100;
  const theta = (p.rotate * Math.PI) / 180;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const ar = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const stretch = Math.pow(1.5, p.aspect / 100);
  const scale = p.scale / 100;
  const keystone: Matrix3 = [1, 0, 0, 0, 1, 0, kh, kv, 1];
  const rotation: Matrix3 = [cosT, -sinT / ar, 0, sinT * ar, cosT, 0, 0, 0, 1];
  const aspectM: Matrix3 = [stretch, 0, 0, 0, 1 / stretch, 0, 0, 0, 1];
  const scaleM: Matrix3 = [scale, 0, 0, 0, scale, 0, 0, 0, 1];
  const offset: Matrix3 = [1, 0, p.x / 100, 0, 1, p.y / 100, 0, 0, 1];
  return multiply3(offset, multiply3(scaleM, multiply3(aspectM, multiply3(rotation, keystone))));
}

function rebased(h: Matrix3): Matrix3 {
  const row: [number, number, number] = [h[6], h[7], h[8]];
  const w = h[8] - h[6] - h[7];
  const rebase = (r: [number, number, number]): [number, number, number] => [
    r[0] + row[0],
    r[1] + row[1],
    (r[2] - r[0] - r[1] + w) / 2,
  ];
  const top = rebase([h[0], h[1], h[2]]);
  const mid = rebase([h[3], h[4], h[5]]);
  return [...top, ...mid, 2 * row[0], 2 * row[1], w];
}

/**
 * The row-major projective map taking a point normalised over the presented
 * image to the full frame masks are evaluated in: the crop's inverse, then
 * the manual geometry's inverse — the composition raw-core's preview samples
 * the frame through (`presentation_to_frame` on Android).
 */
export function presentationToFrameProjection(
  crop: Crop,
  perspective: PerspectiveGeometry,
  imgW: number,
  imgH: number,
): number[] {
  const affine = cropToFullFrameAffine(crop, imgW, imgH);
  const cropMatrix: Matrix3 = [
    affine.a,
    affine.c,
    affine.tx,
    affine.b,
    affine.d,
    affine.ty,
    0,
    0,
    1,
  ];
  const aspect = imgW > 0 && imgH > 0 ? imgW / imgH : 1;
  const inverse = invertProjection(perspectiveMatrix(perspective, aspect));
  const geometry = inverse ? rebased(inverse as Matrix3) : IDENTITY_PROJECTION;
  return multiply3(geometry, cropMatrix);
}

/** A presented normalised point in the full frame (crop, then geometry). */
export function presentedToFullFrame(
  p: MaskPoint,
  crop: Crop,
  perspective: PerspectiveGeometry,
  imgW: number,
  imgH: number,
): MaskPoint {
  return applyProjection(presentationToFrameProjection(crop, perspective, imgW, imgH), p);
}
