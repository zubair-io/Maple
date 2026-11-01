// Auto Crop on the merge dialog's preview (#5608). The preview image is the
// whole canvas; the crop is only shown, by placing the image inside a frame of
// the rectangle's shape, the same way the panorama's sidecar crop will show it.

import type { PanoEdgesReport } from '../api/pano.service';

const PREVIEW_MAX_HEIGHT = 'min(240px, 26vh)';

export interface PanoPreviewCrop {
  /** The frame's width over its height. */
  readonly ratio: number;
  /** As wide as the dialog allows without growing taller than the uncropped preview. */
  readonly frameWidth: string;
  readonly imageWidthPercent: number;
  readonly imageLeftPercent: number;
  readonly imageTopPercent: number;
}

/** Null when there is no rectangle to show, or it is the whole image. */
export function panoPreviewCrop(edges: PanoEdgesReport | null | undefined): PanoPreviewCrop | null {
  const rect = edges?.auto_crop.rect;
  if (!edges || !rect || rect.width <= 0 || rect.height <= 0) return null;
  const { width, height } = edges.output;
  const wholeImage = rect.width === width && rect.height === height;
  const insideImage =
    rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height;
  if (wholeImage || !insideImage) return null;
  return {
    ratio: rect.width / rect.height,
    frameWidth: `min(100%, calc(${PREVIEW_MAX_HEIGHT} * ${rect.width / rect.height}))`,
    imageWidthPercent: (width / rect.width) * 100,
    imageLeftPercent: -(rect.x / rect.width) * 100,
    imageTopPercent: -(rect.y / rect.height) * 100,
  };
}
