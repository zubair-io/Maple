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
 */

import * as path from 'node:path';

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
  return SCREENSHOT_FILENAME_RE.test(path.basename(filename));
}

/** Heuristic screenshot detection from filename + EXIF. Conservative
 * — only fires when the camera_make is empty AND the filename matches
 * a known screenshot pattern. False positives are worse than false
 * negatives because the describe stage will correct false negatives on
 * its next pass but a false positive sticks in the "Photos" view until
 * the operator manually clears it.
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
