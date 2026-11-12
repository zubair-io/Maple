// image-canvas.crop.ts — crop-tool integration helpers for ImageCanvasComponent
// (#638). Pure functions over explicit inputs (the component wires its signals),
// kept out of the component to respect the file-size budget — same extraction
// precedent as image-canvas.draw2d.ts / image-canvas.gpu-present.ts.

import {
  CROP_IDENTITY,
  isIdentityCrop,
  type AdjustmentModel,
  type Crop,
} from '../../models/adjustment-model';
import { renderModelForImportedAuto } from '../../models/partial-white-balance';

/** Model handed to the renderer. While the crop tool is active, strip the crop so
 *  the live canvas shows the full frame under the interactive overlay; inactive →
 *  crop applies as normal. A resolved name-only Auto WB renders as its pair (#4669). */
export function renderModelForCrop(model: AdjustmentModel, cropActive: boolean): AdjustmentModel {
  const rendered = renderModelForImportedAuto(model);
  return cropActive ? { ...rendered, crop: CROP_IDENTITY } : rendered;
}

/**
 * CSS transform for the live straighten preview: rotate the displayed (uncropped)
 * image by the crop angle. Deliberately NO cover-scale — the preview must match
 * the renderer, which applies no corner fill, so a pure straighten previews the
 * SAME bounds it will render (a near-edge crop may reveal a corner in both, which
 * the user then trims with the rect). `'none'` while not cropping or at 0°.
 */
export function cropStraightenTransform(cropActive: boolean, angle: number): string {
  return cropActive && angle ? `rotate(${angle}deg)` : 'none';
}

type Extent = { w: number; h: number };

/** Painted bitmaps are resampled, so their aspect drifts by a pixel's rounding. */
const ASPECT_TOLERANCE = 0.02;

function aspectMatches(a: Extent, b: Extent): boolean {
  return Math.abs(a.w / a.h / (b.w / b.h) - 1) <= ASPECT_TOLERANCE;
}

function croppedExtent(frame: Extent, crop: Crop | undefined): Extent {
  if (!crop || isIdentityCrop(crop)) return frame;
  const w = (crop.right - crop.left) * frame.w;
  const h = (crop.bottom - crop.top) * frame.h;
  return w > 0 && h > 0 ? { w, h } : frame;
}

/** `painted`'s shape at `extent`'s long edge: no stretch, and the scale the
 *  photo is shown at stays that of the image, not of the bitmap's pixels. */
function paintedShapeAt(extent: Extent, painted: Extent): Extent {
  const longEdge = Math.max(extent.w, extent.h);
  const aspect = painted.w / painted.h;
  return aspect >= 1
    ? { w: longEdge, h: longEdge / aspect }
    : { w: longEdge * aspect, h: longEdge };
}

/**
 * The one image extent the zoom model and the draw both size the photo by
 * (#5746): the display-oriented native size, cropped by an applied crop
 * (the crop tool renders the full frame). Before the decode publishes the
 * native size the asset's stored size stands in (turned a quarter when the
 * record is unoriented), so a bitmap landing never changes the photo's
 * on-screen size. The painted bitmap is only the pixels stretched into this
 * extent: its own size is used only before any size is known, and while its
 * shape disagrees with the extent (a crop change whose render has not
 * landed) only its shape is kept, so nothing stretches.
 */
export function resolveCanvasImageExtent(args: {
  painted: Extent | null;
  native: Extent | null;
  assetW: number | undefined;
  assetH: number | undefined;
  crop: Crop | undefined;
  cropToolActive: boolean;
}): Extent | null {
  const { painted } = args;
  const stored = args.assetW && args.assetH ? { w: args.assetW, h: args.assetH } : null;
  const frame = args.native ?? stored;
  if (!frame) return painted;
  const crop = args.cropToolActive ? undefined : args.crop;
  const extent = croppedExtent(frame, crop);
  if (!painted || aspectMatches(extent, painted)) return extent;
  const turned = args.native ? null : croppedExtent({ w: frame.h, h: frame.w }, crop);
  return turned && aspectMatches(turned, painted) ? turned : paintedShapeAt(extent, painted);
}
