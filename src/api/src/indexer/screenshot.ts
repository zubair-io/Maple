/**
 * Screenshot detection from a filename (and, where available, the EXIF camera
 * make). Shared by:
 *   - the EXIF enrichment stage (`workers/stages/exif.ts`), which seeds the
 *     asset's `is_screenshot` field, and
 *   - the backup-ingest route (`routes/backup-ingest.ts`), which routes an
 *     incoming screenshot into the `<year>/Screenshot` folder at upload time.
 *
 * Extracted into its own tiny module so the hot ingest route can reuse the
 * exact same heuristic without pulling in the EXIF stage's heavy `exifr`
 * dependency graph. Keeping ONE definition also guarantees the ingest-time
 * folder decision and the stage-time `is_screenshot` seed never drift.
 *
 * The describe stage later overwrites `is_screenshot` with the qwen2.5-vl
 * verdict (which handles cropped screenshots and photos-of-screens this
 * filename heuristic can't); the screenshot migration then re-files anything
 * the heuristic missed. So this is a fast first guess, not the last word.
 *
 * Videos are excluded outright: no video container is ever a screenshot,
 * whatever it is named, and whatever the VLM later thinks of its poster
 * frame (see `workers/stages/describe.ts`, which clamps its own verdict the
 * same way). `is_screenshot` is a stills-only concept (#2325).
 */

import * as path from 'node:path';
import { isVideoFilename } from './media-types.ts';

/** Filename patterns that almost always indicate a screenshot.
 *
 *   iOS:     "Screenshot 2026-05-19 at 10.04.32.png"
 *   macOS:   "Screen Shot 2024-12-01 at 1.23.45 PM.png"
 *   Android: "Screenshot_20240601_102030.png" / "Screenshot_2024-06-01.png"
 *
 * Anchored to start-of-name so a file someone explicitly named
 * "my-screenshot-of-X.png" doesn't get auto-categorised.
 */
export const SCREENSHOT_FILENAME_RE = /^(Screenshot[\s_-]|Screen[\s]Shot[\s])/i;

/** True when the file's basename matches a known screenshot naming pattern.
 * Pure filename test — used at backup ingest, where no EXIF has been parsed
 * yet so the only signal available is the name the device reported. */
export function isScreenshotFilename(filename: string): boolean {
  // `is_screenshot` is a stills-only concept (#2325) — a screen recording is
  // a video and belongs in the video bucket, not the Screenshots one. This
  // guard, not the camera-make check in `isLikelyScreenshot`, is what
  // actually protects video: every video container is in `NO_EXIF_EXTS`, so
  // exifr never returns a make and that branch is dead code for them.
  if (isVideoFilename(filename)) return false;
  return SCREENSHOT_FILENAME_RE.test(path.basename(filename));
}

/** Heuristic screenshot detection from filename + EXIF. Conservative
 * — only fires when the camera_make is empty AND the filename matches
 * a known screenshot pattern. False positives are worse than false
 * negatives because the describe stage will correct false negatives on
 * its next pass but a false positive sticks in the "Photos" view until
 * the operator manually clears it.
 *
 * Note the camera_make guard does nothing for video: video containers are
 * in `NO_EXIF_EXTS`, so exifr never returns a make for them. Video is kept
 * out by the extension check in `isScreenshotFilename` below, not by this.
 *
 * The describe stage overwrites this with the qwen2.5-vl verdict once
 * it runs, which handles cropped screenshots and photos-of-screens. */
export function isLikelyScreenshot(
  filename: string,
  cameraMake: string | null | undefined,
): boolean {
  if (cameraMake && cameraMake.trim().length > 0) return false;
  return isScreenshotFilename(filename);
}
