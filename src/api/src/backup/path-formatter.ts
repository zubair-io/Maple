/**
 * Compute the destination path for a backed-up asset, relative to the
 * library root. Mirrors src/apple/Packages/MapleBackup/Sources/MapleBackup/PathFormatter.swift
 * (a JSON-shaped parity pair — identical inputs must produce byte-identical
 * output on both sides).
 *
 * Layout:
 *   Screenshot:       <year>/Screenshot/<filename>   (takes precedence)
 *   With location:    <year>/<seg1>/<seg2>/…/<filename>
 *   Without location: <year>/Misc/<filename>
 *
 * A screenshot is filed under a single `<year>/Screenshot` folder regardless of
 * its GPS — a phone/app UI capture isn't a "place" photo, so the location and
 * month layouts don't apply. The caller decides `isScreenshot` (the backup
 * ingest route uses the shared filename heuristic in `indexer/screenshot.ts`);
 * the screenshot migration re-files existing screenshots into the same folder.
 *
 * `location` is an ordered list of geographic directory segments derived from
 * the reverse-geocoded place by `backupLocationSegments` (see
 * `location-segments.ts`):
 *   - USA:       ["<State>", "<Town/City || Place Name>"]   e.g. ["California", "San Francisco"]
 *   - elsewhere: ["<Country>", "<Town/City || Place Name>"] e.g. ["France", "Paris"]
 * Each segment is sanitised independently: trimmed, `/` and `\` replaced with
 * `_` (so one segment can't introduce an extra directory level), and dropped
 * entirely if it is empty or a path-traversal token (`.`, `..`, or a leading
 * dot). When no usable segment survives, the path falls back to the `<year>/Misc` layout.
 *
 * Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §9;
 * docs/superpowers/specs/2026-05-31-backup-layout-and-migration-worker.md;
 * docs/superpowers/specs/2026-06-05-backup-geo-layout.md (the State/Country split).
 */

/** Reject filenames that could escape the library root. Allow only a basename
 * with no path separators, no `..` segments, and no leading dot. */
export function isSafeFilename(name: string): boolean {
  if (!name || name.length === 0 || name.length > 255) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..') return false;
  if (name.startsWith('.')) return false;
  return true;
}

/**
 * Sanitise an ordered list of location segments into safe, single-level
 * directory names. Shared with the `refile-backups` cleanup migration
 * so a migrated file lands byte-for-byte where a fresh ingest of the same place
 * would write it.
 *
 * Per segment: trim; drop if empty/whitespace; replace `/` and `\` with `_`
 * (a stray separator must not add a directory level); drop path-traversal
 * tokens (`.`, `..`, or a leading dot — which would create a hidden folder).
 * Surviving segments keep their order.
 */
export function sanitizeLocationSegments(location: readonly string[] | null | undefined): string[] {
  if (!location) return [];
  const out: string[] = [];
  for (const raw of location) {
    if (raw == null) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const escaped = trimmed.replaceAll('/', '_').replaceAll('\\', '_');
    if (escaped === '.' || escaped === '..' || escaped.startsWith('.')) continue;
    out.push(escaped);
  }
  return out;
}

/**
 * The fixed directory segment screenshots are filed under, below the year.
 * A plain literal (no separators / traversal tokens) so it never needs
 * sanitising. Shared with the screenshot migration so a freshly-ingested
 * screenshot and a migrated one land in byte-identical folders.
 */
export const SCREENSHOT_DIR_SEGMENT = 'Screenshot';

export function formatBackupPath(args: {
  captureDate: Date;
  location: readonly string[] | null;
  filename: string;
  /** True when this asset is a screenshot — files it under `<year>/Screenshot`,
   * ignoring `location` and the month fallback. */
  isScreenshot?: boolean;
}): string {
  if (!isSafeFilename(args.filename)) {
    throw new Error(`unsafe filename: ${args.filename}`);
  }

  const y = args.captureDate.getUTCFullYear().toString().padStart(4, '0');

  // Screenshot wins over location and date — a UI capture isn't a place photo.
  if (args.isScreenshot) return `${y}/${SCREENSHOT_DIR_SEGMENT}/${args.filename}`;

  const segs = sanitizeLocationSegments(args.location);
  if (segs.length > 0) return `${y}/${segs.join('/')}/${args.filename}`;
  return `${y}/Misc/${args.filename}`;
}
