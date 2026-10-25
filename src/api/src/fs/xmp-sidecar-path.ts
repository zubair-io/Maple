import * as path from 'node:path';
import { isVideoFilename } from '../indexer/media-types';

/**
 * Resolve the expected XMP sidecar path for a given raw/image/video file.
 *
 * Images use the classic stem-swap convention (`IMG_1.ARW` → `IMG_1.xmp`).
 * Videos KEEP their extension and append `.xmp` (`clip.mov` → `clip.mov.xmp`),
 * the industry-standard full-name convention. This is load-bearing for Apple
 * Live Photos, which store the still and the motion clip as two independent
 * same-stem assets (`IMG_1234.HEIC` + `IMG_1234.MOV`). Under stem-swap both
 * would resolve to `IMG_1234.xmp` and clobber each other; full-name for the
 * video gives it its own `IMG_1234.MOV.xmp` and leaves the photo's sidecar
 * untouched. Existing photo sidecars are NOT migrated — only video naming
 * changes.
 */
export function xmpSidecarPath(rawAbsPath: string): string {
  if (isVideoFilename(rawAbsPath)) return rawAbsPath + '.xmp';
  const ext = path.extname(rawAbsPath);
  return (ext ? rawAbsPath.slice(0, -ext.length) : rawAbsPath) + '.xmp';
}
