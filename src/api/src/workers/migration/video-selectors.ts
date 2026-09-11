/**
 * Shared Mongo selector fragments for video-scoped migrations.
 *
 * `media_kind: 'video'` (#3492) is what makes the candidate query cheap — an
 * equality the `media_kind_av` partial index serves, instead of a filename
 * regex a multikey index never filters (every such query used to fetch the
 * entire library). The `$elemMatch` keeps the regex ON THE SAME ENTRY as the
 * liveness checks: `media_kind` says a video location exists, not that it is
 * live, and a Live Photo backup whose `.mov` was soft-deleted (still `.heic`
 * live) must not be a candidate — a migration that matched it would queue
 * renders / reads of a missing video that can only fail, head-of-line
 * blocking every batch (#1519 class).
 */
import { VIDEO_EXTS } from '../../indexer/media-types.ts';

const VIDEO_FILENAME_REGEX = new RegExp(
  `\\.(${[...VIDEO_EXTS].map((e) => e.slice(1)).join('|')})$`,
  'i',
);

/** "Is a video AND that video location is live." Spread into a filter. */
export function liveVideoAssetFilter(): Record<string, unknown> {
  return {
    media_kind: 'video',
    fileinfo: {
      $elemMatch: {
        filename: { $regex: VIDEO_FILENAME_REGEX },
        deleted_at: { $in: [null] },
        missing_since: { $in: [null] },
      },
    },
  };
}
