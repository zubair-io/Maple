/**
 * Shared Mongo selector fragments for video-scoped migrations.
 *
 * `backfill-video-exif` and `rearm-video-posters` both need "assets with at
 * least one live on-disk video location," and both derived it from
 * `VIDEO_EXTS` the same way. Keeping two copies meant a new container added to
 * `media-types.ts` could silently reach one migration's candidate set and not
 * the other's — the exact drift the single-source-of-truth comment on
 * `VIDEO_EXTS` exists to prevent.
 */

import { VIDEO_EXTS } from '../../indexer/media-types.ts';

/**
 * Filename regex matching any known video extension, case-insensitively.
 *
 * Built from `VIDEO_EXTS` rather than hand-written so it can't drift from the
 * classification predicates. Mongo's `$regex` has no access to
 * `path.extname`, which is why the selector needs a pattern at all instead of
 * reusing `isVideoFilename`.
 *
 * Module-private: callers want the `$elemMatch` clause below, not a raw
 * pattern to assemble themselves — exporting both would invite a third
 * hand-rolled selector, which is the drift this module exists to end.
 */
const VIDEO_FILENAME_REGEX = new RegExp(
  `\\.(${[...VIDEO_EXTS].map((e) => e.slice(1)).join('|')})$`,
  'i',
);

/**
 * `$elemMatch` clause selecting a fileinfo entry that is a video AND still
 * live — neither soft-deleted nor tombstoned as missing.
 *
 * The liveness half matters: a migration that matched soft-deleted entries
 * would keep re-processing assets whose files are gone, and for the poster
 * re-arm would queue renders that can only fail.
 */
export function liveVideoFileinfoMatch(): Record<string, unknown> {
  return {
    filename: { $regex: VIDEO_FILENAME_REGEX },
    deleted_at: { $in: [null] },
    missing_since: { $in: [null] },
  };
}
