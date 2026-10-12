/**
 * One tile per shot in search results (#4557).
 *
 * A library holds distinct assets that are the same photograph: a RAW and the JPEG the camera
 * wrote beside it, a re-import that came back as `_MG_4066(2).jpg`, an export named
 * `_MG_5652-ultra-8.jpg`, the same video copied into two folders. They share no bytes, so the
 * byte-identical `deduplicate` stage never merges them, and a ranked search shows each of them.
 *
 * Two assets are the same shot when they were captured at the same moment and their filenames
 * name the same frame once the copy and export decorations are removed. Burst frames share a
 * capture second but not a frame number (`_MG_1768` and `_MG_1770`), so they stay apart.
 */

/** What the rule reads from a window row: the capture time and the canonical entry's filename. */
export interface ShotFields {
  captured_at: string | null;
  filename: string | null;
}

const COPY_MARKER = /\s*\(\d+\)$/;

/**
 * An export suffix starts at a hyphen followed by a letter (`-ultra-8`, `-Edit`, `-HDR`). A hyphen
 * followed by a digit is left alone: it is how date-style names separate their fields
 * (`2017-05-21 17.50.35`) and how some cameras number frames within one second (`…35-1`).
 */
const EXPORT_SUFFIX = /-[a-z].*$/;

function withoutCopyMarkers(stem: string): string {
  const stripped = stem.replace(COPY_MARKER, '');
  return stripped === stem ? stem : withoutCopyMarkers(stripped);
}

/**
 * The frame a filename names: its stem without the extension, any trailing `(n)` copy markers or
 * an export suffix, lower-cased.
 */
export function shotStem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const stem = (dot > 0 ? filename.slice(0, dot) : filename).trim().toLowerCase();
  const uncopied = withoutCopyMarkers(stem);
  const unexported = uncopied.replace(EXPORT_SUFFIX, '');
  return withoutCopyMarkers(unexported.length > 0 ? unexported : uncopied);
}

/** The shot a row belongs to, or null when the row lacks what the rule needs and stands alone. */
export function shotKey(row: ShotFields): string | null {
  if (row.captured_at === null || row.filename === null) return null;
  const stem = shotStem(row.filename);
  return stem.length > 0 ? `${row.captured_at}\u0000${stem}` : null;
}

/**
 * `rows` with every later copy of a shot dropped, so each shot keeps its best-ranked asset. Keeping
 * the first of each shot is prefix-stable: collapsing a deeper window of the same ranking yields
 * the shallower window's collapse followed by new rows, so pages already served stay put.
 */
export function collapseShots<T extends ShotFields>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = shotKey(row);
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
