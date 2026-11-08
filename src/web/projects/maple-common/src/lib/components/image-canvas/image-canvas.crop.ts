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

/** Model handed to the renderer while the crop tool is active: strip the crop so
 *  the live canvas shows the full frame under the interactive overlay. Inactive
 *  → the model is returned unchanged (crop applies as normal). */
export function renderModelForCrop(model: AdjustmentModel, cropActive: boolean): AdjustmentModel {
  return cropActive ? { ...model, crop: CROP_IDENTITY } : model;
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

/**
 * The one image extent the zoom model and the draw both size the photo by
 * (#5746): the display-oriented native size, cropped by an applied crop
 * (the crop tool renders the full frame). Before the decode publishes the
 * native size the asset's stored size stands in, so a bitmap landing never
 * changes the photo's on-screen size. The painted bitmap is only the pixels
 * stretched into this extent; its own size is used only before any size is
 * known, or while its shape disagrees with the extent (an unoriented stored
 * size, or a crop change whose render has not landed yet), which would
 * otherwise stretch the photo.
 */
export function resolveCanvasImageExtent(args: {
  painted: Extent | null;
  native: Extent | null;
  assetW: number | undefined;
  assetH: number | undefined;
  crop: Crop | undefined;
  cropToolActive: boolean;
}): Extent | null {
  const stored = args.assetW && args.assetH ? { w: args.assetW, h: args.assetH } : null;
  const frame = args.native ?? stored;
  if (!frame) return args.painted;
  const extent = croppedExtent(frame, args.cropToolActive ? undefined : args.crop);
  return !args.painted || aspectMatches(extent, args.painted) ? extent : args.painted;
}
