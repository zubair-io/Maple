/**
 * Auto Crop as a crop in the panorama's XMP sidecar (#5608).
 *
 * The stitch keeps its whole canvas; the largest fully covered rectangle the
 * engine found is recorded as the standard crop fields, so the crop is
 * non-destructive and editable like any other.
 */

import { applyTransferPatch } from '../xmp/transfer-patch.ts';
import type { PanoEdgesReport } from './pano-edges.ts';

type CropRect = NonNullable<PanoEdgesReport['auto_crop']['rect']>;

function insideOutput(rect: CropRect, output: PanoEdgesReport['output']): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= output.width &&
    rect.y + rect.height <= output.height
  );
}

const edge = (pixels: number, extent: number): string => (pixels / extent).toFixed(6);

/**
 * The sidecar document that crops to the report's rectangle, or null when the
 * rectangle is the whole image or does not fit it. A binary that still trimmed
 * the pixels reports a rectangle in the uncropped canvas, which falls outside
 * its smaller output; the pixels are already cropped, so nothing is recorded.
 */
export function panoCropSidecar(edges: PanoEdgesReport): string | null {
  const { rect } = edges.auto_crop;
  const { output } = edges;
  if (rect === null || !insideOutput(rect, output)) return null;
  if (rect.width === output.width && rect.height === output.height) return null;
  return applyTransferPatch('', {
    attributes: {
      'crs:HasCrop': 'True',
      'crs:CropTop': edge(rect.y, output.height),
      'crs:CropLeft': edge(rect.x, output.width),
      'crs:CropBottom': edge(rect.y + rect.height, output.height),
      'crs:CropRight': edge(rect.x + rect.width, output.width),
      'crs:CropConstrainToWarp': '0',
    },
    elements: {},
  });
}
