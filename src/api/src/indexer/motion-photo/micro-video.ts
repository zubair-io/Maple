import type { ByteSource } from './byte-source.ts';
import { startsWithFtyp } from './iso-bmff.ts';
import { still, type MotionDetection, type StillKind } from './types.ts';
import { integerField, type MotionXmp } from './xmp-fields.ts';

/**
 * Legacy Pixel `MicroVideo` (the `MVIMG_` era): the clip is the last
 * `MicroVideoOffset` bytes of a JPEG. That offset outlives edits that strip
 * the clip, so the range is promoted only when an `ftyp` box really sits there.
 */
export async function detectMicroVideo(
  source: ByteSource,
  kind: StillKind,
  xmp: MotionXmp | null,
): Promise<MotionDetection> {
  const camera = xmp?.camera;
  if (camera?.get('MicroVideo')?.trim() !== '1') return still('no Motion Photo metadata');
  if (kind !== 'jpeg') return still('MicroVideo requires a JPEG still');
  const version = camera.get('MicroVideoVersion');
  if (version !== undefined && integerField(version, false) !== 1) {
    return still('MicroVideoVersion is not 1');
  }
  const length = integerField(camera.get('MicroVideoOffset'), true);
  if (length === null || length === 0 || length >= source.size) {
    return still('MicroVideoOffset is missing or outside the file');
  }
  const start = source.size - length;
  return (await startsWithFtyp(source, start, length))
    ? { motion: { start, length, mime: 'video/mp4' } }
    : still('MicroVideoOffset does not point at an ftyp box');
}
