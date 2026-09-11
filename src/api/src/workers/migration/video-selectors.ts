/**
 * Shared Mongo selector fragments for video-scoped migrations.
 *
 * Selects on the denormalised `media_kind` (#3492) — an equality the
 * `media_kind_av` partial index serves — instead of a filename regex inside
 * `fileinfo.$elemMatch`, which a multikey index never filters (every such
 * candidate/count query used to fetch the entire library).
 */
import { liveFileInfoElemMatch } from '../../indexer/images.repo.ts';

/** "Is a video AND has ≥1 live on-disk location." Spread into a filter. */
export function liveVideoAssetFilter(): Record<string, unknown> {
  return { media_kind: 'video', ...liveFileInfoElemMatch() };
}
