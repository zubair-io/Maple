/**
 * Pure path-transform for the "restructure backup folders" migration (#744).
 *
 * The backup path formatters (`backup/path-formatter.ts`,
 * `MapleBackup/PathFormatter.swift`) only ever produce:
 *   - a 3-segment directory for the OLD layout
 *       `<year>/<loc>/<MM>-<DD>`   (with location)
 *       `<year>/<MM>/<DD>`         (no location)
 *   - a 2-segment directory for the NEW layout
 *       `<year>/<loc>`             (with location)
 *       `<year>/<MM>`              (no location)
 *
 * So the migration is "if this is a recognized 3-segment old-layout dir, drop
 * the 3rd segment". Gating on exactly-3-segments makes it idempotent and safe:
 * a new-layout path is 2 segments and is left untouched — including the nasty
 * case of a location literally named like a date (`2024/12-25/IMG.HEIC`), which
 * is 2 segments and therefore already migrated.
 *
 * `dir` is the POSIX-separated directory component (the stored
 * `FileInfo.path`), never including the filename, `''` for the library root.
 */

/** Matches an OLD-layout 3-segment directory. Used to pre-filter candidates in
 * the Mongo count/find query; `restructureDir` is the precise gate. */
export const OLD_LAYOUT_DIR_RE = /^\d{4}\/(?:[^/]+\/\d{2}-\d{2}|\d{2}\/\d{2})$/;

/**
 * Return the new (flattened) directory for an old-layout backup dir, or `null`
 * when `dir` is not a recognized old-layout dir (already migrated, or not a
 * backup date-folder at all) and must be left untouched.
 */
export function restructureDir(dir: string): string | null {
  if (!dir) return null;
  const segs = dir.split('/');
  // 2 segments → already new layout. Other lengths → not a backup date-folder.
  if (segs.length !== 3) return null;
  const [year, mid, last] = segs;
  if (!/^\d{4}$/.test(year)) return null;
  const withLocation = /^\d{2}-\d{2}$/.test(last); // <year>/<loc>/<MM>-<DD>
  const noLocation = /^\d{2}$/.test(mid) && /^\d{2}$/.test(last); // <year>/<MM>/<DD>
  if (!withLocation && !noLocation) return null;
  // In both shapes the new dir is the first two segments (drop the day).
  return `${year}/${mid}`;
}
