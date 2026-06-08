/**
 * Pure path logic for the "restructure backup screenshots" migration.
 *
 * Screenshots are filed under a single `<year>/Screenshot` folder (see
 * `backup/path-formatter.ts`, which routes freshly-ingested screenshots there).
 * This migration relocates ALREADY-backed-up screenshots — identified by the
 * asset's `is_screenshot` flag (the EXIF filename seed, later refined by the
 * qwen2.5-vl describe stage) — out of their date/location folder and into
 * `<year>/Screenshot`.
 *
 * Splitting the path derivation out (mirrors `restructure-backup-geo.ts`'s
 * `computeGeoDir`) keeps it unit-testable with no DB or filesystem.
 */

import { SCREENSHOT_DIR_SEGMENT } from '../../backup/path-formatter.ts';
import type { AssetExif, FileInfo } from '../../db/schema.ts';

/** Matches the destination layout (`<year>/Screenshot`) exactly. Two jobs:
 *   - the idempotency gate inside `computeScreenshotDir`, and
 *   - the `$nor` exclusion in the migration's candidate query, so an
 *     already-filed screenshot drops out and `countRemaining()` reaches 0. */
export const SCREENSHOT_DIR_RE = new RegExp(`^\\d{4}/${SCREENSHOT_DIR_SEGMENT}$`);

/** A dated backup directory (`<year>/…`). Every path the backup formatter emits
 * starts with the 4-digit year, so this pre-filters candidates cheaply and
 * guarantees `computeScreenshotDir` can always read the year off the path.
 * Anchored, no lookahead — the "not already filed" half is a separate `$nor`. */
export const DATED_BACKUP_DIR_RE = /^\d{4}\//;

/** Year prefix for the new path. Prefer the year the file already lives under
 * (the leading path segment) so a screenshot is never moved across year
 * folders; fall back to the EXIF capture year only when the path lacks a
 * 4-digit lead. Mirrors the same rule in `restructure-backup-geo.ts`. */
function yearForPath(oldDir: string, capturedYear: number | null | undefined): string | null {
  const seg0 = oldDir.split('/')[0] ?? '';
  if (/^\d{4}$/.test(seg0)) return seg0;
  if (capturedYear != null && Number.isFinite(capturedYear)) {
    return String(Math.trunc(capturedYear)).padStart(4, '0');
  }
  return null;
}

/**
 * Target directory (`<year>/Screenshot`) for a screenshot asset, or `null` when
 * the year can't be determined (pathological — every backup path starts with
 * `<year>/`, and the candidate query already requires that). Returns the
 * asset's CURRENT dir when it is already `<year>/Screenshot`, so the move
 * collapses to a no-op. Exported for unit testing.
 */
export function computeScreenshotDir(doc: {
  fileinfo?: FileInfo[];
  exif?: { captured_year?: AssetExif['captured_year'] } | null;
}): string | null {
  const oldDir = doc.fileinfo?.[0]?.path;
  if (oldDir == null) return null;
  if (SCREENSHOT_DIR_RE.test(oldDir)) return oldDir; // already filed — no move
  const year = yearForPath(oldDir, doc.exif?.captured_year);
  if (!year) return null;
  return `${year}/${SCREENSHOT_DIR_SEGMENT}`;
}
