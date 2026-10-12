/**
 * One tile per shot in search results (#4557).
 *
 * A library holds distinct assets that are the same photograph: a RAW and the JPEG the camera
 * wrote beside it, a re-import that came back as `_MG_4066(2).jpg`, an export named
 * `_MG_5652-ultra-8.jpg`, the same video copied into two folders. They share no bytes, so the
 * byte-identical `deduplicate` stage never merges them, and a ranked search shows each of them.
 *
 * Two assets are the same shot when they belong to the same owner, were captured in the same
 * second, are the same kind of media, and their filenames name the same frame once the copy and export decorations are
 * removed. Burst frames share a capture second but not a frame number (`_MG_1768` and `_MG_1770`),
 * and a Live Photo's still and its motion clip share both but not a media kind, so they stay apart.
 * Two people's `IMG_0001.JPG` taken in the same second are two photographs, so owners never mix.
 */

/**
 * What the rule reads from a window row: capture time, media kind and the filename of the asset's
 * first live location. The name belongs to the asset, not to whichever location a scoped request
 * reached it through: an asset is one tile however many folders hold its bytes.
 */
export interface ShotFields {
  owner_id?: string | null;
  captured_at: string | null;
  media_kind: string;
  filename: string | null;
}

const COPY_MARKERS = /(\s*\(\d+\))+$/;

/**
 * An export suffix decorates a camera's frame name: the whole stem is a short camera prefix and a
 * frame number (`_MG_5652`, `IMG_1234`, `DSCF0042`, `20170521_175035`), then a hyphen, a letter, and
 * nothing that looks like another frame number (`-ultra-8`, `-Edit`). Anything else is left alone:
 * a hyphen followed by a digit separates a date's fields (`2017-05-21 17.50.35`) or numbers frames
 * within one second (`…35-1`), and a name that is not a bare frame name — `wedding-kiss-01`,
 * `holiday2024-beach`, `2024-wedding-IMG_1234` — is the photographer's own, so two such names are
 * two shots.
 */
const EXPORT_SUFFIX = /^(_?[a-z]{0,4}_?\d[\d_]*)(?:\s*\(\d+\))*-[a-z](?:(?!\d{3}).)*$/;

/**
 * `captured_at` is written by `toISOString()` (`indexer/exif.ts`), so its first 19 characters are
 * the second a shot was taken in. A shorter value carries no second and never matches another.
 */
const CAPTURE_SECOND_LENGTH = 'YYYY-MM-DDTHH:MM:SS'.length;

/**
 * The frame a filename names: its stem without the extension, any trailing `(n)` copy markers or
 * an export suffix, lower-cased.
 */
export function shotStem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const stem = (dot > 0 ? filename.slice(0, dot) : filename).trim().toLowerCase();
  return stem.replace(COPY_MARKERS, '').replace(EXPORT_SUFFIX, '$1').replace(COPY_MARKERS, '');
}

/** The shot a row belongs to, or null when the row lacks what the rule needs and stands alone. */
export function shotKey(row: ShotFields): string | null {
  if (row.captured_at === null || row.filename === null) return null;
  if (row.captured_at.length < CAPTURE_SECOND_LENGTH) return null;
  const stem = shotStem(row.filename);
  const second = row.captured_at.slice(0, CAPTURE_SECOND_LENGTH);
  return stem.length > 0 ? [row.owner_id ?? '', second, row.media_kind, stem].join('\u0000') : null;
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
