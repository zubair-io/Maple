// image-canvas.crop.ts — crop-tool integration helpers for ImageCanvasComponent
// (#638). Pure functions over explicit inputs (the component wires its signals),
// kept out of the component to respect the file-size budget — same extraction
// precedent as image-canvas.draw2d.ts / image-canvas.gpu-present.ts.

import { CROP_IDENTITY, type AdjustmentModel } from '../../models/adjustment-model';

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

/** Displayed image dimensions for the fit/draw geometry. The renderer returns a
 *  buffer whose aspect already reflects the crop (a cropped render is a different
 *  aspect than the source), so the painted bitmap's own dims — not the asset's
 *  stored full-frame dims — drive `computeEffectivePx`; otherwise a cropped
 *  result would be stretched into the full-frame destination rect (#638 review).
 *  Falls back to the asset dims before the first paint. */
export function displayDims(
  painted: { w: number; h: number } | null,
  assetW: number | undefined,
  assetH: number | undefined,
): { w: number | undefined; h: number | undefined } {
  if (painted) return { w: painted.w, h: painted.h };
  return { w: assetW, h: assetH };
}
