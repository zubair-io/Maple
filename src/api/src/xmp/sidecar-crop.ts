/**
 * The crop a sidecar records, for derivatives of bitmap originals (#5608):
 * a stitched panorama keeps its whole canvas and carries Auto Crop as the
 * standard crop fields, so thumbnails and previews must apply it.
 */

import { readFile } from '../fs/mirrored.ts';
import { xmpSidecarPath } from '../fs/xmp-sidecar-path.ts';
import { canonicalXmpName, descriptions, xmlSpans } from './transfer-document.ts';

interface NormalizedCrop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const EDGES = ['crs:CropLeft', 'crs:CropTop', 'crs:CropRight', 'crs:CropBottom'] as const;

/**
 * The axis-aligned crop of an XMP document, or null when it has none, it is
 * the whole frame, it is malformed, or it straightens (a rotated crop is not
 * applied to derivatives).
 */
export function parseSidecarCrop(xml: string): NormalizedCrop | null {
  const values = new Map<string, string>();
  for (const span of descriptions(xmlSpans(xml))) {
    for (const attribute of Object.values(span.tag.attributes)) {
      const name = canonicalXmpName(attribute.uri, attribute.local);
      if (name) values.set(name, attribute.value);
    }
  }
  if (values.get('crs:HasCrop') !== 'True') return null;
  if (Number(values.get('crs:CropAngle') ?? 0) !== 0) return null;
  const [left, top, right, bottom] = EDGES.map((edge) => Number(values.get(edge)));
  const valid =
    [left, top, right, bottom].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) &&
    right > left &&
    bottom > top;
  const whole = left === 0 && top === 0 && right === 1 && bottom === 1;
  return valid && !whole ? { left, top, right, bottom } : null;
}

/** The crop beside `imagePath`; null when there is no readable sidecar. */
export async function readSidecarCrop(imagePath: string): Promise<NormalizedCrop | null> {
  const xml = await readFile(xmpSidecarPath(imagePath), 'utf8').catch(() => null);
  if (xml === null) return null;
  try {
    return parseSidecarCrop(xml);
  } catch {
    return null;
  }
}

/** The pixel region of a `width` x `height` image, at least 1 px each way. */
export function cropRegion(
  crop: NormalizedCrop,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const left = Math.min(Math.round(crop.left * width), width - 1);
  const top = Math.min(Math.round(crop.top * height), height - 1);
  return {
    left,
    top,
    width: Math.max(1, Math.min(Math.round(crop.right * width), width) - left),
    height: Math.max(1, Math.min(Math.round(crop.bottom * height), height) - top),
  };
}
