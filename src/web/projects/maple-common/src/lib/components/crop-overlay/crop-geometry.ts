// crop-geometry.ts — pure geometry for the interactive crop/straighten overlay
// (#638). No Angular, no DOM, no signals — every function is a plain map over
// explicit inputs so the handle-drag, aspect-lock, and straighten-preview math
// is unit-testable in isolation (see `crop-geometry.spec.ts`).
//
// Coordinate spaces:
//   • normalized — the `Crop` rect edges in [0, 1] against the display-oriented
//     image (post-EXIF). This is exactly what the pipeline / XMP consume.
//   • footprint  — the image's on-screen rect in CSS px at FIT zoom, centered in
//     the viewport (the crop tool forces fit + zero pan, so the displayed image
//     always maps 1:1 onto this rect).
//
// The straighten preview rotates the displayed IMAGE by `angle` while the crop
// rectangle stays axis-aligned — mirroring the renderer's "rotate the frame,
// then cut an axis-aligned rect" model (spec § 3.12). `coverScaleForAngle`
// gives the uniform up-scale that keeps the rotated image covering the whole
// footprint so no empty corners ever show through the crop box.

import type { Crop } from '../../models/adjustment-model';

/** Minimum crop rectangle size as a fraction of each image axis. Stops a drag
 *  from collapsing the rect to zero (and keeps both renderer + overlay sane). */
export const MIN_CROP_FRACTION = 0.05;

/** The image's on-screen rect (CSS px) at fit zoom, centered in the viewport. */
export interface Footprint {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A screen-space rectangle in CSS px. */
export interface PxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Handles the user can grab: 4 corners, 4 edge midpoints, plus the interior
 *  (move) — `null` means "no hit". */
export type CropHandle = 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r' | 'move';

/** Fit footprint: the largest centered rect of the image's aspect that fits the
 *  viewport without upscaling past 1:1 CSS — the same rule as the 2D canvas
 *  `computeEffectivePx('fit', …)`, so the overlay aligns with the painted image. */
export function fitFootprint(wrapW: number, wrapH: number, imgW: number, imgH: number): Footprint {
  const safeImgW = imgW > 0 ? imgW : 1;
  const safeImgH = imgH > 0 ? imgH : 1;
  const scale = Math.min(wrapW / safeImgW, wrapH / safeImgH, 1);
  const width = safeImgW * scale;
  const height = safeImgH * scale;
  return {
    left: (wrapW - width) / 2,
    top: (wrapH - height) / 2,
    width,
    height,
  };
}

/** Crop rect (normalized) → screen rect (CSS px) over the footprint. */
export function cropRectToPx(crop: Crop, fp: Footprint): PxRect {
  return {
    x: fp.left + crop.left * fp.width,
    y: fp.top + crop.top * fp.height,
    width: (crop.right - crop.left) * fp.width,
    height: (crop.bottom - crop.top) * fp.height,
  };
}

/** Screen point (CSS px, viewport-relative) → normalized image coords, clamped
 *  to [0, 1]. Inverse of the footprint map. */
export function pxToNormalized(px: number, py: number, fp: Footprint): { nx: number; ny: number } {
  const nx = fp.width > 0 ? (px - fp.left) / fp.width : 0;
  const ny = fp.height > 0 ? (py - fp.top) / fp.height : 0;
  return { nx: clamp01(nx), ny: clamp01(ny) };
}

/**
 * Uniform scale that keeps an `w × h` image, rotated by `angleDeg` about its
 * center, fully covering its own un-rotated footprint — so the crop box (a
 * subset of the footprint) never reveals an empty corner during a straighten.
 *
 * Derivation: the worst-case footprint corner (±w/2, ±h/2), mapped into the
 * image-local frame (rotate by −θ), must stay inside the scaled half-extents.
 * The binding corner gives `cos|θ| + max(w/h, h/w)·sin|θ|`.
 */
export function coverScaleForAngle(angleDeg: number, w: number, h: number): number {
  const a = (Math.abs(angleDeg) * Math.PI) / 180;
  if (a === 0 || w <= 0 || h <= 0) return 1;
  const aspect = Math.max(w / h, h / w);
  return Math.cos(a) + aspect * Math.sin(a);
}

/** Which handle (if any) the pointer hit. Corners win over edges; the interior
 *  is `move`. `tol` is the grab radius in CSS px. Returns `null` outside the
 *  rect + tolerance. */
export function hitTestHandle(
  px: number,
  py: number,
  rect: PxRect,
  tol: number,
): CropHandle | null {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;

  const nearL = Math.abs(px - left) <= tol;
  const nearR = Math.abs(px - right) <= tol;
  const nearT = Math.abs(py - top) <= tol;
  const nearB = Math.abs(py - bottom) <= tol;
  const withinX = px >= left - tol && px <= right + tol;
  const withinY = py >= top - tol && py <= bottom + tol;

  if (nearL && nearT) return 'tl';
  if (nearR && nearT) return 'tr';
  if (nearL && nearB) return 'bl';
  if (nearR && nearB) return 'br';
  if (nearT && withinX) return 't';
  if (nearB && withinX) return 'b';
  if (nearL && withinY) return 'l';
  if (nearR && withinY) return 'r';
  if (withinX && withinY) return 'move';
  return null;
}

/** Resize options for a handle drag. `aspect` (width / height of the FINAL
 *  image-space rect) locks the proportions; `null` is a free crop. */
export interface ResizeOptions {
  /** Locked aspect as image-space width:height, or `null` for free. */
  aspect: number | null;
  /** Image pixel dimensions, needed to honor a pixel aspect against the
   *  normalized rect (which is relative to each axis independently). */
  imgW: number;
  imgH: number;
}

/**
 * Apply a handle drag to a crop rect. `nx`/`ny` are the dragged pointer in
 * normalized image coords. Edges are clamped so the rect keeps at least
 * `MIN_CROP_FRACTION` on each axis and never inverts; an aspect lock recomputes
 * the free edge from the dragged one about the opposite/anchor corner.
 */
export function resizeCrop(
  crop: Crop,
  handle: CropHandle,
  nx: number,
  ny: number,
  opts: ResizeOptions,
): Crop {
  const next: Crop = { ...crop };
  const movesLeft = handle === 'tl' || handle === 'bl' || handle === 'l';
  const movesRight = handle === 'tr' || handle === 'br' || handle === 'r';
  const movesTop = handle === 'tl' || handle === 'tr' || handle === 't';
  const movesBottom = handle === 'bl' || handle === 'br' || handle === 'b';

  if (movesLeft) next.left = Math.min(nx, crop.right - MIN_CROP_FRACTION);
  if (movesRight) next.right = Math.max(nx, crop.left + MIN_CROP_FRACTION);
  if (movesTop) next.top = Math.min(ny, crop.bottom - MIN_CROP_FRACTION);
  if (movesBottom) next.bottom = Math.max(ny, crop.top + MIN_CROP_FRACTION);

  next.left = clamp01(next.left);
  next.right = clamp01(next.right);
  next.top = clamp01(next.top);
  next.bottom = clamp01(next.bottom);

  if (opts.aspect != null && opts.aspect > 0) {
    applyAspect(next, crop, handle, opts);
  }
  return next;
}

/** Recompute the free axis so the rect's IMAGE-space proportions equal `aspect`
 *  (width:height in pixels), anchoring on the edge(s) the handle did NOT move. */
function applyAspect(next: Crop, prev: Crop, handle: CropHandle, opts: ResizeOptions): void {
  const { imgW, imgH, aspect } = opts;
  if (aspect == null) return;
  // Target normalized width / height ratio so that
  // (w_norm·imgW) / (h_norm·imgH) === aspect.
  const ratioNorm = aspect * (imgH / imgW); // w_norm / h_norm

  const widthDriven = handle === 'l' || handle === 'r';
  const heightDriven = handle === 't' || handle === 'b';

  let w = next.right - next.left;
  let h = next.bottom - next.top;

  if (widthDriven) {
    h = w / ratioNorm;
  } else if (heightDriven) {
    w = h * ratioNorm;
  } else {
    // Corner: drive by the larger relative change to feel natural.
    h = w / ratioNorm;
  }

  // Re-anchor: keep the corner opposite the moved handle fixed.
  const anchorRight = handle === 'tl' || handle === 'bl' || handle === 'l';
  const anchorBottom = handle === 'tl' || handle === 'tr' || handle === 't';

  if (anchorRight) {
    next.left = next.right - w;
  } else {
    next.right = next.left + w;
  }
  if (anchorBottom) {
    next.top = next.bottom - h;
  } else {
    next.bottom = next.top + h;
  }

  // If the aspect push ran a corner/edge off the image, scale back to fit
  // while preserving the ratio and the anchor.
  const overflow = Math.max(
    next.left < 0 ? -next.left / Math.max(w, 1e-6) : 0,
    next.right > 1 ? (next.right - 1) / Math.max(w, 1e-6) : 0,
    next.top < 0 ? -next.top / Math.max(h, 1e-6) : 0,
    next.bottom > 1 ? (next.bottom - 1) / Math.max(h, 1e-6) : 0,
  );
  if (overflow > 0) {
    const scale = 1 - overflow;
    const nw = w * scale;
    const nh = h * scale;
    if (anchorRight) next.left = next.right - nw;
    else next.right = next.left + nw;
    if (anchorBottom) next.top = next.bottom - nh;
    else next.bottom = next.top + nh;
  }

  next.left = clamp01(next.left);
  next.right = clamp01(next.right);
  next.top = clamp01(next.top);
  next.bottom = clamp01(next.bottom);
  void prev;
}

/** Translate the whole crop rect by a normalized delta, clamped so it stays
 *  inside the image without resizing. */
export function moveCrop(crop: Crop, dnx: number, dny: number): Crop {
  const w = crop.right - crop.left;
  const h = crop.bottom - crop.top;
  let left = crop.left + dnx;
  let top = crop.top + dny;
  left = Math.max(0, Math.min(left, 1 - w));
  top = Math.max(0, Math.min(top, 1 - h));
  return { ...crop, left, top, right: left + w, bottom: top + h };
}

/** Build a centered crop rect of the given IMAGE-space aspect (width:height in
 *  pixels), as large as fits the frame. Used by the aspect-ratio presets. */
export function centeredCropForAspect(
  aspect: number,
  imgW: number,
  imgH: number,
  angle: number,
): Crop {
  if (aspect <= 0 || imgW <= 0 || imgH <= 0) {
    return { top: 0, left: 0, bottom: 1, right: 1, angle };
  }
  const imgAspect = imgW / imgH;
  let w: number;
  let h: number;
  if (aspect >= imgAspect) {
    // Crop is wider than the image — span full width, trim height.
    w = 1;
    h = imgAspect / aspect;
  } else {
    h = 1;
    w = aspect / imgAspect;
  }
  const left = (1 - w) / 2;
  const top = (1 - h) / 2;
  return { left, top, right: left + w, bottom: top + h, angle };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
